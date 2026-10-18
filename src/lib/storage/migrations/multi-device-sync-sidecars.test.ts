// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import type { Database } from "../sqlite-db";
import { migrations, resolveIdempotentMigrationSql, runMigrations } from "./index";

const SIDECAR_TABLES = [
  "sync_conflicts",
  "sync_entity_meta",
  "sync_id_aliases",
  "sync_identity",
  "sync_peers",
  "sync_recurrence_clears",
  "sync_recurrence_occurrences",
];

const migration = migrations.find((item) => item.id === 42)!;

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Applies the catalog up to and including `maxId`, exactly like `runMigrations` would. */
const migrateUpTo = async (db: Database, maxId: number): Promise<void> => {
  await db.execute(migrations[0].sql);
  for (const item of migrations.slice(1)) {
    if (item.id > maxId) break;
    await db.execute(await resolveIdempotentMigrationSql(db, item));
    await db.execute("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)", [
      item.id,
      item.name,
      "2026-10-01T00:00:00.000Z",
    ]);
  }
};

const userTables = async (db: Database): Promise<string[]> =>
  (
    await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
  ).map((row) => row.name);

/**
 * Inserts one row into every table (except the ledger) with type-appropriate values. Tables that
 * migrations already seeded (default categories, singleton settings) keep their seed rows.
 */
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

interface Snapshot {
  columns: Record<string, ColumnInfo[]>;
  indexes: Record<string, unknown[]>;
  rows: Record<string, unknown[]>;
  objectSql: Record<string, string | null>;
}

const snapshot = async (db: Database, tables: string[]): Promise<Snapshot> => {
  const result: Snapshot = { columns: {}, indexes: {}, rows: {}, objectSql: {} };
  for (const table of tables) {
    result.columns[table] = await db.select<ColumnInfo[]>(`PRAGMA table_info(${table})`);
    result.indexes[table] = await db.select(`PRAGMA index_list(${table})`);
    result.rows[table] = await db.select(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  const objects = await db.select<{ name: string; sql: string | null }[]>(
    "SELECT name, sql FROM sqlite_master ORDER BY name",
  );
  for (const object of objects) result.objectSql[object.name] = object.sql;
  return result;
};

describe("migration 42 add_multi_device_sync_sidecars", () => {
  it("is the next id after 41, appended last, and uses only CREATE ... IF NOT EXISTS", () => {
    expect(migration.name).toBe("add_multi_device_sync_sidecars");
    expect(migrations.at(-1)?.id).toBe(42);
    expect(migrations.at(-2)?.id).toBe(41);
    expect(migration.guards).toBeUndefined();
    const statements = migration.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    }
    expect(migration.sql).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT|REPLACE|PRAGMA)\b/i);
  });

  it("creates exactly the sidecar tables and an index on row_hlc", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 41);
    const before = await userTables(db);
    expect(before).not.toContain("sync_entity_meta");
    await runMigrations(db);
    const after = await userTables(db);
    expect(after.filter((name) => !before.includes(name))).toEqual(SIDECAR_TABLES);
    expect(before.every((name) => after.includes(name))).toBe(true);
    expect(
      await db.select<{ name: string; tbl_name: string }[]>(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_entity_meta' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      ),
    ).toEqual([{ name: "idx_sync_entity_meta_row_hlc", tbl_name: "sync_entity_meta" }]);
    expect(
      await db.select<{ name: string }[]>("PRAGMA index_info(idx_sync_entity_meta_row_hlc)"),
    ).toMatchObject([{ name: "row_hlc" }]);
  });

  it("has the documented column shapes", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const shape = async (table: string) =>
      (await db.select<ColumnInfo[]>(`PRAGMA table_info(${table})`)).map(
        ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
      );
    expect(await shape("sync_entity_meta")).toEqual([
      { name: "entity_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "entity_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "field_clocks_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
      { name: "row_hlc", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "deleted_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_identity")).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "device_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "device_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "physical_ms", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "counter", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "change_counter", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "last_publish_counter", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "applying", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
    ]);
    expect(await shape("sync_peers")).toEqual([
      { name: "peer_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "peer_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_manifest_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_synced_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_applied_sha_by_domain", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
    ]);
    expect(await shape("sync_id_aliases")).toEqual([
      { name: "entity_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "alias_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "canonical_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "recorded_hlc", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_recurrence_occurrences")).toEqual([
      { name: "template_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "due_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "outcome", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "outcome_hlc", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "device_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_recurrence_clears")).toEqual([
      { name: "template_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "cleared_through_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(await shape("sync_conflicts")).toEqual([
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "entity_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "entity_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "local_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "remote_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "detected_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "resolved_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "resolution", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ]);
  });

  it("pins sync_identity to a single row", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    await db.execute("INSERT INTO sync_identity (id, device_id, device_name) VALUES (1, 'a', 'b')");
    await expect(
      db.execute("INSERT INTO sync_identity (id, device_id, device_name) VALUES (2, 'a', 'b')"),
    ).rejects.toThrow();
  });

  it("preserves a database seeded with a row in every existing table, byte for byte", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 41);
    await seedEveryTable(db);
    const existing = await userTables(db);
    expect(existing.length).toBeGreaterThan(30);
    const before = await snapshot(db, existing);
    for (const table of existing) {
      if (table === "schema_migrations") continue;
      expect({ table, seeded: (before.rows[table]?.length ?? 0) > 0 }).toEqual({
        table,
        seeded: true,
      });
    }

    await runMigrations(db);

    const after = await snapshot(db, existing);
    // Rows, column definitions, index lists and every pre-existing object's SQL are unchanged.
    expect(after.columns).toEqual(before.columns);
    expect(after.indexes).toEqual(before.indexes);
    expect({ ...after.rows, schema_migrations: [] }).toEqual({
      ...before.rows,
      schema_migrations: [],
    });
    for (const [name, sql] of Object.entries(before.objectSql)) {
      expect({ name, sql: after.objectSql[name] }).toEqual({ name, sql });
    }
    // The ledger gained exactly migration 42.
    expect(
      (await db.select<{ id: number }[]>("SELECT id FROM schema_migrations ORDER BY id")).map(
        (row) => row.id,
      ),
    ).toEqual(migrations.slice(1).map((item) => item.id));
    expect(after.rows.schema_migrations).toHaveLength(
      (before.rows.schema_migrations?.length ?? 0) + 1,
    );
  });

  it("adds no rows to any new table (inert: no seed data)", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    for (const table of SIDECAR_TABLES) {
      expect(await db.select(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it("is idempotent: a second run is a no-op and the SQL can be re-executed over live data", async () => {
    const db = createNodeSqliteDatabase();
    await migrateUpTo(db, 41);
    await seedEveryTable(db);
    await runMigrations(db);
    const onMigration = vi.fn();
    await runMigrations(db, onMigration);
    expect(onMigration).not.toHaveBeenCalled();

    await db.execute(
      "INSERT INTO sync_entity_meta (entity_type, entity_id, row_hlc) VALUES ('gtd_tasks', 't1', '000000000000001-000000-dev:x')",
    );
    await db.execute(
      "INSERT INTO sync_identity (id, device_id, device_name, physical_ms, counter) VALUES (1, 'dev:x', 'Laptop', 99, 3)",
    );
    const before = await snapshot(db, await userTables(db));
    await db.execute(await resolveIdempotentMigrationSql(db, migration));
    expect(await snapshot(db, await userTables(db))).toEqual(before);
  });

  it("recovers when the table exists but the ledger entry is missing, keeping sidecar rows", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    await db.execute(
      "INSERT INTO sync_identity (id, device_id, device_name, physical_ms, counter) VALUES (1, 'dev:x', 'Laptop', 99, 3)",
    );
    await db.execute("DELETE FROM schema_migrations WHERE id = 42");
    await runMigrations(db);
    expect(await db.select("SELECT id FROM schema_migrations WHERE id = 42")).toHaveLength(1);
    expect(await db.select("SELECT device_id, physical_ms, counter FROM sync_identity")).toEqual([
      { device_id: "dev:x", physical_ms: 99, counter: 3 },
    ]);
  });
});
