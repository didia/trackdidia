import { describe, expect, it } from "vitest";
import { migrations, weeklyObjectiveSelectColumns } from "../tauri-sqlite-repository";

describe("migration 33 add_weekly_objective_starts_on_week_start_date", () => {
  it("adds the start-week column and selects it with objective rows", () => {
    const migration = migrations.find((item) => item.id === 33);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_weekly_objective_starts_on_week_start_date");
    expect(migration?.sql).toContain(
      "ALTER TABLE weekly_objectives ADD COLUMN starts_on_week_start_date",
    );
    expect(weeklyObjectiveSelectColumns).toContain("starts_on_week_start_date");
  });
});
