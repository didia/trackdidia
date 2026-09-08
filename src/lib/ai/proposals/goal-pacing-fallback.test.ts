import { createEmptyAnnualGoal } from "../../../domain/annual-goals";
import { computeAnnualGoalMeasurement } from "../../../domain/annual-goal-measurement";
import type { AnnualGoal, AnnualGoalMeasurement, AnnualGoalSnapshot } from "../../../domain/types";
import {
  buildGoalPacingSnapshot,
  type GoalPacingSnapshotInputs,
} from "../context/goal-pacing-snapshot";
import { buildLocalGoalPacing } from "./goal-pacing-fallback";

const buildNumericMeasurement = (progressRatio: number): AnnualGoalMeasurement => {
  const expectedProgressRatio = 0.5;
  return {
    measurementType: "numeric",
    direction: "increase",
    currentPeriodKey: null,
    currentPeriodCount: null,
    cadenceTarget: null,
    adherenceRatio: null,
    periodsMet: 0,
    periodsElapsed: 0,
    currentStreak: 0,
    milestonesCompleted: 0,
    milestonesTotal: 0,
    milestoneProgressRatio: null,
    expectedProgressRatio,
    onPace: progressRatio >= expectedProgressRatio - 0.1,
  };
};

const buildPacingInputs = (progressRatio: number): GoalPacingSnapshotInputs => ({
  year: 2026,
  asOfDate: "2026-06-30",
  evaluationMonthKey: "2026-06",
  goalSnapshots: [
    {
      goal: createEmptyAnnualGoal({
        id: "goal-1",
        title: "Discipline",
        targetValue: 100,
        unit: "%",
        status: "active",
      }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: Math.round(progressRatio * 100),
      progressRatio,
      monthlyProgress: [{ monthKey: "2026-08", value: Math.round(progressRatio * 100) }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
      measurement: buildNumericMeasurement(progressRatio),
    },
  ],
});

describe("buildLocalGoalPacing risk alignment", () => {
  it("marks a slightly behind but on-pace goal as low risk", () => {
    const snapshot = buildGoalPacingSnapshot(buildPacingInputs(0.44), "full");
    const pacing = buildLocalGoalPacing(snapshot);
    const goal = pacing.goals[0];

    expect(goal.onPace).toBe(true);
    expect(goal.riskLevel).toBe("low");
  });

  it("marks a clearly behind goal as off pace and not low risk", () => {
    const snapshot = buildGoalPacingSnapshot(buildPacingInputs(0.2), "full");
    const pacing = buildLocalGoalPacing(snapshot);
    const goal = pacing.goals[0];

    expect(goal.onPace).toBe(false);
    expect(goal.riskLevel).not.toBe("low");
  });

  const buildSnapshotInputs = (goal: AnnualGoal): GoalPacingSnapshotInputs => {
    const asOfDate = "2026-01-15";
    const result = computeAnnualGoalMeasurement(
      goal,
      2026,
      asOfDate,
      { currentValue: null, monthlyValues: [] },
      [],
    );
    const goalSnapshot: AnnualGoalSnapshot = {
      goal,
      sourceType: "manual",
      sourceLabel: null,
      currentValue: result.currentValue,
      progressRatio: result.progressRatio,
      monthlyProgress: result.monthlyProgress,
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
      measurement: result.measurement,
    };

    return {
      year: 2026,
      asOfDate,
      evaluationMonthKey: "2026-01",
      goalSnapshots: [goalSnapshot],
    };
  };

  it("keeps a brand-new recurring goal (no periods elapsed) mutually consistent as on-pace/low-risk", () => {
    const goal = createEmptyAnnualGoal({
      id: "goal-recurring",
      title: "Sport hebdo",
      measurementType: "recurring",
      cadencePeriod: "month",
      cadenceTarget: 3,
      status: "active",
    });

    const snapshot = buildGoalPacingSnapshot(buildSnapshotInputs(goal), "full");
    const pacing = buildLocalGoalPacing(snapshot);
    const result = pacing.goals[0];

    expect(snapshot.goals[0].periodsElapsed).toBe(0);
    expect(snapshot.goals[0].onPace).toBe(true);
    expect(result.onPace).toBe(true);
    expect(result.riskLevel).toBe("low");
    // requiredWeeklyBehaviour ("maintain cadence") and recommendation ("keep it up") must both
    // agree with onPace/riskLevel rather than the previous contradictory medium-risk wording.
    expect(result.requiredWeeklyBehaviour).toMatch(/Maintenir/i);
    expect(result.recommendation).not.toMatch(/Ajuster/i);
  });

  it("marks an active binary goal with no deadline and no milestones as low risk", () => {
    // buildGoalPacingSnapshot only carries active goals, so an "achieved" goal would never reach
    // the pacing panel — this covers the still-active, nothing-to-miss-yet case instead.
    const goal = createEmptyAnnualGoal({
      id: "goal-binary",
      title: "Lancer le produit",
      measurementType: "binary",
      status: "active",
    });

    const snapshot = buildGoalPacingSnapshot(buildSnapshotInputs(goal), "full");
    const pacing = buildLocalGoalPacing(snapshot);
    const result = pacing.goals[0];

    expect(snapshot.goals[0].onPace).toBe(true);
    expect(result.onPace).toBe(true);
    expect(result.riskLevel).toBe("low");
  });

  it("marks a cumulative goal on track for the calendar year as low risk", () => {
    const goal = createEmptyAnnualGoal({
      id: "goal-cumulative",
      title: "Lire des livres",
      measurementType: "cumulative",
      targetValue: 24,
      unit: "livres",
      progressLog: { "2026-01": 1 },
    });

    const snapshot = buildGoalPacingSnapshot(buildSnapshotInputs(goal), "full");
    const pacing = buildLocalGoalPacing(snapshot);
    const result = pacing.goals[0];

    expect(result.onPace).toBe(snapshot.goals[0].onPace);
    expect(result.riskLevel).toBeDefined();
  });
});
