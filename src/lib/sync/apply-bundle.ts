import type { AppSettings } from "../../domain/types/settings";
import type { Database } from "../storage/sqlite-db";
import { orderByReferences, type ParentStatus, ReferenceGuard } from "./apply-references";
import { applyRecurrenceSidecars } from "./apply-recurrence";
import { applyRowClockTable } from "./apply-rows";
import {
  extraConflictOf,
  messageOf,
  type PendingConflict,
  rowsById,
  toSqlApplyError,
  type Totals,
  writeRow,
} from "./apply-support";
import {
  type GtdApplyState,
  loadGtdApplyState,
  mergeTaskBatch,
  mergeTemplateBatch,
  type StagedEntity,
  touchedTemplatesOf,
} from "./apply-gtd";
import { buildEntityCodec, type FieldCodec, type RawRow } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  fetchRows,
  fetchSnapshots,
  parseClocks,
  placeholders,
  stampDirtyEntities,
  writeOutcome,
} from "./capture-stamp";
import { assertRemoteClockAcceptable, absorbRemoteHlc, SyncClockError } from "./clock-store";
import {
  type SyncApplyResult,
  type SyncChangeSet,
  type SyncEntity,
  type SyncRow,
  validateChangeSet,
} from "./change-set";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { SyncApplyError } from "./errors";
import { canonicalJson, getOwn, setOwn } from "./field-clocks";
import {
  type EntityMergeOutcome,
  type EntityMeta,
  mergeFieldClockEntity,
  mergeSettingEntry,
  type OverwrittenField,
  overwrittenConflictId,
} from "./merge-entity";
import { fieldClockRuleOf, strategyForTable, tableOrder } from "./merge-strategies";
import { type ExtraConflict, orphanedChildId } from "./conflicts";
import { assertEntitiesPublishable } from "./row-filter";
import {
  assertSettingPublishable,
  getTableRegistration,
  SETTING_ENTITY_TYPE,
  type SyncDomain,
  settingRule,
} from "./registry";
import { readTableInfo, type TableInfo } from "./table-info";

/**
 * Applying a change set to the local database: the write side of multi-device sync.
 *
 * Everything here takes an OPEN write transaction's `Database` and never touches the repository's
 * writer queue (`applySyncBundle` in `TauriSqliteRepository` wraps the call in `writeTransaction`).
 * Re-entering the queue from here would deadlock behind the 15-second watchdog.
 *
 * The safety properties, in the order they are established:
 * 1. Before anything else: schema gate, then the HLC check (pure, in `prepareApply`, before the
 *    transaction is even opened).
 * 2. Local capture marks are DRAINED (`stampDirtyEntities`) before `applying` is raised. A pending
 *    local edit is therefore stamped with a local clock and its own content first, and then
 *    competes with the remote value on equal terms. Without this the leftover mark would be
 *    stamped after the merge with a fresh clock and the REMOTE content (ping-pong), and the local
 *    edit would vanish unstamped. See the note above `WHEN_CAPTURING` in `capture-install.ts`.
 * 3. The bundle's `hlcHigh` is folded into the local clock, so every clock issued afterwards is
 *    causally after everything applied.
 * 4. `sync_identity.applying = 1` for the rest of the transaction: the capture triggers stay quiet,
 *    so a merge-applied write leaves no `sync_dirty` mark, stamps no local clock and does not bump
 *    `change_counter`. It is reset to 0 before COMMIT on success; on failure the transaction rolls
 *    the flag back with everything else (a best-effort reset also runs, in case the rollback
 *    itself fails).
 * 5. Every applied row also gets its `sync_entity_snapshot` (the row as the capture decoder reads it
 *    back from the database) and its `sync_entity_meta`, so the next local edit diffs against the
 *    merged state and only changed fields get new clocks.
 *
 * Why a generic SQL upsert and not the repository's `persist*` / `save*Internal` helpers: those take
 * domain objects, normalize and default them, may stamp `updated_at`, emit task events and reconcile
 * projects. A merge must store exactly the merged columns, byte for byte, and must not run domain
 * side effects, so it writes the merged raw columns with statements built from `pragma_table_info`
 * (only columns that exist here, the primary key never changed). JSON columns keep the repository's
 * format (compact JSON text); the per-key and per-element columns only add key sorting.
 */

export interface SyncSettingsAccess {
  /** The stored settings, normalized (defaults filled in). */
  read(db: Database): Promise<AppSettings>;
  /** Persists through the repository's settings writer; returns what was stored. */
  write(db: Database, settings: AppSettings): Promise<AppSettings>;
}

export interface ApplyContext {
  nowMs: number;
  settings: SyncSettingsAccess;
}

const OVERWRITTEN_EDIT = "overwritten_edit";
const INSERT_PARAM_BUDGET = 500;

// ---------------------------------------------------------------------------------------------
// Pure preparation (before any transaction)
// ---------------------------------------------------------------------------------------------

/**
 * Validates everything that can be decided without the database, so a bad bundle is refused before
 * it takes a writer slot: shape and clocks (`validateChangeSet`), the domain, tables this build
 * cannot merge, and the 24-hour clock guard. Returns the validated change set.
 */
export const prepareApply = (domain: SyncDomain, input: unknown, nowMs: number): SyncChangeSet => {
  const changeSet = validateChangeSet(input);
  if (changeSet.domain !== domain) {
    throw new SyncApplyError(
      "domain_mismatch",
      `The change set is for the "${changeSet.domain}" domain but "${domain}" was requested`,
    );
  }
  for (const entity of changeSet.entities) {
    assertSupported(entity.table, ["field-clock", "row-clock"]);
  }
  for (const table of Object.keys(changeSet.unionRows)) {
    assertSupported(table, ["grow-only-union"]);
  }
  // A row its table never publishes (a running Pomodoro session) is never applied, not even
  // partially: checked here, before a writer slot is taken.
  assertEntitiesPublishable(changeSet.entities, "apply");
  assertRemoteClockAcceptable(changeSet.hlcHigh, nowMs);
  return changeSet;
};

const assertSupported = (
  table: string,
  kinds: readonly ("field-clock" | "row-clock" | "grow-only-union")[],
): void => {
  const strategy = strategyForTable(table);
  if (strategy === null || !kinds.includes(strategy.kind)) {
    const registration = getTableRegistration(table);
    throw new SyncApplyError(
      "unsupported_merge_class",
      `This version cannot merge "${table}" (merge class ${registration.mergeClass}); the whole bundle is refused`,
      { table },
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Field-clock entities
// ---------------------------------------------------------------------------------------------

const conflictOf = (table: string, entityId: string, field: OverwrittenField): PendingConflict => ({
  id: overwrittenConflictId(table, entityId, field.field, field.local.clock, field.remote.clock),
  kind: OVERWRITTEN_EDIT,
  entityType: table,
  entityId,
  localJson: canonicalJson(setOwn({}, field.field, field.local)),
  remoteJson: canonicalJson(setOwn({}, field.field, field.remote)),
});

/** A no-op outcome: nothing is written for an entity that cannot be applied yet. */
const skippedOutcome = (
  local: { row: RawRow | null; meta: EntityMeta | null },
  remote: SyncEntity,
): EntityMergeOutcome => ({
  rowAction: "none",
  columns: {},
  meta: local.meta ?? { fieldClocks: {}, rowHlc: remote.rowHlc, deletedAt: null },
  metaChanged: false,
  tombstoneApplied: false,
  overwritten: [],
});

/**
 * The generic merge of `merge-entity.ts`, entity by entity, with the foreign-key rules of
 * `apply-references.ts` for a child row: a parent that is gone forces a tombstone, an unknown
 * parent skips an entity that would have to be inserted.
 */
const mergeBatchGenerically = async (
  table: string,
  info: TableInfo,
  codec: FieldCodec,
  batch: readonly SyncEntity[],
  rows: Map<string, RawRow>,
  metas: Map<string, { field_clocks_json: string; row_hlc: string; deleted_at: string | null }>,
  guard: ReferenceGuard,
): Promise<StagedEntity[]> => {
  const staged: StagedEntity[] = [];
  for (const entity of batch) {
    const meta = metas.get(entity.entityId);
    const localRow = rows.get(entity.entityId) ?? null;
    const local = {
      row: localRow,
      meta: meta
        ? {
            fieldClocks: parseClocks(meta.field_clocks_json),
            rowHlc: meta.row_hlc,
            deletedAt: meta.deleted_at,
          }
        : null,
    };
    const parent: ParentStatus =
      entity.row === null ? { state: "present" } : await guard.statusOf(table, entity.row);
    let outcome: EntityMergeOutcome;
    try {
      outcome = mergeFieldClockEntity({
        codec,
        columns: info.columns,
        primaryKey: info.primaryKey,
        notNullColumns: info.notNull,
        local,
        remote: entity,
        ...(parent.state === "gone" ? { orphaned: { deletedAt: parent.deletedAt } } : {}),
      });
    } catch (error) {
      throw new SyncApplyError(
        "merge_failed",
        `Could not merge ${table} ${entity.entityId}: ${messageOf(error)}`,
        { table, entityId: entity.entityId, cause: error },
      );
    }
    const conflicts: ExtraConflict[] = [];
    if (outcome.forcedByParent === true && entity.row !== null) {
      conflicts.push({
        id: orphanedChildId(table, entity.entityId),
        kind: "orphaned_child",
        entityType: table,
        entityId: entity.entityId,
        local: localRow,
        remote: entity.row,
      });
    }
    // The parent was never heard of: inserting would violate the key and abort the bundle. Write
    // nothing, so the bundle that brings the parent applies the child.
    if (
      parent.state === "missing" &&
      localRow === null &&
      outcome.meta.deletedAt === null &&
      entity.row !== null
    ) {
      conflicts.push({
        id: orphanedChildId(table, entity.entityId),
        kind: "orphaned_child",
        entityType: table,
        entityId: entity.entityId,
        local: { parent: "unknown" },
        remote: entity.row,
      });
      outcome = skippedOutcome(local, entity);
    }
    staged.push({
      entityId: entity.entityId,
      key: parseEntityId(table, entity.entityId) as PrimaryKeyValue[],
      outcome,
      conflicts,
    });
  }
  return staged;
};

const applyEntityTable = async (
  db: Database,
  table: string,
  entities: readonly SyncEntity[],
  totals: Totals,
  conflicts: PendingConflict[],
  gtd: GtdApplyState | null,
  guard: ReferenceGuard,
): Promise<void> => {
  const info = await readTableInfo(db, table);
  const codec = buildEntityCodec(table, info.columns);
  if (codec.kind !== "field") {
    throw new SyncApplyError("unsupported_merge_class", `"${table}" has no field-clock codec`, {
      table,
    });
  }
  const rule = fieldClockRuleOf(table);

  // A table with a GTD rule is also visited with no entity at all when the bundle's recurrence
  // sidecars changed what its rows must say.
  for (const batch of entities.length === 0 ? [[]] : chunked(entities)) {
    const keys = new Map<string, PrimaryKeyValue[]>();
    for (const entity of batch) {
      keys.set(entity.entityId, parseEntityId(table, entity.entityId) as PrimaryKeyValue[]);
    }
    const ids = batch.map((entity) => entity.entityId);
    const rows = rowsById(
      table,
      info,
      await fetchRows(db, table, info.primaryKey, [...keys.values()]),
    );
    const metas = await fetchMeta(db, table, ids);

    let staged: StagedEntity[];
    try {
      if (rule !== undefined && gtd === null) {
        throw new Error(`"${table}" is merged by the ${rule} rule, which needs the gtd domain`);
      }
      const env = { db, table, info, codec: codec as FieldCodec };
      staged =
        rule === "gtd-task"
          ? await mergeTaskBatch(env, gtd as GtdApplyState, batch, rows, metas)
          : rule === "recurring-template"
            ? await mergeTemplateBatch(env, gtd as GtdApplyState, batch, rows, metas)
            : await mergeBatchGenerically(
                table,
                info,
                codec as FieldCodec,
                batch,
                rows,
                metas,
                guard,
              );
    } catch (error) {
      if (error instanceof SyncApplyError) throw error;
      throw new SyncApplyError(
        "merge_failed",
        `Could not merge ${table} ${ids[0] ?? ""}: ${messageOf(error)}`,
        { table, entityId: ids[0] ?? null, cause: error },
      );
    }

    const outcome = emptyOutcome();
    for (const entry of staged) {
      const { entityId, key, outcome: merged } = entry;
      try {
        if (merged.rowAction === "delete" && guard.isCascadeParent(table)) {
          // Children first: the delete runs in `guard.flush`, after every table was applied.
          guard.deferDelete(table, entityId, key, merged.meta.deletedAt as string);
        } else {
          await writeRow(db, table, info, key, merged);
        }
      } catch (error) {
        throw await toSqlApplyError(db, table, entityId, error);
      }

      if (merged.metaChanged) {
        outcome.metaWrites.push({
          entityId,
          fieldClocksJson: canonicalJson(merged.meta.fieldClocks),
          rowHlc: merged.meta.rowHlc,
          deletedAt: merged.meta.deletedAt,
        });
      }
      if (merged.rowAction !== "none" || merged.metaChanged) {
        totals.applied += 1;
      } else {
        totals.skipped += 1;
      }
      if (merged.tombstoneApplied) {
        totals.tombstonesApplied += 1;
      }
      for (const field of merged.overwritten) {
        conflicts.push(conflictOf(table, entityId, field));
      }
      for (const conflict of entry.conflicts) {
        conflicts.push(extraConflictOf(conflict));
      }
    }

    // The snapshot is the row as the stamper will decode it next time, so read it back after the
    // writes: SQLite column affinity may have changed a value on the way in.
    const allKeys = staged.map((entry) => entry.key);
    const final = rowsById(table, info, await fetchRows(db, table, info.primaryKey, allKeys));
    const snapshots = await fetchSnapshots(
      db,
      table,
      staged.map((entry) => entry.entityId),
    );
    for (const entry of staged) {
      const snapshot = snapshots.get(entry.entityId);
      const row = final.get(entry.entityId);
      if (entry.outcome.meta.deletedAt !== null || row === undefined) {
        if (snapshot) {
          outcome.snapshotDeletes.push(entry.entityId);
        }
        continue;
      }
      const wanted = canonicalJson(codec.decode(row));
      if (snapshot?.snapshot_json !== wanted) {
        outcome.snapshotWrites.push({
          entityId: entry.entityId,
          snapshotJson: wanted,
          contentHash: null,
        });
      }
    }
    await writeOutcome(db, table, outcome);
  }
};

// ---------------------------------------------------------------------------------------------
// Grow-only-union tables
// ---------------------------------------------------------------------------------------------

/**
 * Insert-if-absent. `ON CONFLICT DO NOTHING` without a target also absorbs a collision on a unique
 * key other than the primary key (`gtd_task_events.dedupe_key`): for a union that is the same row
 * seen under two ids, and the first one stays. Other failures (a NOT NULL column the sender did not
 * provide, for instance) still abort the bundle.
 */
const applyUnionTable = async (
  db: Database,
  table: string,
  rows: readonly SyncRow[],
  totals: Totals,
): Promise<void> => {
  const info = await readTableInfo(db, table);
  const bySignature = new Map<string, { columns: string[]; rows: SyncRow[] }>();
  const ordered = [...rows].sort((a, b) => {
    const left = entityIdOf(
      table,
      info.primaryKey.map((column) => getOwn(a, column)),
    );
    const right = entityIdOf(
      table,
      info.primaryKey.map((column) => getOwn(b, column)),
    );
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const row of ordered) {
    const columns = info.columns.filter((column) => Object.hasOwn(row, column));
    const signature = columns.join(",");
    const group = bySignature.get(signature) ?? { columns, rows: [] };
    group.rows.push(row);
    bySignature.set(signature, group);
  }

  for (const { columns, rows: group } of bySignature.values()) {
    const perChunk = Math.max(1, Math.floor(INSERT_PARAM_BUDGET / columns.length));
    for (const batch of chunked(group, perChunk)) {
      const values = batch
        .map((_, index) => `(${placeholders(columns.length, index * columns.length + 1)})`)
        .join(", ");
      try {
        const result = await db.execute(
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES ${values} ON CONFLICT DO NOTHING`,
          batch.flatMap((row) => columns.map((column) => getOwn(row, column))),
        );
        const inserted = Math.min(result.rowsAffected, batch.length);
        totals.applied += inserted;
        totals.skipped += batch.length - inserted;
      } catch (error) {
        throw await toSqlApplyError(db, table, null, error);
      }
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const applySettings = async (
  db: Database,
  changeSet: SyncChangeSet,
  context: ApplyContext,
  totals: Totals,
): Promise<void> => {
  if (changeSet.settings.length === 0) {
    return;
  }
  const entries = [...changeSet.settings].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const entry of entries) {
    // Defence in depth behind validateChangeSet: a bundle can never write a secret, a device key or
    // a key of another domain, whatever path got it here.
    try {
      assertSettingPublishable(entry.key, changeSet.domain);
    } catch (error) {
      throw new SyncApplyError("setting_not_syncable", messageOf(error), {
        table: SETTING_ENTITY_TYPE,
        entityId: entry.key,
      });
    }
  }

  const keys = entries.map((entry) => entry.key);
  const metas = await fetchMeta(db, SETTING_ENTITY_TYPE, keys);
  const snapshots = await fetchSnapshots(db, SETTING_ENTITY_TYPE, keys);
  const current = (await context.settings.read(db)) as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };

  const merges = entries.map((entry) => {
    const rule = settingRule(entry.key);
    if (rule.scope === "device") {
      throw new SyncApplyError("setting_not_syncable", `Setting "${entry.key}" is device-local`, {
        entityId: entry.key,
      });
    }
    try {
      const merged = mergeSettingEntry(
        rule,
        { value: getOwn(current, entry.key) ?? null, clock: metas.get(entry.key)?.row_hlc ?? null },
        entry,
      );
      if (merged.valueChanged) {
        setOwn(next, entry.key, merged.value);
      }
      return { entry, merged };
    } catch (error) {
      throw new SyncApplyError(
        "invalid_setting_value",
        `Could not merge setting "${entry.key}": ${messageOf(error)}`,
        { entityId: entry.key, cause: error },
      );
    }
  });

  const stored = merges.some(({ merged }) => merged.valueChanged)
    ? ((await context.settings.write(db, next as unknown as AppSettings)) as unknown as Record<
        string,
        unknown
      >)
    : current;

  const outcome = emptyOutcome();
  for (const { entry, merged } of merges) {
    const meta = metas.get(entry.key);
    const finalValue = getOwn(stored, entry.key) ?? null;
    if (merged.clockChanged || meta === undefined) {
      outcome.metaWrites.push({
        entityId: entry.key,
        fieldClocksJson: "{}",
        rowHlc: merged.clock as string,
        deletedAt: null,
      });
    }
    const wanted = canonicalJson(finalValue);
    if (snapshots.get(entry.key)?.snapshot_json !== wanted) {
      outcome.snapshotWrites.push({ entityId: entry.key, snapshotJson: wanted, contentHash: null });
    }
    if (merged.valueChanged || merged.clockChanged || meta === undefined) {
      totals.applied += 1;
    } else {
      totals.skipped += 1;
    }
  }
  await writeOutcome(db, SETTING_ENTITY_TYPE, outcome);
};

// ---------------------------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------------------------

const insertConflicts = async (
  db: Database,
  conflicts: readonly PendingConflict[],
  nowMs: number,
): Promise<number> => {
  let logged = 0;
  const detectedAt = new Date(nowMs).toISOString();
  for (const batch of chunked(conflicts, 50)) {
    const values = batch.map((_, index) => `(${placeholders(7, index * 7 + 1)})`).join(", ");
    const result = await db.execute(
      `INSERT INTO sync_conflicts
         (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
       VALUES ${values} ON CONFLICT(id) DO NOTHING`,
      batch.flatMap((conflict) => [
        conflict.id,
        conflict.entityType,
        conflict.entityId,
        conflict.kind,
        conflict.localJson,
        conflict.remoteJson,
        detectedAt,
      ]),
    );
    logged += Math.min(result.rowsAffected, batch.length);
  }
  return logged;
};

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const mergeAll = async (
  db: Database,
  changeSet: SyncChangeSet,
  context: ApplyContext,
): Promise<Omit<SyncApplyResult, "hlcAdvanced">> => {
  const totals: Totals = { applied: 0, skipped: 0, tombstonesApplied: 0 };
  const conflicts: PendingConflict[] = [];

  // The recurrence sidecars merge first: the instance rows and templates are recomputed from them.
  let gtd: GtdApplyState | null = null;
  if (changeSet.domain === "gtd") {
    const sidecars = await applyRecurrenceSidecars(db, changeSet.recurrence);
    totals.applied += sidecars.applied;
    totals.skipped += sidecars.skipped;
    conflicts.push(...sidecars.conflicts.map(extraConflictOf));
    gtd = await loadGtdApplyState(db, touchedTemplatesOf(changeSet, sidecars.templates));
  }

  const byTable = new Map<string, SyncEntity[]>();
  for (const entity of changeSet.entities) {
    byTable.set(entity.table, [...(byTable.get(entity.table) ?? []), entity]);
  }
  if (gtd !== null && gtd.touchedTemplates.size > 0) {
    for (const table of ["gtd_tasks", "recurring_task_templates"]) {
      if (!byTable.has(table)) byTable.set(table, []);
    }
  }
  // Tasks last: whether a planned task's project is gone is read from the project tombstones, which
  // must have been applied by then.
  const rank = (table: string): number => tableOrder(table) + (table === "gtd_tasks" ? 1000 : 0);
  const entityTables = [...byTable.keys()].sort((a, b) => rank(a) - rank(b));
  const unionTables = Object.keys(changeSet.unionRows).sort(
    (a, b) => tableOrder(a) - tableOrder(b),
  );

  // Parents before children, derived from the declared foreign keys: a proposal needs its message
  // (a union table), a result its objective. Otherwise the order above stands.
  const guard = await ReferenceGuard.create(db);
  const bundleSessionIds = new Set(
    changeSet.entities
      .filter((entity) => entity.table === "pomodoro_sessions" && entity.row !== null)
      .map((entity) => entity.entityId),
  );
  const order = orderByReferences([...entityTables, ...unionTables], guard.edges);
  for (const table of order) {
    if (byTable.has(table)) {
      const entities = (byTable.get(table) as SyncEntity[]).sort((a, b) =>
        a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
      );
      if (strategyForTable(table)?.kind === "row-clock") {
        await applyRowClockTable(db, table, entities, totals, conflicts, guard, bundleSessionIds);
      } else {
        await applyEntityTable(db, table, entities, totals, conflicts, gtd, guard);
      }
    } else {
      await applyUnionTable(db, table, getOwn(changeSet.unionRows, table) as SyncRow[], totals);
    }
  }
  // The deletes of parents the bundle removed run last, children first (apply-references.ts).
  await guard.flush(totals);

  await applySettings(db, changeSet, context, totals);
  const conflictsLogged = await insertConflicts(db, conflicts, context.nowMs);
  return { ...totals, conflictsLogged };
};

/**
 * Applies a change set prepared by {@link prepareApply} inside the caller's open write transaction.
 * Throws a `SyncApplyError` (or a `SyncClockError`) without leaving anything behind once the
 * caller's transaction rolls back; on success `applying` is back to 0 when this returns.
 */
export const applyChangeSet = async (
  db: Database,
  changeSet: SyncChangeSet,
  context: ApplyContext,
): Promise<SyncApplyResult> => {
  const identity = await db.select<{ device_id: string }[]>(
    "SELECT device_id FROM sync_identity WHERE id = 1",
  );
  if (identity.length === 0) {
    throw new SyncClockError(
      "identity_missing",
      "Multi-device sync identity has not been created on this device",
    );
  }

  const localSchema = await db.select<{ version: number | null }[]>(
    "SELECT MAX(id) AS version FROM schema_migrations",
  );
  if (changeSet.schemaVersion > Number(localSchema[0]?.version ?? 0)) {
    throw new SyncApplyError(
      "schema_newer_than_local",
      `The change set comes from schema ${changeSet.schemaVersion}, newer than this device's ${localSchema[0]?.version ?? 0}; update TrackDidia to merge it`,
    );
  }

  // Constraint A: stamp pending local edits BEFORE `applying` is raised.
  await stampDirtyEntities(db, context.nowMs);
  const hlcAdvanced = await absorbRemoteHlc(db, changeSet.hlcHigh, context.nowMs);

  await db.execute("UPDATE sync_identity SET applying = 1 WHERE id = 1");
  let merged: Omit<SyncApplyResult, "hlcAdvanced">;
  try {
    merged = await mergeAll(db, changeSet, context);
  } catch (error) {
    try {
      await db.execute("UPDATE sync_identity SET applying = 0 WHERE id = 1");
    } catch {
      /* the caller's ROLLBACK undoes the flag; keep the original failure */
    }
    throw error;
  }
  // Not best effort: if this fails the transaction must not commit with the flag raised.
  await db.execute("UPDATE sync_identity SET applying = 0 WHERE id = 1");
  return { ...merged, hlcAdvanced };
};
