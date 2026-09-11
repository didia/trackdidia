import { migrations } from "../tauri-sqlite-repository";

describe("migration 29 add_email_triage_foundation", () => {
  it("adds source_url, email triage tables, and query indexes without rewriting earlier migrations", () => {
    const migration = migrations.find((item) => item.id === 29);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_email_triage_foundation");
    expect(migration?.sql).toContain("ALTER TABLE gtd_tasks ADD COLUMN source_url TEXT");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS email_triage_accounts");
    expect(migration?.sql).toContain("idx_email_triage_reviews_status");
    expect(migration?.sql).toContain("idx_email_triage_reviews_pending_message");
    expect(migration?.sql).toContain("idx_email_triage_effects_conversation_status");
    expect(migration?.sql).toContain("idx_email_triage_attempts_message");
    expect(migration?.sql).toContain("idx_email_triage_audit_account_created");
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort((left, right) => left - right),
    );
  });
});
