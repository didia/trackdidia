import { migrations } from "../tauri-sqlite-repository";

describe("migration 25 ai_proposals index", () => {
  it("allows multiple pending proposals of the same weekly type on one message", () => {
    const migration = migrations.find((item) => item.id === 25);
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("review_section_draft");
    expect(migration?.sql).toContain("weekly_objective");
    expect(migration?.sql).toContain("gtd_action");
    expect(migration?.sql).toContain("memory");
    expect(migration?.sql).toMatch(
      /type NOT IN \('memory', 'review_section_draft', 'weekly_objective', 'gtd_action'\)/,
    );
  });
});

describe("migration 27 ai_proposals index", () => {
  it("allows multiple pending goal_evaluation proposals on one monthly message", () => {
    const migration = migrations.find((item) => item.id === 27);
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("goal_evaluation");
    expect(migration?.sql).toMatch(
      /type NOT IN \(\s*'memory', 'review_section_draft', 'weekly_objective', 'gtd_action', 'goal_evaluation'\s*\)/,
    );
  });

  it("still enforces at most one pending goal_evaluation proposal per goal on one message", () => {
    const migration = migrations.find((item) => item.id === 27);
    expect(migration).toBeDefined();
    expect(migration?.sql).toContain("idx_ai_proposals_message_goal");
    expect(migration?.sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_goal\s+ON ai_proposals \(message_id, json_extract\(payload_json, '\$\.goalId'\)\)\s+WHERE status = 'pending' AND type = 'goal_evaluation'/,
    );
  });
});
