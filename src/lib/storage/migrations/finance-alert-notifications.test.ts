import { migrations } from "../tauri-sqlite-repository";

describe("migration 38 create_finance_alert_notifications", () => {
  it("creates the alert notification ledger, is purely additive, and touches no pre-existing table", () => {
    const migration = migrations.find((item) => item.id === 38);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("create_finance_alert_notifications");
    expect(migration?.sql).not.toContain("ALTER TABLE");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS finance_alert_notifications");
    expect(migration?.sql).toContain("PRIMARY KEY (alert_key, notified_on_date)");
  });

  it("is the next free id after migration 37", () => {
    const ids = migrations.map((item) => item.id);
    expect(Math.max(...ids)).toBe(38);
    expect(ids).toContain(37);
  });
});
