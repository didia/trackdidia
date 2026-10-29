// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import type { Database } from "../sqlite-db";
import { migrations, resolveIdempotentMigrationSql, runMigrations } from "./index";

const BACKFILL_TABLES = ["sync_backfill_state"];

const migration = migrations.find((item) => item.id === 45)!;

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

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

const userTables = async (db: Database): Promise<string[]> =>
  (
    await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
  ).map((row) => row.name);

const seedEveryTable = async (db: Database): Promise<void> => {
  for (const table of await userTables(db)) {
    if (table === "schema_migrations") continue;
    const columns = await db.select<ColumnInfo[]>(`PRAGMA table_info(${table})`);
    const values = columns.map((column) => {
      if (table === "calendar_sync_settings" && column.name === "id") return "global";
      if (table === "app_settings" && column.name === "value") return '{"language":"fr"}';
      if (/INT/i.test(column.type)) return 1;
      if (/REAL|FLOA|DOUB/i.test(column.type)) return 1.5;
      return `seed-${table}-${column.name}`;
    });
    await db.execute(
      `INSERT OR IGNORE INTO ${table} (${columns.map((column) => column.name).join(", ")}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`,
      values,
    );
  }
};

const snapshot = async (db: Database, tables: string[]) => {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = {
      columns: await db.select(`PRAGMA table_info(${table})`),
      indexes: await db.select(`PRAGMA index_list(${table})`),
      rows: await db.select(`SELECT * FROM ${table} ORDER BY rowid`),
    };
  }
  result.objects = await db.select("SELECT name, sql FROM sqlite_master ORDER BY name");
  return result;
};

describe("migration 45 add_sync_backfill_state", () => {
  it("is the next id after 44, appended directly after it, and uses only CREATE TABLE IF NOT EXISTS", () => {
    expect(migration.name).toBe("add_sync_backfill_state");
    const index = migrations.indexOf(migration);
    expect(migrations[index - 1]?.id).toBe(44);
    expect(migrations[index + 1]).toBeUndefined();
    expect(migration.guards).toBeUndefined();
    const statements = migration.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    // Additive only: no change to an existing table, no trigger, no data.
    expect(migration.sql).not.toMatch(
      /\b(ALTER|DROP|DELETE|UPDATE|INSERT|REPLACE|PRAGMA|TRIGGER)\b/i,
    );
  });

  it("creates exactly the backfill table and no trigger", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 44);
    const before = await userTables(db);
    await applyOnly(db, migration);
    const after = await userTables(db);
    expect(after.filter((name) => !before.includes(name))).toEqual(BACKFILL_TABLES);
    expect(before.every((name) => after.includes(name))).toBe(true);
    expect(await db.select("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);
  });

  it("has the documented column shape and pins the table to one row with a closed status", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const shape = (await db.select<ColumnInfo[]>("PRAGMA table_info(sync_backfill_state)")).map(
      ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
    );
    expect(shape).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "pass", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
      { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "step", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
      { name: "cursor_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "total_rows", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "scanned_rows", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "stamped", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "started_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "completed_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    await db.execute(
      "INSERT INTO sync_backfill_state (id, status, started_at, updated_at) VALUES (1, 'running', 't', 't')",
    );
    await expect(
      db.execute(
        "INSERT INTO sync_backfill_state (id, status, started_at, updated_at) VALUES (2, 'running', 't', 't')",
      ),
    ).rejects.toThrow();
    await expect(db.execute("UPDATE sync_backfill_state SET status = 'paused'")).rejects.toThrow();
  });

  it("preserves a database seeded with a row in every existing table, byte for byte", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 44);
    await seedEveryTable(db);
    const existing = await userTables(db);
    const before = (await snapshot(db, existing)) as Record<string, { rows: unknown[] }>;
    await applyOnly(db, migration);
    const after = (await snapshot(db, existing)) as Record<string, { rows: unknown[] }>;
    for (const table of existing) {
      if (table === "schema_migrations") continue;
      expect({ table, state: after[table] }).toEqual({ table, state: before[table] });
    }
    expect(after.schema_migrations?.rows).toHaveLength(
      (before.schema_migrations?.rows.length ?? 0) + 1,
    );
    const beforeObjects = before.objects as unknown as { name: string; sql: string | null }[];
    const afterObjects = after.objects as unknown as { name: string; sql: string | null }[];
    for (const object of beforeObjects) {
      expect(afterObjects.find((item) => item.name === object.name)).toEqual(object);
    }
    expect(
      afterObjects
        .filter((item) => !beforeObjects.some((old) => old.name === item.name))
        .map((item) => item.name),
    ).toEqual(expect.arrayContaining(BACKFILL_TABLES));
  });

  it("adds no row (inert: no seed data)", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    expect(await db.select("SELECT COUNT(*) AS n FROM sync_backfill_state")).toEqual([{ n: 0 }]);
  });

  it("is idempotent: a second run is a no-op and the SQL can be re-executed over live data", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 44);
    await seedEveryTable(db);
    await runMigrations(db);
    const onMigration = vi.fn();
    await runMigrations(db, onMigration);
    expect(onMigration).not.toHaveBeenCalled();

    await db.execute(
      "INSERT INTO sync_backfill_state (id, pass, status, step, cursor_key, total_rows, scanned_rows, stamped, started_at, updated_at) VALUES (1, 2, 'running', 'rows:gtd_tasks', '[\"t9\"]', 10, 4, 3, 'a', 'b')",
    );
    const before = await snapshot(db, await userTables(db));
    await db.execute(await resolveIdempotentMigrationSql(db, migration));
    expect(await snapshot(db, await userTables(db))).toEqual(before);
  });

  it("recovers when the table exists but the ledger entry is missing, keeping its row", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    await db.execute(
      "INSERT INTO sync_backfill_state (id, status, step, started_at, updated_at) VALUES (1, 'running', 'settings', 'a', 'b')",
    );
    await db.execute("DELETE FROM schema_migrations WHERE id = 45");
    await runMigrations(db);
    expect(await db.select("SELECT id FROM schema_migrations WHERE id = 45")).toHaveLength(1);
    expect(await db.select("SELECT step FROM sync_backfill_state")).toEqual([{ step: "settings" }]);
  });
});
