import { createEmptyDailyEntry, updateMetric, updatePrinciple } from "./daily-entry";
import { buildAnnualGoalSnapshots, createEmptyAnnualGoal, updateAnnualGoalEvaluation } from "./annual-goals";
import type { WeeklyReviewSummary } from "./types";

describe("annual goals domain", () => {
  it("builds goal snapshots from linked weekly and daily sources", () => {
    const goals = [
      createEmptyAnnualGoal({
        id: "goal-1",
        title: "Sommeil",
        sourceId: "weekly_sleep_average",
        targetValue: 80,
        unit: "/100"
      }),
      createEmptyAnnualGoal({
        id: "goal-2",
        title: "TRC",
        sourceId: "daily_respect_trc_rate",
        targetValue: 90,
        unit: "%"
      })
    ];

    const entries = ["2026-01-01", "2026-01-02", "2026-02-01"].map((date, index) => {
      let entry = createEmptyDailyEntry(date);
      entry = updateMetric(entry, "qualiteSommeil", 70 + index * 5);
      entry = updatePrinciple(entry, "respectTrc", index < 2);
      return entry;
    });

    const weeklySummaries: WeeklyReviewSummary[] = [
      {
        weekStartDate: "2026-01-04",
        weekEndDate: "2026-01-10",
        sleepAverage: 78,
        sleepQuality: 78,
        trcDaysRespected: 5,
        respectTrc: 71,
        screenTimeTotalMinutes: 0,
        phoneScreenTime: 0,
        pomodorisTotal: 0,
        pomodoris: 0,
        disciplineAverage: 0,
        discipline: 0,
        tasksAddedTotal: 0,
        tasksCompletedTotal: 0,
        tasksCompletionRate: 0,
        weeklyScore: 0.5,
        days: []
      },
      {
        weekStartDate: "2026-02-01",
        weekEndDate: "2026-02-07",
        sleepAverage: 84,
        sleepQuality: 84,
        trcDaysRespected: 4,
        respectTrc: 57,
        screenTimeTotalMinutes: 0,
        phoneScreenTime: 0,
        pomodorisTotal: 0,
        pomodoris: 0,
        disciplineAverage: 0,
        discipline: 0,
        tasksAddedTotal: 0,
        tasksCompletedTotal: 0,
        tasksCompletionRate: 0,
        weeklyScore: 0.55,
        days: []
      }
    ];

    const snapshots = buildAnnualGoalSnapshots(goals, 2026, entries, weeklySummaries);

    expect(snapshots[0].currentValue).toBe(81);
    expect(snapshots[0].monthlyProgress.find((point) => point.monthKey === "2026-01")?.value).toBe(78);
    expect(snapshots[1].currentValue).toBeCloseTo((2 / 3) * 100);
  });

  it("updates monthly evaluation immutably", () => {
    const goal = createEmptyAnnualGoal({
      id: "goal-1",
      title: "Focus"
    });

    const updated = updateAnnualGoalEvaluation(goal, "2026-04", {
      score: 80,
      notes: "Bon mois"
    });

    expect(goal.evaluations["2026-04"]).toBeUndefined();
    expect(updated.evaluations["2026-04"]).toMatchObject({
      score: 80,
      notes: "Bon mois"
    });
  });
});
