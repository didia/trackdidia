import { describe, expect, it } from "vitest";
import { migrations } from "../tauri-sqlite-repository";

describe("migration 32 add_email_triage_desktop_prefs", () => {
  it("adds run_in_tray and launch_at_login columns", () => {
    const migration = migrations.find((item) => item.id === 32);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_email_triage_desktop_prefs");
    expect(migration?.sql).toContain("run_in_tray");
    expect(migration?.sql).toContain("launch_at_login");
  });
});
