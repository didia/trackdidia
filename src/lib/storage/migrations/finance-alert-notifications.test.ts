import { migrations } from "./index";

describe("migration 39 create_finance_alert_notifications", () => {
  it("creates the alert notification ledger, is purely additive, and touches no pre-existing table", () => {
    const migration = migrations.find((item) => item.id === 39);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("create_finance_alert_notifications");
    expect(migration?.sql).not.toContain("ALTER TABLE");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS finance_alert_notifications");
    expect(migration?.sql).toContain("PRIMARY KEY (alert_key, notified_on_date)");
  });

  it("is the next free id after migration 38", () => {
    const ids = migrations.map((item) => item.id);
    expect(ids).toContain(39);
    expect(ids).toContain(38);
  });
});
