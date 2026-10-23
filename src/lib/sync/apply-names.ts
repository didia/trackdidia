import type { Database } from "../storage/sqlite-db";
import type { RawRow } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import type { MetaRow } from "./capture-stamp";
import type { StagedEntity } from "./apply-gtd";
import type { SyncEntity } from "./change-set";
import { type ExtraConflict, nameCollisionId } from "./conflicts";
import { getOwn, setOwn } from "./field-clocks";
import { type EntityMeta, sameMeta } from "./merge-entity";
import { parseClocks } from "./capture-stamp";

/**
 * `gtd_contexts.name` is a natural key, but not one the alias engine merges: context ids are already
 * deterministic (`context:<slug>`), so two ids for one name only arise when somebody RENAMED a context
 * onto a name another context holds (or created one with a different slug). The mobile spec's answer
 * is a prompt, and this build records the prompt without deciding it:
 *
 * - a rename (an update that would set `name` to a name another context has) keeps the LOCAL name and
 *   the local clock of the `name` field, so the replica still says what it said; every other field of
 *   the update is applied;
 * - a context that would have to be inserted with a taken name is not inserted; its tasks keep
 *   naming it (a soft reference);
 * - either way an UNRESOLVED `name_collision` conflict with a deterministic id (so applying again, or
 *   another replica meeting the same pair, logs it once) says who holds the name; the bundle is never
 *   aborted for it.
 *
 * Until the user settles it the two replicas keep different names; that is the one divergence canonical
 * identity leaves on purpose (documented in `docs/storage-and-backups.md`).
 */

export const CONTEXTS = "gtd_contexts";

export const keepLocalNameOnCollision = async (
  db: Database,
  entry: StagedEntity,
  remote: SyncEntity,
  local: { row: RawRow | null; meta: MetaRow | undefined },
): Promise<ExtraConflict | null> => {
  const outcome = entry.outcome;
  if (outcome.rowAction !== "insert" && outcome.rowAction !== "update") return null;
  if (!Object.hasOwn(outcome.columns, "name")) return null;
  const name = String(outcome.columns.name);
  const holder = (
    await db.select<{ id: string }[]>(
      `SELECT id FROM ${quoteIdent(CONTEXTS)} WHERE name = $1 AND id <> $2`,
      [name, entry.entityId],
    )
  )[0];
  if (holder === undefined) return null;

  const conflict: ExtraConflict = {
    id: nameCollisionId(CONTEXTS, entry.entityId, name),
    kind: "name_collision",
    entityType: CONTEXTS,
    entityId: entry.entityId,
    local: { holder: holder.id, name },
    remote: { id: entry.entityId, name, rowHlc: remote.rowHlc },
  };

  if (outcome.rowAction === "insert") {
    const localMeta: EntityMeta | null = local.meta
      ? {
          fieldClocks: parseClocks(local.meta.field_clocks_json),
          rowHlc: local.meta.row_hlc,
          deletedAt: local.meta.deleted_at,
        }
      : null;
    entry.outcome = {
      rowAction: "none",
      columns: {},
      meta: localMeta ?? { fieldClocks: {}, rowHlc: remote.rowHlc, deletedAt: null },
      metaChanged: false,
      tombstoneApplied: false,
      overwritten: [],
    };
    return conflict;
  }

  // An update: keep the local name and the clock that goes with it.
  const columns = { ...outcome.columns };
  delete columns.name;
  const fieldClocks = { ...outcome.meta.fieldClocks };
  const localClock = local.meta
    ? getOwn(parseClocks(local.meta.field_clocks_json), "name")
    : undefined;
  if (localClock === undefined) delete fieldClocks.name;
  else setOwn(fieldClocks, "name", localClock);
  const meta: EntityMeta = { ...outcome.meta, fieldClocks };
  const localMeta: EntityMeta | null = local.meta
    ? {
        fieldClocks: parseClocks(local.meta.field_clocks_json),
        rowHlc: local.meta.row_hlc,
        deletedAt: local.meta.deleted_at,
      }
    : null;
  entry.outcome = {
    ...outcome,
    columns,
    rowAction: Object.keys(columns).length > 0 ? "update" : "none",
    meta,
    metaChanged: !sameMeta(localMeta, meta),
    overwritten: outcome.overwritten.filter((field) => field.field !== "name"),
  };
  return conflict;
};
