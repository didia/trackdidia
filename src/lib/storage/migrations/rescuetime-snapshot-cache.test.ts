import { describe, expect, it } from "vitest";
import { migrations } from "./index";

describe("migration 35 create_rescuetime_snapshot_cache", () => {
  it("creates the cache table keyed by week, kind and credential fingerprint", () => {
    const migration = migrations.find((item) => item.id === 35);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("create_rescuetime_snapshot_cache");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS rescuetime_snapshot_cache");
    expect(migration?.sql).toContain("PRIMARY KEY (week_start_date, kind, credential_fingerprint)");
  });
});
