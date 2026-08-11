import {
  buildWeeklyObjectivesSnapshot,
  computeWeeklyObjectivesScore,
  createEmptyWeeklyObjective,
  scoreManualObjective,
  scoreTimeObjective
} from "./weekly-objectives";
import type { WeeklyObjectiveResult } from "./types";

describe("weekly-objectives scoring", () => {
  it("scores fractional time objectives and caps at 1", () => {
    expect(scoreTimeObjective(1, 2)).toBe(0.5);
    expect(scoreTimeObjective(3, 2)).toBe(1);
    expect(scoreTimeObjective(null, 2)).toBe(0);
    expect(scoreTimeObjective(1, 0)).toBe(0);
  });

  it("scores manual objectives as binary", () => {
    expect(scoreManualObjective(true)).toBe(1);
    expect(scoreManualObjective(false)).toBe(0);
  });

  it("computes aggregate score as average achievement", () => {
    expect(computeWeeklyObjectivesScore([1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1])).toBe(0.95);
    expect(computeWeeklyObjectivesScore([])).toBeNull();
  });

  it("builds a mixed snapshot with manual and time objectives", () => {
    const timeObjective = createEmptyWeeklyObjective({
      id: "time-1",
      title: "Software Development",
      kind: "time",
      targetHours: 2,
      rescuetimeKind: "category",
      rescuetimeThing: "Software Development"
    });
    const manualObjective = createEmptyWeeklyObjective({
      id: "manual-1",
      title: "Budget review",
      kind: "manual"
    });
    const results: WeeklyObjectiveResult[] = [
      {
        weekStartDate: "2026-08-02",
        objectiveId: "manual-1",
        achieved: true,
        updatedAt: "2026-08-09T12:00:00.000Z"
      }
    ];

    const snapshot = buildWeeklyObjectivesSnapshot(
      "2026-08-02",
      [timeObjective, manualObjective],
      results,
      { "time-1": 3600 },
      { rescuetimeConfigured: true }
    );

    expect(snapshot.weekStartDate).toBe("2026-08-02");
    expect(snapshot.weekEndDate).toBe("2026-08-08");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find((item) => item.objective.id === "time-1")).toMatchObject({
      objective: timeObjective,
      actualHours: 1,
      achievement: 0.5,
      source: "rescuetime"
    });
    expect(snapshot.items.find((item) => item.objective.id === "manual-1")).toMatchObject({
      objective: manualObjective,
      achievement: 1,
      source: "manual"
    });
    expect(snapshot.totalAchievement).toBe(1.5);
    expect(snapshot.score).toBe(0.75);
  });
});
