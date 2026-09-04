import type { MonthlyReviewSectionKey, MonthlySynthesisResponse } from "../../../domain/types";
import { t } from "../../../i18n";
import { formatPercent } from "../../format";
import type { MonthlySnapshot } from "../context/monthly-snapshot";

const describeWeekPattern = (snapshot: MonthlySnapshot): string => {
  const scores = snapshot.weeks.map((week) => week.weeklyScore);
  if (scores.length === 0) {
    return t("monthly.weekPatternInsufficient", { ns: "coach" });
  }

  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const firstHalf = scores.slice(0, Math.ceil(scores.length / 2));
  const secondHalf = scores.slice(Math.ceil(scores.length / 2));
  const firstAvg =
    firstHalf.length > 0
      ? firstHalf.reduce((sum, score) => sum + score, 0) / firstHalf.length
      : average;
  const secondAvg =
    secondHalf.length > 0
      ? secondHalf.reduce((sum, score) => sum + score, 0) / secondHalf.length
      : average;
  const delta = secondAvg - firstAvg;

  if (Math.abs(delta) < 0.03) {
    return t("monthly.weekPatternStable", { ns: "coach", score: formatPercent(average) });
  }

  return delta > 0
    ? t("monthly.weekPatternUp", {
        ns: "coach",
        score: formatPercent(average),
        delta: formatPercent(delta),
      })
    : t("monthly.weekPatternDown", {
        ns: "coach",
        score: formatPercent(average),
        delta: formatPercent(delta),
      });
};

const buildSectionDrafts = (
  snapshot: MonthlySnapshot,
): Partial<Record<MonthlyReviewSectionKey, string>> => {
  const drafts: Partial<Record<MonthlyReviewSectionKey, string>> = {};

  drafts.bilan = t("monthly.sectionBilan", {
    ns: "coach",
    days: snapshot.daysTracked,
    score: formatPercent(snapshot.weeklyScoreAverage),
  });
  drafts.progressionObjectifs =
    snapshot.goals.length > 0
      ? t("monthly.sectionGoalsLinked", { ns: "coach", count: snapshot.goals.length })
      : t("monthly.sectionGoalsNone", { ns: "coach" });

  if (snapshot.weeklyReviewsCompleted < snapshot.weeksCovered) {
    drafts.journaux = t("monthly.sectionJournals", {
      ns: "coach",
      completed: snapshot.weeklyReviewsCompleted,
      covered: snapshot.weeksCovered,
    });
  }

  return drafts;
};

const buildGoalEvaluationDrafts = (
  snapshot: MonthlySnapshot,
): MonthlySynthesisResponse["goalEvaluationDrafts"] =>
  snapshot.goals.map((goal) => ({
    goalId: goal.goalId,
    score:
      goal.evaluationScore ??
      (goal.progressRatio === null ? null : Math.round(Math.min(goal.progressRatio, 1) * 100)),
    trend:
      goal.evaluationTrend === "up" ||
      goal.evaluationTrend === "steady" ||
      goal.evaluationTrend === "down"
        ? goal.evaluationTrend
        : goal.progressRatio !== null && goal.progressRatio >= 0.7
          ? "up"
          : goal.progressRatio !== null && goal.progressRatio >= 0.4
            ? "steady"
            : "down",
    notes:
      goal.monthValue === null
        ? t("monthly.goalNotesInsufficient", { ns: "coach" })
        : t("monthly.goalNotesValue", {
            ns: "coach",
            value: Math.round(goal.monthValue),
            unit: goal.unit,
          }),
    blockers:
      goal.progressRatio !== null && goal.progressRatio < 0.5
        ? t("monthly.goalBlockersGap", { ns: "coach" })
        : "",
  }));

export const buildLocalMonthlySynthesis = (
  snapshot: MonthlySnapshot,
): MonthlySynthesisResponse => ({
  headline:
    snapshot.weeklyScoreAverage >= 0.7
      ? t("monthly.headlineStrong", { ns: "coach" })
      : t("monthly.headlineReview", { ns: "coach" }),
  weekPattern: describeWeekPattern(snapshot),
  sectionDrafts: buildSectionDrafts(snapshot),
  goalEvaluationDrafts: buildGoalEvaluationDrafts(snapshot),
});
