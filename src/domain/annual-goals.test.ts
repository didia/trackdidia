import {
  addAnnualGoalMilestone,
  annualGoalPrincipleOptions,
  buildAnnualGoalSnapshots,
  cloneAnnualGoal,
  computeAnnualGoalExpectedRatio,
  computeYearProgressFraction,
  createEmptyAnnualGoal,
  isAnnualGoalOnPace,
  removeAnnualGoalMilestone,
  setAnnualGoalProgressLogEntry,
  updateAnnualGoalEvaluation,
  updateAnnualGoalMilestone,
} from "./annual-goals";
import { createEmptyDailyEntry, updateMetric, updatePrinciple } from "./daily-entry";
import type { WeeklyReviewSummary } from "./types";

describe("annual goals domain", () => {
  it("builds goal snapshots from linked weekly and daily sources", () => {
    const goals = [
      createEmptyAnnualGoal({
        id: "goal-1",
        title: "Sommeil",
        sourceId: "weekly_sleep_average",
        targetValue: 80,
        unit: "/100",
      }),
      createEmptyAnnualGoal({
        id: "goal-2",
        title: "TRC",
        sourceId: "daily_respect_trc_rate",
        targetValue: 90,
        unit: "%",
      }),
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
        calorieAverage: 0,
        physicalActivity: 0,
        productivityPulse: null,
        rescueTimeGoalsScore: null,
        weeklyScore: 0.5,
        days: [],
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
        calorieAverage: 0,
        physicalActivity: 0,
        productivityPulse: null,
        rescueTimeGoalsScore: null,
        weeklyScore: 0.55,
        days: [],
      },
    ];

    const snapshots = buildAnnualGoalSnapshots(goals, 2026, entries, weeklySummaries);

    expect(snapshots[0].currentValue).toBe(81);
    expect(snapshots[0].monthlyProgress.find((point) => point.monthKey === "2026-01")?.value).toBe(
      78,
    );
    expect(snapshots[1].currentValue).toBeCloseTo((2 / 3) * 100);
  });

  it("updates monthly evaluation immutably", () => {
    const goal = createEmptyAnnualGoal({
      id: "goal-1",
      title: "Focus",
    });

    const updated = updateAnnualGoalEvaluation(goal, "2026-04", {
      score: 80,
      notes: "Bon mois",
    });

    expect(goal.evaluations["2026-04"]).toBeUndefined();
    expect(updated.evaluations["2026-04"]).toMatchObject({
      score: 80,
      notes: "Bon mois",
    });
  });

  it("computes year progress fraction and on-pace status", () => {
    const midYear = computeYearProgressFraction(2026, "2026-07-01");
    expect(midYear).toBeGreaterThan(0.4);
    expect(midYear).toBeLessThan(0.6);
    expect(isAnnualGoalOnPace(0.55, midYear)).toBe(true);
    expect(isAnnualGoalOnPace(0.2, midYear)).toBe(false);
  });

  it("defaults the new measurement fields on an empty goal", () => {
    const goal = createEmptyAnnualGoal({ id: "goal-1", title: "Nouveau" });

    expect(goal.measurementType).toBe("numeric");
    expect(goal.status).toBe("active");
    expect(goal.deadline).toBeNull();
    expect(goal.startingValue).toBeNull();
    expect(goal.direction).toBeNull();
    expect(goal.cadenceTarget).toBeNull();
    expect(goal.cadencePeriod).toBe("week");
    expect(goal.principleKey).toBeNull();
    expect(goal.progressLog).toEqual({});
    expect(goal.milestones).toEqual([]);
  });

  it("deep-clones progressLog and milestones so drafts cannot alias saved state", () => {
    const goal = createEmptyAnnualGoal({
      id: "goal-1",
      progressLog: { "2026-01": 2 },
      milestones: [{ id: "m1", title: "Etape", completedAt: null, sortOrder: 0 }],
    });

    const cloned = cloneAnnualGoal(goal);
    cloned.progressLog["2026-01"] = 99;
    cloned.milestones[0].title = "Modifie";

    expect(goal.progressLog["2026-01"]).toBe(2);
    expect(goal.milestones[0].title).toBe("Etape");
  });

  it("sets and clears progress log entries immutably", () => {
    const goal = createEmptyAnnualGoal({ id: "goal-1" });

    const withEntry = setAnnualGoalProgressLogEntry(goal, "2026-01", 4);
    expect(goal.progressLog["2026-01"]).toBeUndefined();
    expect(withEntry.progressLog["2026-01"]).toBe(4);

    const cleared = setAnnualGoalProgressLogEntry(withEntry, "2026-01", null);
    expect(cleared.progressLog["2026-01"]).toBeUndefined();
  });

  it("adds, updates, and removes milestones immutably with an assigned sortOrder", () => {
    const goal = createEmptyAnnualGoal({ id: "goal-1" });

    const withFirst = addAnnualGoalMilestone(goal, "Premiere etape");
    expect(goal.milestones).toEqual([]);
    expect(withFirst.milestones).toHaveLength(1);
    expect(withFirst.milestones[0]).toMatchObject({ title: "Premiere etape", sortOrder: 0 });

    const withSecond = addAnnualGoalMilestone(withFirst, "Deuxieme etape");
    expect(withSecond.milestones[1]).toMatchObject({ title: "Deuxieme etape", sortOrder: 1 });

    const milestoneId = withSecond.milestones[0].id;
    const completed = updateAnnualGoalMilestone(withSecond, milestoneId, {
      completedAt: "2026-03-01",
    });
    expect(completed.milestones[0].completedAt).toBe("2026-03-01");
    expect(completed.milestones[1].completedAt).toBeNull();

    const removed = removeAnnualGoalMilestone(completed, milestoneId);
    expect(removed.milestones).toHaveLength(1);
    expect(removed.milestones[0].title).toBe("Deuxieme etape");
  });

  it("returns 1 as the recurring pacing expectation and the deadline fraction when a deadline is set", () => {
    const recurringGoal = createEmptyAnnualGoal({ id: "goal-1", measurementType: "recurring" });
    expect(computeAnnualGoalExpectedRatio(recurringGoal, 2026, "2026-06-01")).toBe(1);

    const numericGoalWithDeadline = createEmptyAnnualGoal({
      id: "goal-2",
      measurementType: "numeric",
      deadline: "2026-07-01",
    });
    // Halfway between Jan 1 and Jul 1 (2026-04-01 is not exactly halfway, but must land strictly
    // between the two bounds and must differ from the full-year fraction).
    const deadlineFraction = computeAnnualGoalExpectedRatio(
      numericGoalWithDeadline,
      2026,
      "2026-04-01",
    );
    const yearFraction = computeYearProgressFraction(2026, "2026-04-01");
    expect(deadlineFraction).not.toBeNull();
    expect(deadlineFraction).toBeGreaterThan(0);
    expect(deadlineFraction).toBeLessThan(1);
    expect(deadlineFraction).not.toBeCloseTo(yearFraction as number);
  });

  it("resolves every principle option to a translated label instead of a raw i18n key", () => {
    expect(annualGoalPrincipleOptions.length).toBeGreaterThan(0);
    for (const option of annualGoalPrincipleOptions) {
      expect(option.label.startsWith("habit.")).toBe(false);
    }
  });
});
