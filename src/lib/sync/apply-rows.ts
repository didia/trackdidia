import type { Database } from "../storage/sqlite-db";
import { buildEntityCodec, contentHash, type RawRow, type RowCodec } from "./capture-decode";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  fetchRows,
  fetchSnapshots,
  placeholders,
  writeOutcome,
} from "./capture-stamp";
import type { SyncEntity } from "./change-set";
import { type ExtraConflict, orphanedChildId } from "./conflicts";
import { parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { SyncApplyError } from "./errors";
import { canonicalJson } from "./field-clocks";
import { demoteStored, expireIncoming, resolvePendingKeys } from "./apply-proposals";
import type { ReferenceGuard } from "./apply-references";
import {
  extraConflictOf,
  messageOf,
  type PendingConflict,
  rowsById,
  toSqlApplyError,
  type Totals,
  writeRow,
} from "./apply-support";
import { competingAnchors, dropAnchors, readLocalDeviceId } from "./apply-finance";
import {
  compareAnchors,
  FINANCE_SNAPSHOTS,
  GENERIC_ROW_RULES,
  isTerminalSuggestionStatus,
  SNAPSHOT_RULES,
  SUGGESTION_RULES,
} from "./merge-finance";
import { isTerminalProposalStatus, PROPOSAL_RULES } from "./merge-proposal";
import { SEGMENT_RULES, SESSION_RULES } from "./merge-pomodoro";
import { mergeRowEntity, type RowMergeOutcome, type RowRules } from "./merge-row";
import { type RowClockRule, rowClockRuleOf } from "./merge-strategies";
import { isTerminalSessionStatus } from "./row-filter";
import { readTableInfo } from "./table-info";
import { overwrittenConflictId } from "./merge-entity";

/**
 * Applying the row-clock tables this build merges: the two Pomodoro tables, `ai_proposals`, the
 * finance tables (category suggestions, statement snapshots, and every plain finance row) and
 * `ai_memories`. The transactions and their splits are applied together by `apply-finance.ts`.
 * The pure rules live in `merge-row.ts` (+ `merge-pomodoro.ts`, `merge-proposal.ts`,
 * `merge-finance.ts`); this module
 * reads the local state, enforces what only the database can decide, writes, and keeps the meta
 * and the snapshot exactly as the stamper would (`content_hash` of the decoded row, `{}` clocks), so
 * the verifying scan restamps nothing.
 *
 * What only the database can decide:
 * - Pomodoro: a LOCAL running or paused session is never touched. An incoming terminal session with
 *   the id of one, a segment of one, or a delete of either aborts the bundle (`local_timer_conflict`)
 *   instead of corrupting the timer; honest peers cannot send these. A segment must belong to a
 *   terminal session that exists here (`row_filter_violation` otherwise).
 * - Foreign keys (`ai_proposals.message_id`): a proposal whose message is not here yet is skipped
 *   with an `orphaned_child` conflict, nothing written, so the bundle that brings the message lets it
 *   apply; the bundle is never aborted for it. A message is never deleted, so a parent is never gone.
 * - Pending proposals / suggestions that claim one natural key: `apply-proposals.ts`.
 * - Statement balance snapshots: at most one standing anchor per account (`apply-finance.ts`).
 * - Finance rows have no foreign keys: a suggestion whose transaction has not arrived yet is stored
 *   as it is (a soft reference), exactly like every other finance row that names a missing id.
 */

/** The transactions and their splits are applied together by `apply-finance.ts`, never here. */
type OwnRule = Exclude<RowClockRule, "finance-transaction" | "finance-split">;

const RULES: Readonly<Record<OwnRule, RowRules>> = {
  "pomodoro-session": SESSION_RULES,
  "pomodoro-segment": SEGMENT_RULES,
  "ai-proposal": PROPOSAL_RULES,
  "generic-row": GENERIC_ROW_RULES,
  "finance-suggestion": SUGGESTION_RULES,
  "finance-balance-snapshot": SNAPSHOT_RULES,
};

/** Rules whose pending rows claim a natural key (one pending row per key). */
const hasPendingKey = (rule: OwnRule): boolean =>
  rule === "ai-proposal" || rule === "finance-suggestion";

const CHUNK = 100;

const sessionStatuses = async (
  db: Database,
  ids: readonly string[],
): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  for (const batch of chunked(ids)) {
    if (batch.length === 0) continue;
    const rows = await db.select<{ id: string; status: string }[]>(
      `SELECT id, status FROM pomodoro_sessions WHERE id IN (${placeholders(batch.length)})`,
      batch,
    );
    for (const row of rows) found.set(row.id, row.status);
  }
  return found;
};

const timerConflict = (table: string, entityId: string, what: string): SyncApplyError =>
  new SyncApplyError(
    "local_timer_conflict",
    `${what} ${entityId} would change a Pomodoro timer that is running or paused on this laptop; the whole bundle is refused`,
    { table, entityId },
  );

/**
 * Pomodoro checks that need the database; see the module comment. Returns the ids of the segments
 * to skip: a segment of a session this laptop has deleted (the bundle carries the session, but the
 * local delete is later, so no row exists) has no parent to hang on, and one laptop's delete must
 * not make every later bundle from the other laptop fail.
 */
const checkPomodoro = async (
  db: Database,
  rule: OwnRule,
  table: string,
  batch: readonly SyncEntity[],
  localRows: Map<string, RawRow>,
  bundleSessionIds: ReadonlySet<string>,
): Promise<Set<string>> => {
  const skip = new Set<string>();
  if (rule === "pomodoro-session") {
    for (const entity of batch) {
      const local = localRows.get(entity.entityId);
      if (local !== undefined && !isTerminalSessionStatus(local.status)) {
        throw timerConflict(table, entity.entityId, "Session");
      }
    }
    return skip;
  }
  if (rule !== "pomodoro-segment") return skip;
  const sessionIds = new Set<string>();
  for (const entity of batch) {
    if (entity.row !== null) sessionIds.add(String(entity.row.session_id));
    const local = localRows.get(entity.entityId);
    if (local !== undefined) sessionIds.add(String(local.session_id));
  }
  const statuses = await sessionStatuses(db, [...sessionIds]);
  for (const entity of batch) {
    const local = localRows.get(entity.entityId);
    if (local !== undefined) {
      const status = statuses.get(String(local.session_id));
      if (status !== undefined && !isTerminalSessionStatus(status)) {
        throw timerConflict(table, entity.entityId, "Segment");
      }
    }
    if (entity.row === null) continue;
    const status = statuses.get(String(entity.row.session_id));
    if (status === undefined && bundleSessionIds.has(String(entity.row.session_id))) {
      skip.add(entity.entityId);
      continue;
    }
    if (status === undefined) {
      throw new SyncApplyError(
        "row_filter_violation",
        `Segment ${entity.entityId} belongs to session ${String(entity.row.session_id)}, which is not a terminal session known here; the whole bundle is refused`,
        { table, entityId: entity.entityId },
      );
    }
    if (!isTerminalSessionStatus(status)) {
      throw timerConflict(table, entity.entityId, "Segment");
    }
  }
  return skip;
};

const overwrittenConflict = (
  table: string,
  entityId: string,
  merged: RowMergeOutcome,
): PendingConflict[] =>
  merged.overwritten.map((field) => ({
    id: overwrittenConflictId(table, entityId, field.field, field.local.clock, field.remote.clock),
    kind: "overwritten_edit",
    entityType: table,
    entityId,
    localJson: canonicalJson({ [field.field]: field.local }),
    remoteJson: canonicalJson({ [field.field]: field.remote }),
  }));

/**
 * Proposals: decided (terminal) ones first, then deletes, then pending ones, each by id. A pending
 * proposal is checked against the pending slot of its key, so it must see the stored rows AFTER the
 * bundle's own decisions (a replica holding P1 pending that receives {P1 accepted, P2 pending} must
 * not expire P2 against a P1 that is about to stop being pending). Other tables keep id order.
 */
const orderForApply = (rule: OwnRule, entities: readonly SyncEntity[]): SyncEntity[] => {
  if (!hasPendingKey(rule)) return [...entities];
  const isTerminal = rule === "ai-proposal" ? isTerminalProposalStatus : isTerminalSuggestionStatus;
  const rank = (entity: SyncEntity): number =>
    entity.row === null ? 1 : isTerminal(entity.row.status) ? 0 : 2;
  return [...entities].sort(
    (a, b) => rank(a) - rank(b) || (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
  );
};

export const applyRowClockTable = async (
  db: Database,
  table: string,
  entities: readonly SyncEntity[],
  totals: Totals,
  conflicts: PendingConflict[],
  guard: ReferenceGuard,
  bundleSessionIds: ReadonlySet<string>,
): Promise<void> => {
  const rule = rowClockRuleOf(table);
  if (rule === undefined || rule === "finance-transaction" || rule === "finance-split") {
    throw new SyncApplyError(
      "unsupported_merge_class",
      `"${table}" has no row-clock rule in this applier`,
      { table },
    );
  }
  const info = await readTableInfo(db, table);
  const codec = buildEntityCodec(table, info.columns);
  if (codec.kind !== "row") {
    throw new SyncApplyError("unsupported_merge_class", `"${table}" has no row codec`, { table });
  }
  const rules = RULES[rule];
  const localDeviceId = await readLocalDeviceId(db);
  // Pending rows look at rows an earlier pending row of the same batch wrote or expired, so these
  // tables are applied one entity at a time, reading the database again for each.
  const size = hasPendingKey(rule) ? 1 : CHUNK;

  for (const batch of chunked(orderForApply(rule, entities), size)) {
    const keys = batch.map((entity) => parseEntityId(table, entity.entityId) as PrimaryKeyValue[]);
    const rows = rowsById(table, info, await fetchRows(db, table, info.primaryKey, keys));
    const metas = await fetchMeta(
      db,
      table,
      batch.map((entity) => entity.entityId),
    );
    const skip =
      rule === "pomodoro-session" || rule === "pomodoro-segment"
        ? await checkPomodoro(db, rule, table, batch, rows, bundleSessionIds)
        : new Set<string>();

    const outcome = emptyOutcome();
    const written: { entityId: string; key: PrimaryKeyValue[]; tombstone: boolean }[] = [];
    for (const entity of batch) {
      if (skip.has(entity.entityId)) {
        totals.skipped += 1;
        conflicts.push(extraConflictOf(orphanedConflict(table, entity, true)));
        continue;
      }
      const key = parseEntityId(table, entity.entityId) as PrimaryKeyValue[];
      const meta = metas.get(entity.entityId);
      let merged: RowMergeOutcome;
      try {
        merged = mergeRowEntity({
          columns: info.columns,
          local: {
            row: rows.get(entity.entityId) ?? null,
            meta: meta
              ? {
                  fieldClocks: {},
                  rowHlc: meta.row_hlc,
                  deletedAt: meta.deleted_at,
                }
              : null,
          },
          remote: entity,
          rules,
          localDeviceId,
        });
      } catch (error) {
        throw new SyncApplyError(
          "merge_failed",
          `Could not merge ${table} ${entity.entityId}: ${messageOf(error)}`,
          { table, entityId: entity.entityId, cause: error },
        );
      }

      // A child whose parent is not here (or is gone) is not inserted: it would violate the key.
      if (merged.rowAction === "insert" && merged.finalRow !== null) {
        const status = await guard.statusOf(table, merged.finalRow);
        if (status.state !== "present") {
          totals.skipped += 1;
          conflicts.push(extraConflictOf(orphanedConflict(table, entity, status.state === "gone")));
          continue;
        }
      }

      // One standing statement anchor per account: an incoming anchor that an older-or-equal local
      // one does not beat replaces it; one a local anchor beats is not stored at all.
      let superseded: Awaited<ReturnType<typeof competingAnchors>> = [];
      if (
        table === FINANCE_SNAPSHOTS &&
        merged.finalRow !== null &&
        merged.meta.deletedAt === null
      ) {
        const others = await competingAnchors(
          db,
          String(merged.finalRow.account_id),
          entity.entityId,
        );
        const self = { clock: merged.meta.rowHlc, asOfDate: String(merged.finalRow.as_of_date) };
        if (others.some((other) => compareAnchors(other, self) > 0)) {
          totals.skipped += 1;
          continue;
        }
        superseded = others;
      }

      let demote: { id: string; row: RawRow }[] = [];
      if (hasPendingKey(rule)) {
        const pending = await resolvePendingKeys(db, table, info, merged, entity.entityId);
        if (pending.expireIncoming) expireIncoming(merged);
        demote = pending.demote;
        for (const conflict of pending.conflicts) conflicts.push(extraConflictOf(conflict));
      }

      try {
        await demoteStored(db, table, info, codec, demote);
        await writeRow(db, table, info, key, merged);
      } catch (error) {
        throw await toSqlApplyError(db, table, entity.entityId, error);
      }
      const droppedAnchors = await dropAnchors(db, superseded);
      totals.applied += droppedAnchors;

      if (merged.metaChanged) {
        outcome.metaWrites.push({
          entityId: entity.entityId,
          fieldClocksJson: "{}",
          rowHlc: merged.meta.rowHlc,
          deletedAt: merged.meta.deletedAt,
        });
      }
      if (merged.rowAction !== "none" || merged.metaChanged || demote.length > 0) {
        totals.applied += 1;
      } else {
        totals.skipped += 1;
      }
      if (merged.tombstoneApplied) totals.tombstonesApplied += 1;
      conflicts.push(...overwrittenConflict(table, entity.entityId, merged));
      for (const conflict of merged.conflicts) conflicts.push(extraConflictOf(conflict));
      written.push({
        entityId: entity.entityId,
        key,
        tombstone: merged.meta.deletedAt !== null,
      });
    }

    // The snapshot is the hash of the row as the stamper decodes it, read back after the writes.
    const final = rowsById(
      table,
      info,
      await fetchRows(
        db,
        table,
        info.primaryKey,
        written.map((entry) => entry.key),
      ),
    );
    const snapshots = await fetchSnapshots(
      db,
      table,
      written.map((entry) => entry.entityId),
    );
    for (const entry of written) {
      const snapshot = snapshots.get(entry.entityId);
      const row = final.get(entry.entityId);
      if (entry.tombstone || row === undefined) {
        if (snapshot) outcome.snapshotDeletes.push(entry.entityId);
        continue;
      }
      const hash = contentHash((codec as RowCodec).decode(row));
      if (snapshot?.content_hash !== hash) {
        outcome.snapshotWrites.push({
          entityId: entry.entityId,
          snapshotJson: null,
          contentHash: hash,
        });
      }
    }
    await writeOutcome(db, table, outcome);
  }
};

const orphanedConflict = (table: string, entity: SyncEntity, gone: boolean): ExtraConflict => ({
  id: orphanedChildId(table, entity.entityId),
  kind: "orphaned_child",
  entityType: table,
  entityId: entity.entityId,
  local: { parent: gone ? "deleted" : "unknown" },
  remote: entity.row,
});
