import { validateMonthlySynthesisResponse } from "./monthly-synthesis-validator";

describe("validateMonthlySynthesisResponse", () => {
  const validPayload = {
    headline: "Mois solide",
    weekPattern: "Score stable sur quatre semaines.",
    sectionDrafts: { bilan: "Note de bilan" },
    goalEvaluationDrafts: [
      {
        goalId: "goal-1",
        score: 75,
        trend: "up",
        notes: "Bonne progression",
        blockers: ""
      }
    ]
  };

  it("accepts a valid monthly synthesis payload", () => {
    const result = validateMonthlySynthesisResponse(validPayload);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid section keys", () => {
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        sectionDrafts: { invalid: "x" }
      }).ok
    ).toBe(false);
  });

  it("rejects invalid goal evaluation trend", () => {
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], trend: "sideways" }]
      }).ok
    ).toBe(false);
  });

  it("accepts score boundaries 0 and 100", () => {
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], score: 0 }]
      }).ok
    ).toBe(true);
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], score: 100 }]
      }).ok
    ).toBe(true);
  });

  it("rejects scores outside 0-100", () => {
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], score: -1 }]
      }).ok
    ).toBe(false);
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], score: 101 }]
      }).ok
    ).toBe(false);
    expect(
      validateMonthlySynthesisResponse({
        ...validPayload,
        goalEvaluationDrafts: [{ ...validPayload.goalEvaluationDrafts[0], score: 0.82 }]
      }).ok
    ).toBe(true);
  });
});
