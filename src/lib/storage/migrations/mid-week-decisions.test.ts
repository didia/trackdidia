import { describe, expect, it } from "vitest";
import { migrations } from "./index";

describe("migration 36 create_mid_week_decisions", () => {
  it("creates the per-week decisions table", () => {
    const migration = migrations.find((item) => item.id === 36);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("create_mid_week_decisions");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS mid_week_decisions");
    expect(migration?.sql).toContain("week_start_date TEXT PRIMARY KEY");
    expect(migration?.sql).toContain("lagging_snapshot_json TEXT");
  });
});
