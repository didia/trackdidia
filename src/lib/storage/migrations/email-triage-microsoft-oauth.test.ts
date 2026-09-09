import { describe, expect, it } from "vitest";
import { migrations } from "../tauri-sqlite-repository";

describe("migration 31 add_email_triage_microsoft_oauth_client_id", () => {
  it("adds microsoft_oauth_client_id without rewriting earlier migrations", () => {
    const migration = migrations.find((item) => item.id === 31);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_email_triage_microsoft_oauth_client_id");
    expect(migration?.sql).toContain("microsoft_oauth_client_id");
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort((left, right) => left - right),
    );
  });
});
