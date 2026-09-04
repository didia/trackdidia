import { ANNUAL_GOAL_PACE_TOLERANCE } from "../../../domain/annual-goals";
import type { GoalPacingResponse, GoalPacingRiskLevel } from "../../../domain/types";
import { t } from "../../../i18n";
import type { GoalPacingSnapshot } from "../context/goal-pacing-snapshot";

const riskFromGap = (progressRatio: number | null, expected: number): GoalPacingRiskLevel => {
  if (progressRatio === null) {
    return "high";
  }

  const gap = expected - progressRatio;
  if (gap <= ANNUAL_GOAL_PACE_TOLERANCE) {
    return "low";
  }

  if (gap <= 0.15) {
    return "medium";
  }

  return "high";
};

const formatGap = (progressRatio: number | null, expected: number): string => {
  if (progressRatio === null) {
    return t("pacing.gapUnknown", { ns: "coach" });
  }

  const delta = progressRatio - expected;
  const deltaPercent = Math.round(Math.abs(delta) * 100);
  return delta >= 0
    ? t("pacing.gapAhead", { ns: "coach", count: deltaPercent })
    : t("pacing.gapBehind", { ns: "coach", count: deltaPercent });
};

const weeklyBehaviour = (onPace: boolean, progressRatio: number | null): string =>
  onPace
    ? t("pacing.weeklyOnPace", { ns: "coach" })
    : progressRatio === null
      ? t("pacing.weeklyNoData", { ns: "coach" })
      : t("pacing.weeklyCatchUp", { ns: "coach" });

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
    const riskLevel = riskFromGap(goal.progressRatio, snapshot.expectedProgressRatio);

    return {
      goalId: goal.goalId,
      onPace: goal.onPace,
      gap: formatGap(goal.progressRatio, snapshot.expectedProgressRatio),
      requiredWeeklyBehaviour: weeklyBehaviour(goal.onPace, goal.progressRatio),
      riskLevel,
      recommendation: recommendation(goal.onPace, riskLevel),
    };
  }),
});
