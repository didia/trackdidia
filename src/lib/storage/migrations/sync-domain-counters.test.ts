// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import type { Database } from "../sqlite-db";
import { migrations, resolveIdempotentMigrationSql, runMigrations } from "./index";

const migration = migrations.find((item) => item.id === 47)!;

const applyOnly = async (db: Database, item: (typeof migrations)[number]): Promise<void> => {
  await db.execute(await resolveIdempotentMigrationSql(db, item));
  await db.execute("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)", [
    item.id,
    item.name,
    "2026-10-01T00:00:00.000Z",
  ]);
};

const migrateUpTo = async (db: Database, maxId: number): Promise<void> => {
  await db.execute(migrations[0].sql);
  for (const item of migrations.slice(1)) {
    if (item.id > maxId) break;
    await applyOnly(db, item);
  }
};

const IDENTITY_V46 = `INSERT INTO sync_identity
  (id, device_id, device_name, physical_ms, counter, change_counter, last_publish_counter, applying)
  VALUES (1, 'dev:00000000-0000-4000-8000-000000000001', 'A', 5, 6, 12, 7, 0)`;

describe("migration 47 add_sync_domain_change_counters", () => {
  it("is appended directly after 46 and only adds columns to sync_identity", () => {
    expect(migration.name).toBe("add_sync_domain_change_counters");
    const index = migrations.indexOf(migration);
    expect(migrations[index - 1]?.id).toBe(46);
    // Later migrations may follow (48 adds the tombstone value columns); this one stays untouched.
    expect(migrations[index + 1]?.id).toBe(48);
    expect(migration.sql).not.toMatch(/\b(DROP|DELETE|INSERT|REPLACE|TRIGGER|CREATE)\b/i);
    expect(migration.guards?.skipIfColumnExists.map((guard) => guard.column)).toEqual([
      "gtd_changed_counter",
      "personal_changed_counter",
      "finance_changed_counter",
      "first_merge_backup_path",
    ]);
  });

  it("adds the columns with defaults of 0 / NULL on an empty sync_identity", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const columns = await db.select<
      { name: string; type: string; notnull: number; dflt_value: string | null }[]
    >("PRAGMA table_info(sync_identity)");
    expect(
      columns
        .slice(-4)
        .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value })),
    ).toEqual([
      { name: "gtd_changed_counter", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "personal_changed_counter", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "finance_changed_counter", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "first_merge_backup_path", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
    expect(await db.select("SELECT * FROM sync_identity")).toEqual([]);
  });

  it("keeps an existing identity row and counts every domain as changed at the current counter", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 46);
    await db.execute(IDENTITY_V46);
    await applyOnly(db, migration);
    expect(await db.select("SELECT * FROM sync_identity")).toEqual([
      {
        id: 1,
        device_id: "dev:00000000-0000-4000-8000-000000000001",
        device_name: "A",
        physical_ms: 5,
        counter: 6,
        change_counter: 12,
        last_publish_counter: 7,
        applying: 0,
        gtd_changed_counter: 12,
        personal_changed_counter: 12,
        finance_changed_counter: 12,
        first_merge_backup_path: null,
      },
    ]);
  });

  it("is safe to run again after the columns exist (a crash between the ALTERs and the ledger)", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 46);
    await db.execute(IDENTITY_V46);
    await applyOnly(db, migration);
    await db.execute("DELETE FROM schema_migrations WHERE id = 47");
    await runMigrations(db);
    expect(await db.select("SELECT id FROM schema_migrations WHERE id = 47")).toHaveLength(1);
    expect(await db.select("SELECT gtd_changed_counter FROM sync_identity")).toEqual([
      { gtd_changed_counter: 12 },
    ]);
  });

  it("leaves every other table untouched", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 46);
    const objectsBefore = await db.select<{ name: string; sql: string }[]>(
      "SELECT name, sql FROM sqlite_master WHERE name != 'sync_identity' ORDER BY name",
    );
    await applyOnly(db, migration);
    expect(
      await db.select(
        "SELECT name, sql FROM sqlite_master WHERE name != 'sync_identity' ORDER BY name",
      ),
    ).toEqual(objectsBefore);
  });
});
