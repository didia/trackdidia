import { migrations, TauriSqliteRepository } from "../tauri-sqlite-repository";

// Minimal fake standing in for the native `Database` wrapper: only `select` is exercised by
// the idempotency guard, so a real Tauri connection is not required for this unit test.
const fakeDbWithColumns = (columnNames: string[]) => ({
  select: async () => columnNames.map((name) => ({ name })),
});

describe("migration 26 add_gtd_task_planned_order", () => {
  it("appends planned_order without rewriting earlier migrations", () => {
    expect(migrations.map((migration) => migration.id)).toEqual(expect.arrayContaining([25, 26]));
    expect(Math.max(...migrations.map((migration) => migration.id))).toBe(26);
  });

  it("adds the column, the partial index, and normalizes non-planned rows", () => {
    const migration = migrations.find((item) => item.id === 26);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_gtd_task_planned_order");
    expect(migration?.sql).toContain("ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER");
    expect(migration?.sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_tasks_project_planned_order\s+ON gtd_tasks \(project_id, planned_order\)\s+WHERE bucket = 'planned' AND status = 'active'/,
    );
    expect(migration?.sql).toContain(
      "UPDATE gtd_tasks SET planned_order = NULL WHERE bucket != 'planned'",
    );
  });

  it("has a unique, strictly increasing id relative to every other migration", () => {
    const ids = migrations.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
  });

  it("safely re-resolves as a no-op ALTER when an interrupted process already added the column", async () => {
    const repository = new TauriSqliteRepository();
    const migration = migrations.find((item) => item.id === 26)!;

    // Simulate a database where `ALTER TABLE ... ADD COLUMN planned_order` already
    // succeeded (e.g. the process was killed before `schema_migrations` recorded it).
    const interruptedDb = fakeDbWithColumns(["id", "title", "planned_order"]);
    const resolvedSql = await (
      repository as unknown as {
        resolveIdempotentMigrationSql: (db: unknown, migration: unknown) => Promise<string>;
      }
    ).resolveIdempotentMigrationSql(interruptedDb, migration);

    expect(resolvedSql).not.toContain("ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER");
    expect(resolvedSql).toContain("CREATE INDEX IF NOT EXISTS idx_tasks_project_planned_order");
    expect(resolvedSql).toContain("UPDATE gtd_tasks SET planned_order = NULL");
  });

  it("keeps the ALTER TABLE statement on a fresh database that has not run migration 26 yet", async () => {
    const repository = new TauriSqliteRepository();
    const migration = migrations.find((item) => item.id === 26)!;

    const freshDb = fakeDbWithColumns(["id", "title"]);
    const resolvedSql = await (
      repository as unknown as {
        resolveIdempotentMigrationSql: (db: unknown, migration: unknown) => Promise<string>;
      }
    ).resolveIdempotentMigrationSql(freshDb, migration);

    expect(resolvedSql).toContain("ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER");
  });
});
