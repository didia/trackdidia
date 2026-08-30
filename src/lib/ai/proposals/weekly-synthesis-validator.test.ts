import { validateWeeklySynthesisResponse } from "./weekly-synthesis-validator";

describe("validateWeeklySynthesisResponse", () => {
  const validPayload = {
    headline: "Semaine solide",
    scoreExplanation: "Le score reflete une bonne discipline.",
    strongestAxis: "Discipline",
    weakestAxes: ["Temps d'ecran", "Pomodoris"],
    sectionDrafts: { bilan: "Note de bilan" },
    nextWeekObjectives: [
      {
        title: "Deep work",
        kind: "manual",
        targetHours: null,
        rescuetimeKind: null,
        rescuetimeThing: null
      }
    ],
    gtdActions: [{ taskId: "task-1", action: "defer", reason: "Stale" }]
  };

  it("accepts a valid weekly synthesis payload", () => {
    const result = validateWeeklySynthesisResponse(validPayload);
    expect(result.ok).toBe(true);
  });

  it("rejects fewer or more than two weakestAxes", () => {
    expect(validateWeeklySynthesisResponse({ ...validPayload, weakestAxes: ["One"] }).ok).toBe(false);
    expect(
      validateWeeklySynthesisResponse({ ...validPayload, weakestAxes: ["One", "Two", "Three"] }).ok
    ).toBe(false);
  });

  it("rejects more than five nextWeekObjectives", () => {
    const objectives = Array.from({ length: 6 }, (_, index) => ({
      title: `Objective ${index}`,
      kind: "manual" as const,
      targetHours: null,
      rescuetimeKind: null,
      rescuetimeThing: null
    }));

    expect(validateWeeklySynthesisResponse({ ...validPayload, nextWeekObjectives: objectives }).ok).toBe(false);
  });

  it("rejects invalid time objectives", () => {
    expect(
      validateWeeklySynthesisResponse({
        ...validPayload,
        nextWeekObjectives: [
          {
            title: "Bad time",
            kind: "time",
            targetHours: 0,
            rescuetimeKind: "category",
            rescuetimeThing: "Work"
          }
        ]
      }).ok
    ).toBe(false);

    expect(
      validateWeeklySynthesisResponse({
        ...validPayload,
        nextWeekObjectives: [
          {
            title: "Bad time",
            kind: "time",
            targetHours: 2,
            rescuetimeKind: null,
            rescuetimeThing: null
          }
        ]
      }).ok
    ).toBe(false);
  });

  it("normalizes manual objectives to null RescueTime fields", () => {
    const result = validateWeeklySynthesisResponse({
      ...validPayload,
      nextWeekObjectives: [
        {
          title: "Budget review",
          kind: "manual",
          targetHours: 3,
          rescuetimeKind: "category",
          rescuetimeThing: "Work"
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nextWeekObjectives[0]).toEqual({
        title: "Budget review",
        kind: "manual",
        targetHours: null,
        rescuetimeKind: null,
        rescuetimeThing: null
      });
    }
  });
});
