import { hash128 } from "../finance/hash";
import type { Database } from "../storage/sqlite-db";
import {
  getTableRegistration,
  type MergeClass,
  SYNC_DOMAINS,
  TABLE_REGISTRY,
  type TableRegistration,
} from "./registry";

/**
 * Change capture, part 1: which triggers exist and how they are installed.
 *
 * Capture is opt-in per database. While it is off there are no triggers, `sync_capture_state` has
 * no row and no write path runs any sync query. While it is on, every synced table that needs a
 * clock row has `AFTER INSERT / UPDATE / DELETE` triggers that only record WHAT changed, as a
 * `sync_dirty` mark. The clocks are computed in TypeScript by `capture-stamp.ts`, inside the same
 * transaction, right before it commits.
 *
 * The trigger SQL is generated, never hand-written: from the registry (which tables, which primary
 * key) and the live `pragma_table_info` (the registry's primary key must match the real one).
 * Generation is deterministic, so a hash of the generated SQL plus the live column lists identifies
 * the installed version: `ensureSyncCapture` reinstalls when it changes, or when a trigger is
 * missing (a migration that rebuilds a table drops its triggers with it).
 */

/** Reserved name prefix of every capture trigger; nothing else may use it. */
export const CAPTURE_TRIGGER_PREFIX = "trg_sync_cap_";

/** Bump when the shape of the generated SQL or of the dirty marks changes. */
export const CAPTURE_FORMAT_VERSION = 1;

/** The settings blob table: not a synced entity itself, but captured per synced key. */
export const SETTINGS_TABLE = "app_settings";

/**
 * Merge classes that need a `sync_entity_meta` row on the device. `grow-only-union` tables publish
 * as full sets by id / dedupe key and need no clock; sidecars and device-local tables never get
 * one (and the recurrence sidecars have their own, later, capture).
 */
const CAPTURED_MERGE_CLASSES: readonly MergeClass[] = [
  "field-clock",
  "row-clock",
  "monotonic-status",
  "child-set",
  "pomodoro",
];

export const isCapturedRegistration = (entry: TableRegistration): boolean =>
  (SYNC_DOMAINS as readonly string[]).includes(entry.domain) &&
  CAPTURED_MERGE_CLASSES.includes(entry.mergeClass);

/**
 * Grow-only-union tables (`ai_messages`, `gtd_task_events`) have no clocks, marks or snapshots, but a
 * row INSERTED into one is still a local change that has to be published. They get a single cheap
 * trigger that only bumps `sync_identity.change_counter` (see {@link buildUnionCounterTrigger}).
 */
export const unionCounterTables = (): TableRegistration[] =>
  TABLE_REGISTRY.filter(
    (entry) =>
      (SYNC_DOMAINS as readonly string[]).includes(entry.domain) &&
      entry.mergeClass === "grow-only-union",
  );

/** Registry tables that get capture triggers and a meta row per row, in registry order. */
export const capturedTables = (): TableRegistration[] =>
  TABLE_REGISTRY.filter(isCapturedRegistration);

export const isCapturedTable = (table: string): boolean => {
  try {
    return isCapturedRegistration(getTableRegistration(table));
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// Live schema
// ---------------------------------------------------------------------------------------------

export interface LiveTableSchema {
  /** Column names in declaration order. */
  columns: string[];
  /** Primary-key column names in key order. */
  primaryKey: string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const quoteIdent = (name: string): string => {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier "${name}"`);
  }
  return `"${name}"`;
};

const placeholders = (count: number, start = 1): string =>
  Array.from({ length: count }, (_, index) => `$${start + index}`).join(", ");

/** Columns and primary key of the named tables from the live database (tables that exist only). */
export const readLiveSchema = async (
  db: Database,
  tables: readonly string[],
): Promise<Map<string, LiveTableSchema>> => {
  const schema = new Map<string, LiveTableSchema>();
  if (tables.length === 0) {
    return schema;
  }
  const rows = await db.select<{ tbl: string; col: string; pk: number }[]>(
    `SELECT m.name AS tbl, p.name AS col, p.pk AS pk
     FROM sqlite_master m JOIN pragma_table_info(m.name) p
     WHERE m.type = 'table' AND m.name IN (${placeholders(tables.length)})
     ORDER BY m.name, p.cid`,
    [...tables],
  );
  const pkParts = new Map<string, { col: string; pk: number }[]>();
  for (const row of rows) {
    const entry = schema.get(row.tbl) ?? { columns: [], primaryKey: [] };
    entry.columns.push(row.col);
    schema.set(row.tbl, entry);
    if (row.pk > 0) {
      pkParts.set(row.tbl, [...(pkParts.get(row.tbl) ?? []), { col: row.col, pk: row.pk }]);
    }
  }
  for (const [table, parts] of pkParts) {
    const entry = schema.get(table);
    if (entry) {
      entry.primaryKey = parts.sort((a, b) => a.pk - b.pk).map((part) => part.col);
    }
  }
  return schema;
};

/** Every table that gets triggers: the captured registry tables plus the settings blob. */
export const captureTriggerTables = (): string[] => [
  ...capturedTables().map((entry) => entry.table),
  SETTINGS_TABLE,
];

/**
 * The registry's primary key is the contract the stamper relies on to find a row from a mark. It
 * must equal the live one; a mismatch means the registry or a migration is wrong, so fail loudly
 * instead of capturing under keys the stamper cannot resolve.
 */
export const assertRegistryMatchesSchema = (
  table: string,
  live: LiveTableSchema | undefined,
): LiveTableSchema => {
  if (!live || live.columns.length === 0) {
    throw new Error(`Sync capture: table "${table}" does not exist in the database`);
  }
  const registered = getTableRegistration(table).primaryKey;
  if (
    registered.length !== live.primaryKey.length ||
    !registered.every((column, index) => column === live.primaryKey[index])
  ) {
    throw new Error(
      `Sync capture: registry primary key of "${table}" is (${registered.join(", ")}) but the database has (${live.primaryKey.join(", ")})`,
    );
  }
  return live;
};

// ---------------------------------------------------------------------------------------------
// Trigger generation (pure)
// ---------------------------------------------------------------------------------------------

export interface CaptureTrigger {
  name: string;
  table: string;
  sql: string;
}

/**
 * The same canonical key as `entityIdOf`, built in SQL: the value as text for a single-column key,
 * `json_array(...)` for a composite one.
 */
const keySql = (row: "NEW" | "OLD", primaryKey: readonly string[]): string =>
  primaryKey.length === 1
    ? `CAST(${row}.${quoteIdent(primaryKey[0] as string)} AS TEXT)`
    : `json_array(${primaryKey.map((column) => `${row}.${quoteIdent(column)}`).join(", ")})`;

/**
 * No identity row (`NULL = 0` is not true) means capture is off for this database, and
 * `applying = 1` (set by the merge-apply transaction) means the write is a remote change that must
 * not be captured back, which would ping-pong between two laptops forever.
 *
 * Contract honoured by `applyChangeSet` (`apply-bundle.ts`): it drains local marks with
 * `stampDirtyEntities` BEFORE setting `applying = 1`, and it writes the snapshot and the meta row
 * for every row it applies. Otherwise a leftover local mark on a row the merge then overwrites
 * would be stamped later with a fresh local clock and the remote content (ping-pong), and a meta
 * row without a snapshot would restamp every field on the next local edit. Any other code that
 * sets `applying = 1` must keep both halves of that contract and reset the flag before COMMIT.
 */
const WHEN_CAPTURING = "WHEN (SELECT applying FROM sync_identity WHERE id = 1) = 0";

// The conflict handling is an UPSERT clause, not `INSERT OR REPLACE`: SQLite lets the OUTER
// statement's conflict algorithm override a trigger body's `OR` clause, so under an outer
// `INSERT ... ON CONFLICT DO UPDATE` (every repository upsert) a second mark for the same entity in
// one transaction used to fail with a UNIQUE error and roll the user's write back.
const ON_MARK_CONFLICT = "ON CONFLICT (entity_type, entity_id) DO UPDATE SET op = excluded.op";

const markSql = (table: string, key: string, op: "upsert" | "delete"): string =>
  `INSERT INTO sync_dirty (entity_type, entity_id, op) VALUES ('${table}', ${key}, '${op}') ${ON_MARK_CONFLICT}`;

/**
 * Triggers of one table. The marks are last-writer-wins on `(entity_type, entity_id)` thanks to
 * an upsert clause: a later delete turns an earlier upsert mark into `delete`, and a later
 * re-insert turns it back into `upsert`. An UPDATE that changes the key marks the old key deleted.
 * `SELECT ... WHERE` inside the trigger body carries no table, so an unchanged key adds nothing.
 */
export const buildTableCaptureTriggers = (
  table: string,
  primaryKey: readonly string[],
  ops: readonly ("insert" | "update" | "delete")[] = ["insert", "update", "delete"],
): CaptureTrigger[] => {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`Unsafe SQL identifier "${table}"`);
  }
  const triggers: CaptureTrigger[] = [];
  const add = (suffix: string, event: string, body: string[]) => {
    const name = `${CAPTURE_TRIGGER_PREFIX}${table}_${suffix}`;
    triggers.push({
      name,
      table,
      sql: [
        `CREATE TRIGGER ${quoteIdent(name)} AFTER ${event} ON ${quoteIdent(table)}`,
        WHEN_CAPTURING,
        "BEGIN",
        ...body.map((statement) => `  ${statement};`),
        "END",
      ].join("\n"),
    });
  };
  if (ops.includes("insert")) {
    add("ai", "INSERT", [markSql(table, keySql("NEW", primaryKey), "upsert")]);
  }
  if (ops.includes("update")) {
    const oldKey = keySql("OLD", primaryKey);
    const newKey = keySql("NEW", primaryKey);
    add("au", "UPDATE", [
      `INSERT INTO sync_dirty (entity_type, entity_id, op) SELECT '${table}', ${oldKey}, 'delete' WHERE ${oldKey} IS NOT ${newKey} ${ON_MARK_CONFLICT}`,
      markSql(table, newKey, "upsert"),
    ]);
  }
  if (ops.includes("delete")) {
    add("ad", "DELETE", [markSql(table, keySql("OLD", primaryKey), "delete")]);
  }
  return triggers;
};

/**
 * `AFTER INSERT` only: an insert that `ON CONFLICT DO NOTHING` ignores fires nothing, so a generator
 * that emits no event bumps nothing. Gated like every capture trigger (no identity row or
 * `applying = 1` is silent), so a merge-applied union row is never counted back. No dirty mark, no
 * snapshot: one UPDATE of the single identity row per inserted row.
 */
export const buildUnionCounterTrigger = (table: string): CaptureTrigger => {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`Unsafe SQL identifier "${table}"`);
  }
  const name = `${CAPTURE_TRIGGER_PREFIX}${table}_cnt`;
  return {
    name,
    table,
    sql: [
      `CREATE TRIGGER ${quoteIdent(name)} AFTER INSERT ON ${quoteIdent(table)}`,
      WHEN_CAPTURING,
      "BEGIN",
      "  UPDATE sync_identity SET change_counter = change_counter + 1 WHERE id = 1;",
      "END",
    ].join("\n"),
  };
};

/** All capture triggers for a live schema, sorted by name. Validates registry against schema. */
export const buildCaptureTriggers = (schema: Map<string, LiveTableSchema>): CaptureTrigger[] => {
  const triggers: CaptureTrigger[] = [];
  for (const table of captureTriggerTables()) {
    assertRegistryMatchesSchema(table, schema.get(table));
    const registered = getTableRegistration(table).primaryKey;
    triggers.push(
      ...buildTableCaptureTriggers(
        table,
        registered,
        // The blob row is never deleted by the app; a delete has nothing to stamp.
        table === SETTINGS_TABLE ? ["insert", "update"] : ["insert", "update", "delete"],
      ),
    );
  }
  for (const entry of unionCounterTables()) {
    // No column list is needed (the trigger touches no column); a missing table fails at install.
    triggers.push(buildUnionCounterTrigger(entry.table));
  }
  return triggers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/**
 * Identifies the installed version: format version, the live column list and key of every captured
 * table, and the generated SQL. A new column or a registry change flips it.
 */
export const expectedCaptureHash = (
  schema: Map<string, LiveTableSchema>,
  triggers: readonly CaptureTrigger[],
): string => {
  const lines = [`capture-format:${CAPTURE_FORMAT_VERSION}`];
  for (const table of captureTriggerTables().sort()) {
    const live = schema.get(table);
    lines.push(
      `table:${table}:${live?.columns.join(",") ?? ""}:${live?.primaryKey.join(",") ?? ""}`,
    );
  }
  for (const trigger of triggers) {
    lines.push(trigger.sql);
  }
  return hash128(lines.join("\n"));
};

// ---------------------------------------------------------------------------------------------
// Install / ensure / disable (run inside the caller's write transaction)
// ---------------------------------------------------------------------------------------------

const TRIGGER_NAME_LIKE = "trg\\_sync\\_cap\\_%";

const installedTriggerNames = async (db: Database): Promise<string[]> =>
  (
    await db.select<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRIGGER_NAME_LIKE}' ESCAPE '\\' ORDER BY name`,
    )
  ).map((row) => row.name);

const dropInstalledTriggers = async (db: Database): Promise<number> => {
  const names = await installedTriggerNames(db);
  for (const name of names) {
    await db.execute(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
  }
  return names.length;
};

const loadExpected = async (
  db: Database,
): Promise<{ triggers: CaptureTrigger[]; hash: string }> => {
  const schema = await readLiveSchema(db, captureTriggerTables());
  const triggers = buildCaptureTriggers(schema);
  return { triggers, hash: expectedCaptureHash(schema, triggers) };
};

/** True while this database has capture installed (a `sync_capture_state` row exists). */
export const isSyncCaptureInstalled = async (db: Database): Promise<boolean> =>
  (await db.select<{ id: number }[]>("SELECT id FROM sync_capture_state WHERE id = 1")).length > 0;

export interface InstallCaptureResult {
  installedHash: string;
  triggerCount: number;
}

/**
 * Drops every `trg_sync_cap_%` trigger, creates the expected set and records its hash in
 * `sync_capture_state`. Idempotent. Must run inside a write transaction (DDL is transactional in
 * SQLite, so a failure leaves the old triggers). Does not need an identity row: without one the
 * triggers are inert.
 */
export const installSyncCapture = async (
  db: Database,
  now: Date = new Date(),
): Promise<InstallCaptureResult> => {
  const { triggers, hash } = await loadExpected(db);
  await dropInstalledTriggers(db);
  for (const trigger of triggers) {
    await db.execute(trigger.sql);
  }
  await db.execute(
    `INSERT INTO sync_capture_state (id, installed_hash, installed_at) VALUES (1, $1, $2)
     ON CONFLICT(id) DO UPDATE SET installed_hash = excluded.installed_hash, installed_at = excluded.installed_at`,
    [hash, now.toISOString()],
  );
  return { installedHash: hash, triggerCount: triggers.length };
};

export type EnsureCaptureResult =
  /** Capture was never enabled on this database: nothing was touched. */
  | { state: "disabled" }
  | { state: "current"; installedHash: string }
  | { state: "reinstalled"; installedHash: string; triggerCount: number };

/**
 * Keeps an enabled database's triggers in step with the registry and the live schema. Does nothing
 * (one query) when capture was never enabled. Reinstalls when the stored hash differs from the
 * expected one, or when the set of installed triggers is not the expected set.
 */
export const ensureSyncCapture = async (
  db: Database,
  now: Date = new Date(),
): Promise<EnsureCaptureResult> => {
  const state = await db.select<{ installed_hash: string }[]>(
    "SELECT installed_hash FROM sync_capture_state WHERE id = 1",
  );
  if (state.length === 0) {
    return { state: "disabled" };
  }
  const { triggers, hash } = await loadExpected(db);
  const installed = await installedTriggerNames(db);
  const expectedNames = triggers.map((trigger) => trigger.name);
  if (
    state[0]?.installed_hash === hash &&
    installed.length === expectedNames.length &&
    installed.every((name, index) => name === expectedNames[index])
  ) {
    return { state: "current", installedHash: hash };
  }
  const result = await installSyncCapture(db, now);
  return { state: "reinstalled", ...result };
};

/**
 * Drops the capture triggers, the pending marks, the state row and any backfill progress. Leaves `sync_entity_meta` and
 * `sync_entity_snapshot` alone: they are the history a later `enableSyncCapture` reconciles
 * against (its verify pass restamps anything edited while capture was off).
 */
export const disableSyncCapture = async (db: Database): Promise<{ droppedTriggers: number }> => {
  const droppedTriggers = await dropInstalledTriggers(db);
  await db.execute("DELETE FROM sync_dirty");
  await db.execute("DELETE FROM sync_capture_state WHERE id = 1");
  // A pass in flight is meaningless without capture; the next enable starts a fresh one.
  await db.execute("DELETE FROM sync_backfill_state WHERE id = 1");
  return { droppedTriggers };
};
