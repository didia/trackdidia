import type { WeeklyObjectiveResult } from "./types";
import {
  buildWeeklyObjectivesSnapshot,
  computeWeeklyObjectivesScore,
  createEmptyWeeklyObjective,
  objectiveAfterManualAchievement,
  scoreManualObjective,
  scoreTimeObjective,
} from "./weekly-objectives";

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
      rescuetimeThing: "Software Development",
    });
    const manualObjective = createEmptyWeeklyObjective({
      id: "manual-1",
      title: "Budget review",
      kind: "manual",
    });
    const results: WeeklyObjectiveResult[] = [
      {
        weekStartDate: "2026-08-02",
        objectiveId: "manual-1",
        achieved: true,
        updatedAt: "2026-08-09T12:00:00.000Z",
      },
    ];

    const snapshot = buildWeeklyObjectivesSnapshot(
      "2026-08-02",
      [timeObjective, manualObjective],
      results,
      { "time-1": 3600 },
      { rescuetimeConfigured: true },
    );

    expect(snapshot.weekStartDate).toBe("2026-08-02");
    expect(snapshot.weekEndDate).toBe("2026-08-08");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find((item) => item.objective.id === "time-1")).toMatchObject({
      objective: timeObjective,
      actualHours: 1,
      achievement: 0.5,
      source: "rescuetime",
    });
    expect(snapshot.items.find((item) => item.objective.id === "manual-1")).toMatchObject({
      objective: manualObjective,
      achievement: 1,
      source: "manual",
    });
    expect(snapshot.totalAchievement).toBe(1.5);
    expect(snapshot.score).toBe(0.75);
  });

  it("hides objectives that start after the displayed week", () => {
    const later = createEmptyWeeklyObjective({
      id: "later",
      title: "Next week",
      startsOnWeekStartDate: "2026-08-09",
    });
    const current = createEmptyWeeklyObjective({
      id: "current",
      title: "This week",
      startsOnWeekStartDate: "2026-08-02",
    });
    const legacy = createEmptyWeeklyObjective({
      id: "legacy",
      title: "Always",
    });

    const beforeStart = buildWeeklyObjectivesSnapshot(
      "2026-08-02",
      [later, current, legacy],
      [],
      {},
      { rescuetimeConfigured: false },
    );
    const afterStart = buildWeeklyObjectivesSnapshot(
      "2026-08-09",
      [later, current, legacy],
      [],
      {},
      { rescuetimeConfigured: false },
    );

    expect(beforeStart.items.map((item) => item.objective.id).sort()).toEqual([
      "current",
      "legacy",
    ]);
    expect(afterStart.items.map((item) => item.objective.id).sort()).toEqual([
      "current",
      "later",
      "legacy",
    ]);
  });

  it("removes a done manual objective from the week it was achieved and every later week", () => {
    const objective = createEmptyWeeklyObjective({
      id: "manual-1",
      title: "Budget review",
      kind: "manual",
      startsOnWeekStartDate: "2026-08-02",
    });

    const achieved = objectiveAfterManualAchievement(objective, "2026-08-16", true);
    expect(achieved.endsOnWeekStartDate).toBe("2026-08-09");

    const previousWeek = buildWeeklyObjectivesSnapshot(
      "2026-08-09",
      [achieved],
      [],
      {},
      { rescuetimeConfigured: false },
    );
    const during = buildWeeklyObjectivesSnapshot(
      "2026-08-16",
      [achieved],
      [],
      {},
      { rescuetimeConfigured: false },
    );
    const nextWeek = buildWeeklyObjectivesSnapshot(
      "2026-08-23",
      [achieved],
      [],
      {},
      { rescuetimeConfigured: false },
    );

    expect(previousWeek.items.map((item) => item.objective.id)).toEqual(["manual-1"]);
    expect(during.items).toEqual([]);
    expect(nextWeek.items).toEqual([]);
    expect(objectiveAfterManualAchievement(achieved, "2026-08-16", false)).toBe(achieved);
  });

  it("keeps the earlier terminal end when a later week also marks the objective achieved", () => {
    const objective = createEmptyWeeklyObjective({
      id: "manual-1",
      title: "Budget review",
      kind: "manual",
      startsOnWeekStartDate: "2026-08-02",
    });

    const first = objectiveAfterManualAchievement(objective, "2026-08-16", true);
    expect(first.endsOnWeekStartDate).toBe("2026-08-09");

    const staleLaterWeek = objectiveAfterManualAchievement(first, "2026-08-23", true);
    expect(staleLaterWeek.endsOnWeekStartDate).toBe("2026-08-09");
    expect(staleLaterWeek).toBe(first);
  });
});
