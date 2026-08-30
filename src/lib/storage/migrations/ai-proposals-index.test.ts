import { migrations } from "../tauri-sqlite-repository";

describe("migration 25 ai_proposals index", () => {
  it("allows multiple pending proposals of the same weekly type on one message", () => {
    const migration = migrations.find((item) => item.id === 25);
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("review_section_draft");
    expect(migration?.sql).toContain("weekly_objective");
    expect(migration?.sql).toContain("gtd_action");
    expect(migration?.sql).toContain("memory");
    expect(migration?.sql).toMatch(/type NOT IN \('memory', 'review_section_draft', 'weekly_objective', 'gtd_action'\)/);
  });
});
