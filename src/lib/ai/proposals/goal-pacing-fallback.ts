import { ANNUAL_GOAL_PACE_TOLERANCE } from "../../../domain/annual-goals";
import type { GoalPacingResponse, GoalPacingRiskLevel } from "../../../domain/types";
import { t } from "../../../i18n";
import type { GoalPacingSnapshot, GoalPacingSnapshotGoal } from "../context/goal-pacing-snapshot";

const cadencePeriodLabel = (goal: GoalPacingSnapshotGoal): string =>
  goal.cadencePeriod === "month"
    ? t("pacing.cadenceMonth", { ns: "coach" })
    : t("pacing.cadenceWeek", { ns: "coach" });

const riskFromRatio = (ratio: number | null, expected: number): GoalPacingRiskLevel => {
  if (ratio === null) {
    return "high";
  }

  const gap = expected - ratio;
  if (gap <= ANNUAL_GOAL_PACE_TOLERANCE) {
    return "low";
  }

  if (gap <= 0.15) {
    return "medium";
  }

  return "high";
};

const formatRatioGap = (progressRatio: number | null, expected: number): string => {
  if (progressRatio === null) {
    return t("pacing.gapUnknown", { ns: "coach" });
  }

  const delta = progressRatio - expected;
  const deltaPercent = Math.round(Math.abs(delta) * 100);
  return delta >= 0
    ? t("pacing.gapAhead", { ns: "coach", count: deltaPercent })
    : t("pacing.gapBehind", { ns: "coach", count: deltaPercent });
};

const ratioWeeklyBehaviour = (onPace: boolean, progressRatio: number | null): string =>
  onPace
    ? t("pacing.weeklyOnPace", { ns: "coach" })
    : progressRatio === null
      ? t("pacing.weeklyNoData", { ns: "coach" })
      : t("pacing.weeklyCatchUp", { ns: "coach" });

const riskLevelFor = (
  goal: GoalPacingSnapshotGoal,
  snapshotExpectedProgressRatio: number,
): GoalPacingRiskLevel => {
  if (goal.measurementType === "recurring") {
    if (goal.periodsElapsed === 0) {
      return "medium";
    }
    return riskFromRatio(goal.adherenceRatio, 1);
  }

  if (goal.measurementType === "binary") {
    if (goal.status === "achieved") {
      return "low";
    }
    if (goal.milestonesTotal > 0 && goal.expectedProgressRatio !== null) {
      return riskFromRatio(goal.milestoneProgressRatio, goal.expectedProgressRatio);
    }
    return goal.onPace ? "low" : "high";
  }

  return riskFromRatio(
    goal.progressRatio,
    goal.expectedProgressRatio ?? snapshotExpectedProgressRatio,
  );
};

const formatGap = (goal: GoalPacingSnapshotGoal, snapshotExpectedProgressRatio: number): string => {
  if (goal.measurementType === "recurring") {
    if (goal.periodsElapsed === 0) {
      return t("pacing.gapNoPeriodsElapsed", { ns: "coach" });
    }
    return t("pacing.gapAdherence", {
      ns: "coach",
      count: Math.round((goal.adherenceRatio ?? 0) * 100),
      streak: goal.currentStreak,
    });
  }

  if (goal.measurementType === "binary") {
    if (goal.milestonesTotal > 0) {
      return t("pacing.gapMilestones", {
        ns: "coach",
        completed: goal.milestonesCompleted,
        total: goal.milestonesTotal,
      });
    }
    return goal.status === "achieved"
      ? t("pacing.gapAchieved", { ns: "coach" })
      : t("pacing.gapNotAchieved", { ns: "coach" });
  }

  if (goal.measurementType === "cumulative" && goal.targetValue !== null) {
    return t("pacing.gapCumulativeRemaining", {
      ns: "coach",
      current: goal.currentValue === null ? "—" : Math.round(goal.currentValue),
      target: goal.targetValue,
      unit: goal.unit,
    });
  }

  return formatRatioGap(
    goal.progressRatio,
    goal.expectedProgressRatio ?? snapshotExpectedProgressRatio,
  );
};

const weeklyBehaviour = (goal: GoalPacingSnapshotGoal): string => {
  if (goal.measurementType === "recurring") {
    return goal.onPace
      ? t("pacing.weeklyRecurringOnPace", {
          ns: "coach",
          target: goal.cadenceTarget ?? 0,
          period: cadencePeriodLabel(goal),
        })
      : t("pacing.weeklyRecurringCatchUp", {
          ns: "coach",
          target: goal.cadenceTarget ?? 0,
          period: cadencePeriodLabel(goal),
        });
  }

  if (goal.measurementType === "binary") {
    if (goal.status === "achieved") {
      return t("pacing.weeklyAchieved", { ns: "coach" });
    }
    return goal.milestonesTotal > 0
      ? t("pacing.weeklyMilestoneNext", { ns: "coach" })
      : ratioWeeklyBehaviour(goal.onPace, null);
  }

  return ratioWeeklyBehaviour(goal.onPace, goal.progressRatio);
};

const recommendation = (onPace: boolean, riskLevel: GoalPacingRiskLevel): string => {
  if (onPace && riskLevel === "low") {
    return t("pacing.recLow", { ns: "coach" });
  }

  if (riskLevel === "high") {
    return t("pacing.recHigh", { ns: "coach" });
  }

  return t("pacing.recMedium", { ns: "coach" });
};

export const buildLocalGoalPacing = (snapshot: GoalPacingSnapshot): GoalPacingResponse => ({
  goals: snapshot.goals.map((goal) => {
    const riskLevel = riskLevelFor(goal, snapshot.expectedProgressRatio);

    return {
      goalId: goal.goalId,
      onPace: goal.onPace,
      gap: formatGap(goal, snapshot.expectedProgressRatio),
      requiredWeeklyBehaviour: weeklyBehaviour(goal),
      riskLevel,
      recommendation: recommendation(goal.onPace, riskLevel),
    };
  }),
});
