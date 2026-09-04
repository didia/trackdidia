import { createEmptyAnnualGoal } from "../../../domain/annual-goals";
import {
  buildGoalPacingSnapshot,
  type GoalPacingSnapshotInputs,
} from "../context/goal-pacing-snapshot";
import { buildLocalGoalPacing } from "./goal-pacing-fallback";

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
      }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: Math.round(progressRatio * 100),
      progressRatio,
      monthlyProgress: [{ monthKey: "2026-08", value: Math.round(progressRatio * 100) }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
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
});
