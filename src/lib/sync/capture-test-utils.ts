// Shared helpers for the change-capture tests. Test-only: nothing in the app imports this file.
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import type { Database } from "../storage/sqlite-db";
import { runSqliteTransaction } from "../storage/transaction";
import { installSyncCapture } from "./capture-install";
import { stampDirtyEntities } from "./capture-stamp";

export const CAPTURE_DEVICE = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
export const CAPTURE_NOW = 1_800_000_000_000;
export const T0 = "2026-10-01T10:00:00.000Z";

export interface MarkRow {
  entity_type: string;
  entity_id: string;
  op: string;
}

export interface MetaRow {
  entity_type: string;
  entity_id: string;
  field_clocks_json: string;
  row_hlc: string;
  deleted_at: string | null;
}

/** A migrated in-memory database with (optionally) a sync identity and (optionally) capture. */
export const createCaptureDb = async (
  options: { identity?: boolean; capture?: boolean } = {},
): Promise<Database> => {
  const { identity = true, capture = true } = options;
  const db = createNodeSqliteDatabase();
  await runMigrations(db);
  if (identity) {
    await db.execute("INSERT INTO sync_identity (id, device_id, device_name) VALUES (1, $1, $2)", [
      CAPTURE_DEVICE,
      "Test laptop",
    ]);
  }
  if (capture) {
    await installSyncCapture(db);
  }
  return db;
};

export const readMarks = (db: Database): Promise<MarkRow[]> =>
  db.select<MarkRow[]>(
    "SELECT entity_type, entity_id, op FROM sync_dirty ORDER BY entity_type, entity_id",
  );

export const readMeta = (db: Database, entityType?: string): Promise<MetaRow[]> =>
  entityType === undefined
    ? db.select<MetaRow[]>("SELECT * FROM sync_entity_meta ORDER BY entity_type, entity_id")
    : db.select<MetaRow[]>(
        "SELECT * FROM sync_entity_meta WHERE entity_type = $1 ORDER BY entity_id",
        [entityType],
      );

export const readMetaOf = async (
  db: Database,
  entityType: string,
  entityId: string,
): Promise<MetaRow | undefined> =>
  (
    await db.select<MetaRow[]>(
      "SELECT * FROM sync_entity_meta WHERE entity_type = $1 AND entity_id = $2",
      [entityType, entityId],
    )
  )[0];

export const clocksOf = (meta: MetaRow | undefined): Record<string, string> =>
  JSON.parse(meta?.field_clocks_json ?? "{}") as Record<string, string>;

export const readIdentity = async (db: Database) =>
  (
    await db.select<
      {
        physical_ms: number;
        counter: number;
        change_counter: number;
        last_publish_counter: number;
        applying: number;
      }[]
    >(
      "SELECT physical_ms, counter, change_counter, last_publish_counter, applying FROM sync_identity WHERE id = 1",
    )
  )[0];

/** Everything the stamper may write, for "nothing changed" assertions. */
export const syncState = async (db: Database) => ({
  dirty: await readMarks(db),
  meta: await readMeta(db),
  snapshots: await db.select("SELECT * FROM sync_entity_snapshot ORDER BY entity_type, entity_id"),
  identity: await readIdentity(db),
});

/** One write transaction with the stamper as the pre-commit hook, like the repository does. */
export const stampedTransaction = <T>(
  db: Database,
  work: (db: Database) => Promise<T>,
  nowMs: number = CAPTURE_NOW,
): Promise<T> =>
  runSqliteTransaction(
    db,
    () => work(db),
    undefined,
    async (hookDb) => {
      await stampDirtyEntities(hookDb, nowMs);
    },
  );

export const insertContext = (db: Database, id: string, name = id, updatedAt = T0) =>
  db.execute(
    "INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
    [id, name, updatedAt],
  );

export const insertTask = (db: Database, id: string, overrides: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id,
    title: `Task ${id}`,
    notes: "",
    status: "open",
    bucket: "inbox",
    context_ids_json: "[]",
    source: "manual",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
  const columns = Object.keys(row);
  return db.execute(
    `INSERT INTO gtd_tasks (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    columns.map((column) => row[column]),
  );
};
