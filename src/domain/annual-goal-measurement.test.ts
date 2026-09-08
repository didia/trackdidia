import { createEmptyAnnualGoal } from "./annual-goals";
import {
  buildWeekPeriodKeysForYear,
  computeAnnualGoalExpectedRatio,
  computeAnnualGoalMeasurement,
} from "./annual-goal-measurement";
import { createEmptyDailyEntry, updatePrinciple } from "./daily-entry";
import type { AnnualGoal, DailyEntry } from "./types";

const emptySourceValues = { currentValue: null, monthlyValues: [] };

const noEntries: DailyEntry[] = [];

describe("computeAnnualGoalMeasurement — binary", () => {
  it("reports 0/1 currentValue from status, not from milestones", () => {
    const notAchieved = createEmptyAnnualGoal({ measurementType: "binary", status: "active" });
    const result = computeAnnualGoalMeasurement(
      notAchieved,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );
    expect(result.currentValue).toBe(0);
    expect(result.progressRatio).toBe(0);

    const achieved = createEmptyAnnualGoal({ measurementType: "binary", status: "achieved" });
    const achievedResult = computeAnnualGoalMeasurement(
      achieved,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );
    expect(achievedResult.currentValue).toBe(1);
    expect(achievedResult.progressRatio).toBe(1);
    expect(achievedResult.measurement.onPace).toBe(true);
  });

  it("reports milestone progress separately and never folds it into progressRatio", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "binary",
      status: "active",
      milestones: [
        { id: "m1", title: "CV pret", completedAt: "2026-01-01", sortOrder: 0 },
        { id: "m2", title: "Candidatures", completedAt: "2026-02-01", sortOrder: 1 },
        { id: "m3", title: "Entretiens", completedAt: "2026-03-01", sortOrder: 2 },
        { id: "m4", title: "Offre", completedAt: null, sortOrder: 3 },
        { id: "m5", title: "Signature", completedAt: null, sortOrder: 4 },
      ],
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.progressRatio).toBe(0);
    expect(result.measurement.milestoneProgressRatio).toBeCloseTo(0.6);
    expect(result.measurement.milestonesCompleted).toBe(3);
    expect(result.measurement.milestonesTotal).toBe(5);
  });

  it("never manufactures a pacing percentage without milestones, and only turns off-pace once the deadline passes", () => {
    const goalWithoutDeadline = createEmptyAnnualGoal({ measurementType: "binary" });
    expect(computeAnnualGoalExpectedRatio(goalWithoutDeadline, 2026, "2026-06-01")).toBeNull();
    const withoutDeadlineResult = computeAnnualGoalMeasurement(
      goalWithoutDeadline,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );
    expect(withoutDeadlineResult.measurement.onPace).toBe(true);

    const goalWithDeadline = createEmptyAnnualGoal({
      measurementType: "binary",
      deadline: "2026-06-01",
    });
    expect(computeAnnualGoalExpectedRatio(goalWithDeadline, 2026, "2026-06-01")).toBeNull();
    const beforeDeadline = computeAnnualGoalMeasurement(
      goalWithDeadline,
      2026,
      "2026-05-01",
      emptySourceValues,
      noEntries,
    );
    expect(beforeDeadline.measurement.onPace).toBe(true);

    const afterDeadline = computeAnnualGoalMeasurement(
      goalWithDeadline,
      2026,
      "2026-06-02",
      emptySourceValues,
      noEntries,
    );
    expect(afterDeadline.measurement.onPace).toBe(false);
  });
});

describe("computeAnnualGoalMeasurement — numeric", () => {
  it("reproduces the stated 60% weight-loss example with a baseline", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "numeric",
      startingValue: 195,
      targetValue: 175,
      manualCurrentValue: 183,
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.progressRatio).toBeCloseTo(0.6);
    expect(result.measurement.direction).toBe("decrease");
  });

  it("reproduces legacy current/target when there is no baseline", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "numeric",
      targetValue: 100,
      manualCurrentValue: 60,
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.progressRatio).toBeCloseTo(0.6);
  });

  it("computes target/current when direction is explicitly decrease and there is no baseline", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "numeric",
      direction: "decrease",
      targetValue: 60,
      manualCurrentValue: 120,
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.progressRatio).toBeCloseTo(0.5);
  });

  it("falls back to the direct ratio when the baseline equals the target (guard)", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "numeric",
      startingValue: 100,
      targetValue: 100,
      manualCurrentValue: 50,
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.progressRatio).toBeCloseTo(0.5);
  });

  it("treats a decrease-to-zero goal with no baseline as achieved once current reaches 0", () => {
    const achievedGoal = createEmptyAnnualGoal({
      measurementType: "numeric",
      direction: "decrease",
      targetValue: 0,
      manualCurrentValue: 0,
    });

    const achieved = computeAnnualGoalMeasurement(
      achievedGoal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(achieved.progressRatio).toBe(1);
  });

  it("reports null (not 0) progress for a decrease-to-zero goal with no baseline before it is achieved", () => {
    const inProgressGoal = createEmptyAnnualGoal({
      measurementType: "numeric",
      direction: "decrease",
      targetValue: 0,
      manualCurrentValue: 5,
    });

    const inProgress = computeAnnualGoalMeasurement(
      inProgressGoal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(inProgress.progressRatio).toBeNull();
  });

  it("floors at 0 but leaves progress uncapped above 1", () => {
    const overshootGoal = createEmptyAnnualGoal({
      measurementType: "numeric",
      startingValue: 195,
      targetValue: 175,
      manualCurrentValue: 165,
    });
    const overshoot = computeAnnualGoalMeasurement(
      overshootGoal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );
    expect(overshoot.progressRatio).toBeGreaterThan(1);

    const worseGoal = createEmptyAnnualGoal({
      measurementType: "numeric",
      startingValue: 195,
      targetValue: 175,
      manualCurrentValue: 210,
    });
    const worse = computeAnnualGoalMeasurement(
      worseGoal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );
    expect(worse.progressRatio).toBe(0);
  });
});

describe("computeAnnualGoalMeasurement — cumulative", () => {
  it("builds a running total across months, including empty months", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "cumulative",
      targetValue: 24,
      progressLog: { "2026-01": 2, "2026-03": 3 },
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-06-01",
      emptySourceValues,
      noEntries,
    );

    expect(result.currentValue).toBe(5);
    expect(result.progressRatio).toBeCloseTo(5 / 24);
    const byMonth = Object.fromEntries(
      result.monthlyProgress.map((point) => [point.monthKey, point.value]),
    );
    expect(byMonth["2026-01"]).toBe(2);
    expect(byMonth["2026-02"]).toBe(2);
    expect(byMonth["2026-03"]).toBe(5);
    expect(byMonth["2026-12"]).toBe(5);
  });

  it("accumulates a source's independent monthly values into a running total", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "cumulative",
      sourceId: "daily_pomodoris_sum",
      targetValue: 100,
    });

    const sourceValues = {
      currentValue: 30,
      monthlyValues: [
        { monthKey: "2026-01", value: 10 },
        { monthKey: "2026-02", value: null },
        { monthKey: "2026-03", value: 20 },
      ],
    };

    const result = computeAnnualGoalMeasurement(goal, 2026, "2026-06-01", sourceValues, noEntries);

    expect(result.monthlyProgress).toEqual([
      { monthKey: "2026-01", value: 10 },
      { monthKey: "2026-02", value: 10 },
      { monthKey: "2026-03", value: 30 },
    ]);
  });
});

describe("computeAnnualGoalMeasurement — recurring", () => {
  const buildEntriesWithPrinciple = (dates: string[]): DailyEntry[] =>
    dates.map((date) => updatePrinciple(createEmptyDailyEntry(date), "respectTrc", true));

  it("computes adherence over elapsed periods and exposes the partly-elapsed current period", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
      progressLog: { "2026-01": 3, "2026-02": 1, "2026-03": 4 },
    });

    // asOfDate is mid-April: Jan/Feb/Mar are elapsed, April is the current (in-progress) period.
    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-04-15",
      emptySourceValues,
      noEntries,
    );

    expect(result.measurement.periodsElapsed).toBe(3);
    expect(result.measurement.periodsMet).toBe(2);
    expect(result.measurement.adherenceRatio).toBeCloseTo(2 / 3);
    expect(result.measurement.currentPeriodKey).toBe("2026-04");
    expect(result.measurement.currentPeriodCount).toBeNull();
    expect(result.progressRatio).toBeCloseTo(2 / 3);
  });

  it("does not break the streak on a trailing unlogged period", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
      // February has no entry at all (not even 0) — it should be skipped, not treated as a miss,
      // because it is the trailing period right before "now".
      progressLog: { "2026-01": 4 },
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-03-15",
      emptySourceValues,
      noEntries,
    );

    // Jan (met) and Feb (unlogged, trailing) elapsed; Feb is skipped so the streak still counts Jan.
    expect(result.measurement.periodsElapsed).toBe(2);
    expect(result.measurement.currentStreak).toBe(1);
  });

  it("breaks the streak on an explicitly missed period, even if it is trailing", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
      progressLog: { "2026-01": 4, "2026-02": 0 },
    });

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-03-15",
      emptySourceValues,
      noEntries,
    );

    expect(result.measurement.currentStreak).toBe(0);
  });

  it("derives per-period counts from a bound principle when no manual log entry exists", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
      principleKey: "respectTrc",
    });

    const entries = buildEntriesWithPrinciple(["2026-01-05", "2026-01-12", "2026-01-20"]);

    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-02-01",
      emptySourceValues,
      entries,
    );

    expect(result.measurement.periodsElapsed).toBe(1);
    expect(result.measurement.periodsMet).toBe(1);
  });

  it("enumerates week periods that straddle the year boundary", () => {
    const keys = buildWeekPeriodKeysForYear(2026);
    expect(keys[0] <= "2026-01-01").toBe(true);
    expect(keys[keys.length - 1] <= "2026-12-31").toBe(true);
    expect(keys[keys.length - 1] >= "2026-12-25").toBe(true);
  });

  it("treats a null or zero cadenceTarget as never met, without crashing", () => {
    const nullTargetGoal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: null,
      progressLog: { "2026-01": 5 },
    });
    const nullResult = computeAnnualGoalMeasurement(
      nullTargetGoal,
      2026,
      "2026-02-01",
      emptySourceValues,
      noEntries,
    );
    expect(nullResult.measurement.periodsMet).toBe(0);
    expect(nullResult.measurement.adherenceRatio).toBe(0);

    const zeroTargetGoal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 0,
      progressLog: { "2026-01": 5 },
    });
    const zeroResult = computeAnnualGoalMeasurement(
      zeroTargetGoal,
      2026,
      "2026-02-01",
      emptySourceValues,
      noEntries,
    );
    expect(zeroResult.measurement.periodsMet).toBe(0);
  });

  it("always uses 1 as the recurring pacing expectation", () => {
    const goal: AnnualGoal = createEmptyAnnualGoal({ measurementType: "recurring" });
    expect(computeAnnualGoalExpectedRatio(goal, 2026, "2026-06-01")).toBe(1);
  });

  it("reports on pace, not off pace, when no period has elapsed yet", () => {
    const goal = createEmptyAnnualGoal({
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
    });

    // Mid-January: the first month is still the in-progress current period, so nothing has
    // elapsed yet. Nothing has been missed — this must not read as "off pace".
    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      "2026-01-15",
      emptySourceValues,
      noEntries,
    );

    expect(result.measurement.periodsElapsed).toBe(0);
    expect(result.measurement.adherenceRatio).toBeNull();
    expect(result.measurement.onPace).toBe(true);
  });
});
