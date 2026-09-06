import { migrations } from "../tauri-sqlite-repository";

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
});
