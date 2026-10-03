// @vitest-environment node
import { createHash } from "node:crypto";
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { migrations, resolveIdempotentMigrationSql, runMigrations, type Migration } from "./index";
import shippedMigrations from "./shipped-migrations.json";

// Captured from the repository before extraction. New migrations may be appended;
// the first 36 released IDs, names, and SQL bytes must remain identical.
it("preserves every shipped migration's id, name, and SQL bytes", () => {
  expect(
    migrations
      .slice(0, shippedMigrations.length)
      .map(({ id, name, sql }) => [id, name, createHash("sha256").update(sql).digest("hex")]),
  ).toEqual(shippedMigrations);
});

it("resolves column guards generically and retains repeatable statements", async () => {
  const migration: Migration = {
    id: 999,
    name: "future_columns",
    sql: "ALTER TABLE tasks ADD COLUMN first TEXT; ALTER TABLE tasks ADD COLUMN second TEXT; SELECT 42;",
    guards: {
      skipIfColumnExists: [
        { table: "tasks", column: "first", statement: "ALTER TABLE tasks ADD COLUMN first TEXT;" },
        {
          table: "tasks",
          column: "second",
          statement: "ALTER TABLE tasks ADD COLUMN second TEXT;",
        },
      ],
    },
  };
  const db = { select: async <T>() => [{ name: "first" }] as T };
  expect(await resolveIdempotentMigrationSql(db, migration)).toBe(
    " ALTER TABLE tasks ADD COLUMN second TEXT; SELECT 42;",
  );
});

it.each([33, 34])("resolves an already-applied column-only migration %i to a no-op", async (id) => {
  const migration = migrations.find((item) => item.id === id)!;
  const column = migration.guards!.skipIfColumnExists[0].column;
  expect(
    await resolveIdempotentMigrationSql(
      { select: async <T>() => [{ name: column }] as T },
      migration,
    ),
  ).toBe("SELECT 1;");
});

it("runs the full catalog on an isolated database and skips ledgered migrations on restart", async () => {
  const db = createNodeSqliteDatabase();
  const executed = vi.fn();
  await runMigrations(db, executed);
  expect(executed).toHaveBeenCalledTimes(migrations.length - 1);
  expect(await db.select<{ id: number }[]>("SELECT id FROM schema_migrations ORDER BY id")).toEqual(
    migrations.slice(1).map(({ id }) => ({ id })),
  );
  executed.mockClear();
  await runMigrations(db, executed);
  expect(executed).not.toHaveBeenCalled();
});

it("rolls back schema changes and the ledger together if recording a migration fails", async () => {
  const db = createNodeSqliteDatabase();
  const originalExecute = db.execute.bind(db);
  const execute = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    if (sql.startsWith("INSERT OR IGNORE INTO schema_migrations")) throw new Error("ledger failed");
    return originalExecute(sql, values);
  });
  await expect(runMigrations(db)).rejects.toThrow("ledger failed");
  expect(await db.select("SELECT name FROM sqlite_master WHERE name = 'daily_entries'")).toEqual(
    [],
  );
  expect(await db.select("SELECT id FROM schema_migrations")).toEqual([]);
  execute.mockRestore();
  await runMigrations(db);
  expect(
    await db.select("SELECT name FROM sqlite_master WHERE name = 'daily_entries'"),
  ).toHaveLength(1);
});

it("recovers guarded columns already present but missing their ledger entries", async () => {
  const db = createNodeSqliteDatabase();
  await runMigrations(db);
  await db.execute("DELETE FROM schema_migrations WHERE id IN (26, 33, 34)");
  await runMigrations(db);
  const rows = await db.select<{ id: number }[]>(
    "SELECT id FROM schema_migrations WHERE id IN (26, 33, 34) ORDER BY id",
  );
  expect(rows).toEqual([{ id: 26 }, { id: 33 }, { id: 34 }]);
});
