// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { ensureSyncCapture, installSyncCapture } from "../../sync/capture-install";
import { stampDirtyEntities } from "../../sync/capture-stamp";
import type { Database } from "../sqlite-db";
import { migrations, resolveIdempotentMigrationSql, runMigrations } from "./index";

const migration = migrations.find((item) => item.id === 48)!;

const applyOnly = async (db: Database, item: (typeof migrations)[number]): Promise<void> => {
  await db.execute(await resolveIdempotentMigrationSql(db, item));
  await db.execute("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)", [
    item.id,
    item.name,
    "2026-11-01T00:00:00.000Z",
  ]);
};

const migrateUpTo = async (db: Database, maxId: number): Promise<void> => {
  await db.execute(migrations[0].sql);
  for (const item of migrations.slice(1)) {
    if (item.id > maxId) break;
    await applyOnly(db, item);
  }
};

const DEVICE = "dev:00000000-0000-4000-8000-000000000001";
const IDENTITY = `INSERT INTO sync_identity (id, device_id, device_name) VALUES (1, '${DEVICE}', 'A')`;

describe("migration 48 add_sync_tombstone_row_values", () => {
  it("is appended directly after 47 and only adds two nullable columns", () => {
    expect(migration.name).toBe("add_sync_tombstone_row_values");
    const index = migrations.indexOf(migration);
    expect(migrations[index - 1]?.id).toBe(47);
    expect(migrations[index + 1]?.id).toBe(49);
    expect(migration.sql).not.toMatch(/\b(DROP|DELETE|INSERT|REPLACE|UPDATE|TRIGGER|CREATE)\b/i);
    expect(
      migration.sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean),
    ).toEqual([
      "ALTER TABLE sync_entity_meta ADD COLUMN deleted_row_json TEXT",
      "ALTER TABLE sync_dirty ADD COLUMN old_row TEXT",
    ]);
    expect(migration.guards?.skipIfColumnExists.map((guard) => guard.column)).toEqual([
      "deleted_row_json",
      "old_row",
    ]);
  });

  it("adds nullable TEXT columns after the existing ones", async () => {
    const db = await createNodeSqliteDatabase();
    await runMigrations(db);
    const shape = async (table: string) =>
      (
        await db.select<
          { name: string; type: string; notnull: number; dflt_value: string | null }[]
        >(`PRAGMA table_info(${table})`)
      )
        .slice(-1)
        .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    expect(await shape("sync_entity_meta")).toEqual([
      { name: "deleted_row_json", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
    expect(await shape("sync_dirty")).toEqual([
      { name: "old_row", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
  });

  it("keeps every existing tombstone, clock and mark, whose values are simply unknown", async () => {
    const db = await createNodeSqliteDatabase();
    await migrateUpTo(db, 47);
    await db.execute(IDENTITY);
    await db.execute(
      `INSERT INTO sync_entity_meta (entity_type, entity_id, field_clocks_json, row_hlc, deleted_at)
       VALUES ('gtd_tasks', 'live', '{"title":"h1"}', 'h1', NULL),
              ('gtd_tasks', 'dead', '{"title":"h1"}', 'h2', 'h2'),
              ('finance_people', 'p', '{}', 'h3', 'h3')`,
    );
    await db.execute(
      "INSERT INTO sync_dirty (entity_type, entity_id, op) VALUES ('gtd_tasks', 'x', 'delete')",
    );
    await db.execute("INSERT INTO sync_entity_snapshot VALUES ('gtd_tasks', 'live', '{}', NULL)");
    const before = await db.select(
      "SELECT entity_type, entity_id, field_clocks_json, row_hlc, deleted_at FROM sync_entity_meta ORDER BY entity_id",
    );
    await applyOnly(db, migration);
    expect(
      await db.select(
        "SELECT entity_type, entity_id, field_clocks_json, row_hlc, deleted_at FROM sync_entity_meta ORDER BY entity_id",
      ),
    ).toEqual(before);
    expect(await db.select("SELECT DISTINCT deleted_row_json FROM sync_entity_meta")).toEqual([
      { deleted_row_json: null },
    ]);
    expect(await db.select("SELECT entity_id, op, old_row FROM sync_dirty")).toEqual([
      { entity_id: "x", op: "delete", old_row: null },
    ]);
    expect(await db.select("SELECT COUNT(*) AS n FROM sync_entity_snapshot")).toEqual([{ n: 1 }]);
    expect(
      await db.select<{ name: string }[]>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_entity_meta' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      ),
    ).toEqual([{ name: "idx_sync_entity_meta_row_hlc" }]);
  });

  it("is safe to run again after the columns exist (a crash between the ALTERs and the ledger)", async () => {
    const db = await createNodeSqliteDatabase();
    await migrateUpTo(db, 47);
    await applyOnly(db, migration);
    await db.execute(
      "INSERT INTO sync_entity_meta (entity_type, entity_id, row_hlc, deleted_at, deleted_row_json) VALUES ('gtd_tasks', 'dead', 'h', 'h', '{\"id\":\"dead\"}')",
    );
    await db.execute("DELETE FROM schema_migrations WHERE id = 48");
    await runMigrations(db);
    expect(await db.select("SELECT id FROM schema_migrations WHERE id = 48")).toHaveLength(1);
    expect(await db.select("SELECT deleted_row_json FROM sync_entity_meta")).toEqual([
      { deleted_row_json: '{"id":"dead"}' },
    ]);
  });

  it("changes nothing else in the schema", async () => {
    const db = await createNodeSqliteDatabase();
    await migrateUpTo(db, 47);
    const objectsBefore = await db.select<{ name: string; sql: string }[]>(
      "SELECT name, sql FROM sqlite_master WHERE name NOT IN ('sync_entity_meta', 'sync_dirty') ORDER BY name",
    );
    await applyOnly(db, migration);
    expect(
      await db.select(
        "SELECT name, sql FROM sqlite_master WHERE name NOT IN ('sync_entity_meta', 'sync_dirty') ORDER BY name",
      ),
    ).toEqual(objectsBefore);
  });

  it("upgrades a database whose capture was installed before: triggers are repaired, tombstones start carrying values", async () => {
    const db = await createNodeSqliteDatabase();
    await migrateUpTo(db, 47);
    await db.execute(IDENTITY);
    await installSyncCapture(db); // the previous release's triggers (no old_row)
    await db.execute("UPDATE sync_capture_state SET installed_hash = 'release-47'");

    await applyOnly(db, migration);
    expect((await ensureSyncCapture(db)).state).toBe("reinstalled");
    await db.execute(
      "INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, created_at, updated_at) VALUES ('t1', 'Plan', '', 'open', 'inbox', '[]', 'manual', 't', 't')",
    );
    await stampDirtyEntities(db, 1_800_000_000_000);
    await db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    await stampDirtyEntities(db, 1_800_000_001_000);
    const [tombstone] = await db.select<
      { deleted_at: string | null; deleted_row_json: string | null }[]
    >("SELECT deleted_at, deleted_row_json FROM sync_entity_meta WHERE entity_id = 't1'");
    expect(tombstone?.deleted_at).toBeTruthy();
    expect(JSON.parse(tombstone?.deleted_row_json as string)).toMatchObject({
      id: "t1",
      title: "Plan",
    });
  });
});
