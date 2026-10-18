// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import type { Database } from "../sqlite-db";
import { migrations, resolveIdempotentMigrationSql, runMigrations } from "./index";

const CAPTURE_TABLES = ["sync_capture_state", "sync_dirty", "sync_entity_snapshot"];

const migration = migrations.find((item) => item.id === 43)!;

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

describe("migration 43 add_sync_capture_state", () => {
  it("is the next id after 42, appended last, and uses only CREATE TABLE IF NOT EXISTS", () => {
    expect(migration.name).toBe("add_sync_capture_state");
    expect(migrations.at(-1)?.id).toBe(43);
    expect(migrations.at(-2)?.id).toBe(42);
    expect(migration.guards).toBeUndefined();
    const statements = migration.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    }
    // Additive only, and no trigger: triggers exist only once capture is enabled.
    expect(migration.sql).not.toMatch(
      /\b(ALTER|DROP|DELETE|UPDATE|INSERT|REPLACE|PRAGMA|TRIGGER)\b/i,
    );
  });

  it("creates exactly the three capture tables and no trigger", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 42);
    const before = await userTables(db);
    await applyOnly(db, migration);
    const after = await userTables(db);
    expect(after.filter((name) => !before.includes(name))).toEqual(CAPTURE_TABLES);
    expect(before.every((name) => after.includes(name))).toBe(true);
    await runMigrations(db);
    expect(await db.select("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);
  });

  it("has the documented column shapes", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const shape = async (table: string) =>
      (await db.select<ColumnInfo[]>(`PRAGMA table_info(${table})`)).map(
        ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
      );
    expect(await shape("sync_dirty")).toEqual([
      { name: "entity_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "entity_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 2 },
      { name: "op", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_entity_snapshot")).toEqual([
      { name: "entity_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "entity_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 2 },
      { name: "snapshot_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "content_hash", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_capture_state")).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "installed_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "installed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
  });

  it("pins sync_capture_state to a single row", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    await db.execute("INSERT INTO sync_capture_state VALUES (1, 'h', 't')");
    await expect(
      db.execute("INSERT INTO sync_capture_state VALUES (2, 'h', 't')"),
    ).rejects.toThrow();
  });

  it("preserves a database seeded with a row in every existing table, byte for byte", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 42);
    await seedEveryTable(db);
    const existing = await userTables(db);
    const before = (await snapshot(db, existing)) as Record<string, { rows: unknown[] }>;
    await applyOnly(db, migration);
    const after = (await snapshot(db, existing)) as Record<string, { rows: unknown[] }>;
    // Every pre-existing table is identical except the ledger, which gained exactly migration 43.
    for (const table of existing) {
      if (table === "schema_migrations") continue;
      expect({ table, state: after[table] }).toEqual({ table, state: before[table] });
    }
    expect(after.schema_migrations?.rows).toHaveLength(
      (before.schema_migrations?.rows.length ?? 0) + 1,
    );
    // No pre-existing schema object changed; only the new tables were added.
    const beforeObjects = before.objects as unknown as { name: string; sql: string | null }[];
    const afterObjects = after.objects as unknown as { name: string; sql: string | null }[];
    for (const object of beforeObjects) {
      expect(afterObjects.find((item) => item.name === object.name)).toEqual(object);
    }
    expect(
      afterObjects
        .filter((item) => !beforeObjects.some((old) => old.name === item.name))
        .map((item) => item.name),
    ).toEqual(expect.arrayContaining(CAPTURE_TABLES));
  });

  it("adds no rows to any new table (inert: no seed data)", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    for (const table of CAPTURE_TABLES) {
      expect(await db.select(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it("is idempotent: a second run is a no-op and the SQL can be re-executed over live data", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 42);
    await seedEveryTable(db);
    await runMigrations(db);
    const onMigration = vi.fn();
    await runMigrations(db, onMigration);
    expect(onMigration).not.toHaveBeenCalled();

    await db.execute("INSERT INTO sync_dirty VALUES ('gtd_tasks', 't1', 'upsert')");
    await db.execute("INSERT INTO sync_entity_snapshot VALUES ('gtd_tasks', 't1', '{}', 'h')");
    await db.execute("INSERT INTO sync_capture_state VALUES (1, 'h', '2026-10-18T00:00:00.000Z')");
    const before = await snapshot(db, await userTables(db));
    await db.execute(await resolveIdempotentMigrationSql(db, migration));
    expect(await snapshot(db, await userTables(db))).toEqual(before);
  });

  it("recovers when the tables exist but the ledger entry is missing, keeping their rows", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    await db.execute("INSERT INTO sync_capture_state VALUES (1, 'h', 't')");
    await db.execute("DELETE FROM schema_migrations WHERE id = 43");
    await runMigrations(db);
    expect(await db.select("SELECT id FROM schema_migrations WHERE id = 43")).toHaveLength(1);
    expect(await db.select("SELECT installed_hash FROM sync_capture_state")).toEqual([
      { installed_hash: "h" },
    ]);
  });
});
