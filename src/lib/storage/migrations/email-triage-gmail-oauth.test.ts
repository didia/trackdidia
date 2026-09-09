import { describe, expect, it } from "vitest";
import { migrations } from "../tauri-sqlite-repository";

describe("migration 30 add_email_triage_gmail_oauth_client_id", () => {
  it("adds gmail_oauth_client_id without rewriting earlier migrations", () => {
    const migration = migrations.find((item) => item.id === 30);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_email_triage_gmail_oauth_client_id");
    expect(migration?.sql).toContain("gmail_oauth_client_id");
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort((left, right) => left - right),
    );
  });
});
