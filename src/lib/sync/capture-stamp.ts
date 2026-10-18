import { defaultAppSettings, normalizeAppSettings } from "../../domain/settings";
import type { Database } from "../storage/sqlite-db";
import {
  assertRegistryMatchesSchema,
  captureTriggerTables,
  capturedTables,
  isCapturedTable,
  type LiveTableSchema,
  readLiveSchema,
  SETTINGS_TABLE,
} from "./capture-install";
import { buildEntityCodec, contentHash, type RawRow } from "./capture-decode";
import { createHlcBatch, type HlcBatch, SyncClockError } from "./clock-store";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import {
  buildFieldClockUpdates,
  canonicalJson,
  type FieldClocks,
  FieldClockShapeError,
  type FieldClockSpec,
  jsonDeepEqual,
  type JsonRecord,
  rowHlc,
  setOwn,
} from "./field-clocks";
import { encodeHlc } from "./hlc";
import { getTableRegistration, SETTING_ENTITY_TYPE, settingKeys, settingRule } from "./registry";

/**
 * Change capture, part 3: turning `sync_dirty` marks into clocks, inside the writer's transaction.
 *
 * The capture triggers (see `capture-install.ts`) only say WHAT changed. Everything here decides
 * WHETHER it really changed and stamps the clocks, so an `UPDATE` that sets identical values, or a
 * generator that finds nothing to do, writes nothing and moves no counter.
 *
 * For every mark the live database is the truth, not the mark's `op`: a row that exists is an
 * upsert, a row that is gone is a delete. That makes the result independent of the order of the
 * statements inside the transaction (delete then re-insert, REPLACE, cascades).
 *
 * Per entity, by merge class:
 * - field-clock: decode the row (`capture-decode.ts`), compare it with the stored snapshot, stamp
 *   one fresh clock on exactly the fields / map keys / set elements that changed
 *   (`buildFieldClockUpdates`), store the new clocks and snapshot.
 * - everything else captured (row-clock, monotonic-status, child-set, pomodoro): compare a content
 *   hash with the stored one and, only when different, set `row_hlc` to a fresh clock.
 * - delete: tombstone an entity that has a live meta row (`deleted_at` = `row_hlc` = a fresh clock;
 *   the field clocks are kept) and drop its snapshot. An entity that never had a meta row was never
 *   published, so nothing is written for it.
 * - a row that exists again after a tombstone starts over as a creation and clears `deleted_at`.
 * - `app_settings`: per synced key (device keys and secrets are skipped, never stored), an entity of
 *   type `setting`. The baseline of a key with no snapshot is its default value, so a database that
 *   never changed a key never stamps it, and joining with defaults can never beat a peer's value.
 *
 * TODO(finance-unit slice): `finance_transaction_splits` are stamped as row-clock entities of their
 * own. They are not yet reflected in the parent transaction's categorization-unit clock / base_hlc
 * (the causal rule of the spec's "Finance categorization unit"), which needs the merge design.
 */

const CHUNK = 100;

// A clock only used to ask "would anything change?" without consuming a real one.
const PROBE_HLC = encodeHlc(0, 0, "probe");

interface DirtyMark {
  rid: number;
  entity_type: string;
  entity_id: string;
  op: string;
}

interface MetaRow {
  entity_id: string;
  field_clocks_json: string;
  row_hlc: string;
  deleted_at: string | null;
}

interface SnapshotRow {
  entity_id: string;
  snapshot_json: string | null;
  content_hash: string | null;
}

interface MetaWrite {
  entityId: string;
  fieldClocksJson: string;
  rowHlc: string;
  deletedAt: string | null;
}

interface SnapshotWrite {
  entityId: string;
  snapshotJson: string | null;
  contentHash: string | null;
}

interface Outcome {
  metaWrites: MetaWrite[];
  snapshotWrites: SnapshotWrite[];
  snapshotDeletes: string[];
}

const emptyOutcome = (): Outcome => ({ metaWrites: [], snapshotWrites: [], snapshotDeletes: [] });

const chunked = <T>(items: readonly T[], size = CHUNK): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const placeholders = (count: number, start = 1): string =>
  Array.from({ length: count }, (_, index) => `$${start + index}`).join(", ");

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseClocks = (json: string | null | undefined): FieldClocks => {
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    if (!isPlainRecord(parsed)) return {};
    const clocks: FieldClocks = {};
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (typeof value === "string") {
        setOwn(clocks, key, value);
      }
    }
    return clocks;
  } catch {
    return {};
  }
};

const parseSnapshot = (json: string | null | undefined): JsonRecord | null => {
  if (typeof json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * `buildFieldClockUpdates` that survives user data it cannot merge per key: a map column whose JSON
 * has the wrong shape is demoted to one atomic scalar instead of throwing, because a throw here
 * would roll back the user's own save.
 */
const computeClocks = (
  previous: JsonRecord | null,
  next: JsonRecord,
  hlc: string,
  spec: FieldClockSpec,
  clocks: FieldClocks,
): FieldClocks => {
  let current = spec;
  for (let attempt = 0; attempt <= (spec.maps?.length ?? 0); attempt += 1) {
    try {
      return buildFieldClockUpdates(previous, next, hlc, { ...current, clocks });
    } catch (error) {
      if (error instanceof FieldClockShapeError && current.maps?.includes(error.field)) {
        current = {
          scalars: [...(current.scalars ?? []), error.field],
          maps: current.maps.filter((field) => field !== error.field),
          sets: current.sets,
        };
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable: map demotion exhausted");
};

// ---------------------------------------------------------------------------------------------
// Batched reads and writes
// ---------------------------------------------------------------------------------------------

const fetchRows = async (
  db: Database,
  table: string,
  primaryKey: readonly string[],
  keys: readonly (readonly PrimaryKeyValue[])[],
): Promise<RawRow[]> => {
  if (keys.length === 0) return [];
  if (primaryKey.length === 1) {
    return db.select<RawRow[]>(
      `SELECT * FROM "${table}" WHERE "${primaryKey[0]}" IN (${placeholders(keys.length)})`,
      keys.map((key) => key[0]),
    );
  }
  const width = primaryKey.length;
  const tuples = keys.map((_, row) => `(${placeholders(width, row * width + 1)})`).join(", ");
  return db.select<RawRow[]>(
    `SELECT * FROM "${table}" WHERE (${primaryKey.map((column) => `"${column}"`).join(", ")}) IN (VALUES ${tuples})`,
    keys.flat(),
  );
};

const fetchMeta = async (
  db: Database,
  entityType: string,
  ids: readonly string[],
): Promise<Map<string, MetaRow>> => {
  const found = new Map<string, MetaRow>();
  if (ids.length === 0) return found;
  const rows = await db.select<MetaRow[]>(
    `SELECT entity_id, field_clocks_json, row_hlc, deleted_at FROM sync_entity_meta
     WHERE entity_type = $1 AND entity_id IN (${placeholders(ids.length, 2)})`,
    [entityType, ...ids],
  );
  for (const row of rows) found.set(row.entity_id, row);
  return found;
};

const fetchSnapshots = async (
  db: Database,
  entityType: string,
  ids: readonly string[],
): Promise<Map<string, SnapshotRow>> => {
  const found = new Map<string, SnapshotRow>();
  if (ids.length === 0) return found;
  const rows = await db.select<SnapshotRow[]>(
    `SELECT entity_id, snapshot_json, content_hash FROM sync_entity_snapshot
     WHERE entity_type = $1 AND entity_id IN (${placeholders(ids.length, 2)})`,
    [entityType, ...ids],
  );
  for (const row of rows) found.set(row.entity_id, row);
  return found;
};

const writeOutcome = async (db: Database, entityType: string, outcome: Outcome): Promise<void> => {
  for (const batch of chunked(outcome.metaWrites)) {
    const values = batch.map((_, row) => `(${placeholders(5, row * 5 + 1)})`).join(", ");
    await db.execute(
      `INSERT OR REPLACE INTO sync_entity_meta
         (entity_type, entity_id, field_clocks_json, row_hlc, deleted_at) VALUES ${values}`,
      batch.flatMap((write) => [
        entityType,
        write.entityId,
        write.fieldClocksJson,
        write.rowHlc,
        write.deletedAt,
      ]),
    );
  }
  for (const batch of chunked(outcome.snapshotWrites)) {
    const values = batch.map((_, row) => `(${placeholders(4, row * 4 + 1)})`).join(", ");
    await db.execute(
      `INSERT OR REPLACE INTO sync_entity_snapshot
         (entity_type, entity_id, snapshot_json, content_hash) VALUES ${values}`,
      batch.flatMap((write) => [entityType, write.entityId, write.snapshotJson, write.contentHash]),
    );
  }
  for (const batch of chunked(outcome.snapshotDeletes)) {
    await db.execute(
      `DELETE FROM sync_entity_snapshot WHERE entity_type = $1 AND entity_id IN (${placeholders(batch.length, 2)})`,
      [entityType, ...batch],
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Per-table stamping
// ---------------------------------------------------------------------------------------------

const stampTableMarks = async (
  db: Database,
  table: string,
  marks: readonly DirtyMark[],
  live: LiveTableSchema,
  issuer: HlcBatch,
): Promise<number> => {
  const { primaryKey } = getTableRegistration(table);
  const codec = buildEntityCodec(table, live.columns);

  // Re-encode every mark through entityIdOf so meta keys are always canonical.
  const wanted = new Map<string, PrimaryKeyValue[]>();
  for (const mark of marks) {
    const key = parseEntityId(table, mark.entity_id);
    if (key === null) continue;
    try {
      wanted.set(entityIdOf(table, key), key);
    } catch {
      /* a malformed mark carries nothing to stamp */
    }
  }

  let stamped = 0;
  for (const batch of chunked([...wanted.entries()])) {
    const ids = batch.map(([id]) => id);
    const rows = new Map<string, RawRow>();
    for (const row of await fetchRows(
      db,
      table,
      primaryKey,
      batch.map(([, key]) => key),
    )) {
      try {
        rows.set(
          entityIdOf(
            table,
            primaryKey.map((column) => row[column]),
          ),
          row,
        );
      } catch {
        /* a row with a NULL key cannot be addressed */
      }
    }
    const metas = await fetchMeta(db, table, ids);
    const snapshots = await fetchSnapshots(db, table, ids);
    const outcome = emptyOutcome();

    for (const id of ids) {
      const row = rows.get(id);
      const meta = metas.get(id);
      const snapshot = snapshots.get(id);

      if (row === undefined) {
        if (snapshot) outcome.snapshotDeletes.push(id);
        if (meta && meta.deleted_at === null) {
          const hlc = await issuer.next();
          outcome.metaWrites.push({
            entityId: id,
            fieldClocksJson: meta.field_clocks_json,
            rowHlc: hlc,
            deletedAt: hlc,
          });
        }
        continue;
      }

      const liveMeta = meta && meta.deleted_at === null ? meta : undefined;
      const record = codec.decode(row);

      if (codec.kind === "field") {
        const previous = liveMeta ? parseSnapshot(snapshot?.snapshot_json) : null;
        const existing = meta ? parseClocks(meta.field_clocks_json) : {};
        if (previous !== null) {
          if (jsonDeepEqual(previous, record)) continue;
          // Would a clock move at all? (A set that was only reordered would not.)
          if (computeClocks(previous, record, PROBE_HLC, codec.spec, existing) === existing) {
            continue;
          }
        }
        const hlc = await issuer.next();
        const clocks = computeClocks(previous, record, hlc, codec.spec, existing);
        outcome.metaWrites.push({
          entityId: id,
          fieldClocksJson: canonicalJson(clocks),
          rowHlc: rowHlc(clocks) ?? hlc,
          deletedAt: null,
        });
        outcome.snapshotWrites.push({
          entityId: id,
          snapshotJson: canonicalJson(record),
          contentHash: null,
        });
        continue;
      }

      const hash = contentHash(record);
      if (liveMeta && snapshot?.content_hash === hash) continue;
      const hlc = await issuer.next();
      outcome.metaWrites.push({
        entityId: id,
        fieldClocksJson: meta?.field_clocks_json ?? "{}",
        rowHlc: hlc,
        deletedAt: null,
      });
      outcome.snapshotWrites.push({ entityId: id, snapshotJson: null, contentHash: hash });
    }

    await writeOutcome(db, table, outcome);
    stamped += outcome.metaWrites.length;
  }
  return stamped;
};

/** Settings keys that may leave the machine: registered, not device-scope, not a secret. */
export const capturedSettingKeys = (): string[] =>
  settingKeys().filter((key) => {
    const rule = settingRule(key);
    return rule.scope !== "device" && rule.secret !== true;
  });

const stampSettings = async (db: Database, issuer: HlcBatch): Promise<number> => {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE id = 1");
  if (!rows[0]) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rows[0].value);
  } catch {
    return 0;
  }
  if (!isPlainRecord(parsed)) return 0;
  const defaults = defaultAppSettings();
  const settings = normalizeAppSettings(parsed, defaults) as unknown as Record<string, unknown>;
  const defaultValues = defaults as unknown as Record<string, unknown>;
  const keys = capturedSettingKeys();
  const snapshots = new Map<string, SnapshotRow>();
  for (const batch of chunked(keys)) {
    for (const [id, row] of await fetchSnapshots(db, SETTING_ENTITY_TYPE, batch)) {
      snapshots.set(id, row);
    }
  }

  const outcome = emptyOutcome();
  for (const key of keys) {
    const next = settings[key] ?? null;
    const snapshot = snapshots.get(key);
    let previous: unknown = defaultValues[key] ?? null;
    if (snapshot?.snapshot_json != null) {
      try {
        previous = JSON.parse(snapshot.snapshot_json);
      } catch {
        /* a corrupt snapshot falls back to the default baseline */
      }
    }
    if (jsonDeepEqual(previous, next)) continue;
    const hlc = await issuer.next();
    outcome.metaWrites.push({ entityId: key, fieldClocksJson: "{}", rowHlc: hlc, deletedAt: null });
    outcome.snapshotWrites.push({
      entityId: key,
      snapshotJson: canonicalJson(next),
      contentHash: null,
    });
  }
  await writeOutcome(db, SETTING_ENTITY_TYPE, outcome);
  return outcome.metaWrites.length;
};

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

const MARK_CHUNK = 500;

/**
 * Drains `sync_dirty`: stamps clocks for every real change and bumps
 * `sync_identity.change_counter` by the number of stamped entities. Returns that number.
 *
 * Must run inside the transaction that wrote the marks (the repository's `beforeCommit` hook), so a
 * rollback undoes marks, meta, snapshots, clocks and counter together. Errors propagate: a failed
 * stamp must roll the user's write back rather than leave an unstamped change behind.
 *
 * Costs one `SELECT ... LIMIT 1` when there is nothing to do, and touches nothing else.
 */
export const stampDirtyEntities = async (db: Database, nowMs: number): Promise<number> => {
  const pending = await db.select<{ present: number }[]>(
    "SELECT 1 AS present FROM sync_dirty LIMIT 1",
  );
  if (pending.length === 0) return 0;

  // Marks only exist while an identity row does, but the identity could have been removed since
  // (a restored database). Without it no clock can be issued; the next enable re-scans everything.
  const identity = await db.select<{ id: number }[]>("SELECT id FROM sync_identity WHERE id = 1");
  if (identity.length === 0) {
    await db.execute("DELETE FROM sync_dirty");
    return 0;
  }

  const issuer = createHlcBatch(db, nowMs);
  const schemaCache = new Map<string, LiveTableSchema>();
  let stamped = 0;

  for (;;) {
    const marks = await db.select<DirtyMark[]>(
      "SELECT rowid AS rid, entity_type, entity_id, op FROM sync_dirty ORDER BY rowid LIMIT $1",
      [MARK_CHUNK],
    );
    if (marks.length === 0) break;

    const byType = new Map<string, DirtyMark[]>();
    for (const mark of marks) {
      const bucket = byType.get(mark.entity_type);
      if (bucket) bucket.push(mark);
      else byType.set(mark.entity_type, [mark]);
    }
    const tables = [...byType.keys()].filter((type) => isCapturedTable(type));
    const missing = tables.filter((table) => !schemaCache.has(table));
    if (missing.length > 0) {
      for (const [table, live] of await readLiveSchema(db, missing)) {
        schemaCache.set(table, live);
      }
    }
    for (const [type, typeMarks] of byType) {
      if (type === SETTINGS_TABLE) {
        stamped += await stampSettings(db, issuer);
      } else if (isCapturedTable(type)) {
        stamped += await stampTableMarks(
          db,
          type,
          typeMarks,
          assertRegistryMatchesSchema(type, schemaCache.get(type)),
          issuer,
        );
      }
      // Any other entity type is not captured here; the mark is dropped below.
    }

    const rids = marks.map((mark) => mark.rid);
    await db.execute(`DELETE FROM sync_dirty WHERE rowid IN (${placeholders(rids.length)})`, rids);
  }

  if (stamped > 0) {
    await issuer.flush();
    await db.execute("UPDATE sync_identity SET change_counter = change_counter + $1 WHERE id = 1", [
      stamped,
    ]);
  }
  return stamped;
};

export interface BackfillOptions {
  /**
   * Also re-check every row that already has a live meta row against its stored snapshot / hash,
   * not only rows with no meta. Needed when capture was off for a while (edits made meanwhile have
   * no marks). Costs a full read of every synced table, so it is for enable time, not for routine
   * runs.
   */
  verify?: boolean;
}

const keyExpression = (alias: string, primaryKey: readonly string[]): string =>
  primaryKey.length === 1
    ? `CAST(${alias}."${primaryKey[0]}" AS TEXT)`
    : `json_array(${primaryKey.map((column) => `${alias}."${column}"`).join(", ")})`;

/**
 * The self-healing scan. Marks, then stamps through the normal path:
 * - every synced row with no live meta row (never stamped, or tombstoned but present again) as a
 *   creation;
 * - every live meta row whose underlying row is gone as a tombstone (a delete no trigger saw, such
 *   as the replaced victim of `INSERT OR REPLACE` on a non-key unique conflict);
 * - the settings blob (its synced keys that differ from their baseline);
 * - with `verify`, every row.
 *
 * Idempotent: a second run stamps nothing. Runs inside the caller's write transaction. Requires an
 * identity row. Returns the number of stamped entities (also added to `change_counter`).
 */
export const backfillSyncCapture = async (
  db: Database,
  nowMs: number,
  options: BackfillOptions = {},
): Promise<number> => {
  const identity = await db.select<{ id: number }[]>("SELECT id FROM sync_identity WHERE id = 1");
  if (identity.length === 0) {
    throw new SyncClockError(
      "identity_missing",
      "Multi-device sync identity has not been created on this device",
    );
  }
  const schema = await readLiveSchema(db, captureTriggerTables());

  for (const entry of capturedTables()) {
    assertRegistryMatchesSchema(entry.table, schema.get(entry.table));
    const key = keyExpression("t", entry.primaryKey);
    const liveKey = keyExpression("l", entry.primaryKey);
    // NULL hazard: `x NOT IN (subquery)` is NULL, never true, as soon as the subquery yields a NULL.
    // Most captured primary keys are nullable TEXT, so the live-key subquery below filters NULLs
    // out; `sync_entity_meta.entity_id` is NOT NULL, so the other subquery cannot yield one.
    const unstamped = options.verify
      ? ""
      : `WHERE ${key} NOT IN (
           SELECT entity_id FROM sync_entity_meta
           WHERE entity_type = '${entry.table}' AND deleted_at IS NULL)`;
    await db.execute(
      `INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op)
       SELECT '${entry.table}', ${key}, 'upsert' FROM "${entry.table}" t ${unstamped}`,
    );
    await db.execute(
      `INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op)
       SELECT m.entity_type, m.entity_id, 'delete' FROM sync_entity_meta m
       WHERE m.entity_type = '${entry.table}' AND m.deleted_at IS NULL
         AND m.entity_id NOT IN (
           SELECT ${liveKey} FROM "${entry.table}" l WHERE ${liveKey} IS NOT NULL)`,
    );
  }
  await db.execute(
    `INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op)
     SELECT '${SETTINGS_TABLE}', CAST(id AS TEXT), 'upsert' FROM app_settings`,
  );
  return stampDirtyEntities(db, nowMs);
};
