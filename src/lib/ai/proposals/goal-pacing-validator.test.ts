import { validateGoalPacingResponse } from "./goal-pacing-validator";

describe("validateGoalPacingResponse", () => {
  const validPayload = {
    goals: [
      {
        goalId: "goal-1",
        onPace: true,
        gap: "En avance de 5 points.",
        requiredWeeklyBehaviour: "Maintenir le rythme actuel.",
        riskLevel: "low",
        recommendation: "Conserver la cadence.",
      },
    ],
  };

  it("accepts a valid goal pacing payload", () => {
    const result = validateGoalPacingResponse(validPayload);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid risk level", () => {
    expect(
      validateGoalPacingResponse({
        goals: [{ ...validPayload.goals[0], riskLevel: "critical" }],
      }).ok,
    ).toBe(false);
  });
});
