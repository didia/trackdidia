import { describe, expect, it } from "vitest";
import { applyClassifierThresholds, parseClassifierJson } from "./classifier-schema";

describe("email triage classifier schema", () => {
  it("rejects unexpected fields and conflicting cross-fields", () => {
    const result = parseClassifierJson(
      JSON.stringify({
        decision: "relevant",
        relevance: null,
        ignoreReason: "newsletter",
        confidence: 0.95,
        summary: "s",
        rationale: "r",
        suggestedTaskTitle: "t",
        extra: true,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("unexpected_field:extra");
  });

  it("routes low-confidence relevant to review", () => {
    const decision = applyClassifierThresholds({
      output: {
        decision: "relevant",
        relevance: "action_required",
        ignoreReason: null,
        confidence: 0.5,
        summary: "",
        rationale: "",
        suggestedTaskTitle: "",
      },
      reviewReasons: [],
    });
    expect(decision).toBe("review");
  });
});
