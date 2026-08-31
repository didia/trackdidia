import type { MonthlyReviewSectionKey, MonthlySynthesisResponse } from "../../../domain/types";
import { formatPercent } from "../../format";
import type { MonthlySnapshot } from "../context/monthly-snapshot";

const describeWeekPattern = (snapshot: MonthlySnapshot): string => {
  const scores = snapshot.weeks.map((week) => week.weeklyScore);
  if (scores.length === 0) {
    return "Pas assez de semaines tracees pour lire un rythme.";
  }

  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const firstHalf = scores.slice(0, Math.ceil(scores.length / 2));
  const secondHalf = scores.slice(Math.ceil(scores.length / 2));
  const firstAvg =
    firstHalf.length > 0 ? firstHalf.reduce((sum, score) => sum + score, 0) / firstHalf.length : average;
  const secondAvg =
    secondHalf.length > 0 ? secondHalf.reduce((sum, score) => sum + score, 0) / secondHalf.length : average;
  const delta = secondAvg - firstAvg;

  if (Math.abs(delta) < 0.03) {
    return `Score hebdo moyen ${formatPercent(average)} — rythme stable sur le mois.`;
  }

  return delta > 0
    ? `Score hebdo moyen ${formatPercent(average)} — acceleration en fin de mois (+${formatPercent(delta)}).`
    : `Score hebdo moyen ${formatPercent(average)} — ralentissement en fin de mois (${formatPercent(delta)}).`;
};

const buildSectionDrafts = (snapshot: MonthlySnapshot): Partial<Record<MonthlyReviewSectionKey, string>> => {
  const drafts: Partial<Record<MonthlyReviewSectionKey, string>> = {};

  drafts.bilan = `Mois avec ${snapshot.daysTracked} jours traces et score hebdo moyen ${formatPercent(snapshot.weeklyScoreAverage)}.`;
  drafts.progressionObjectifs =
    snapshot.goals.length > 0
      ? `${snapshot.goals.length} objectif(s) annuel(s) relies — relire ce qui avance et ce qui stagne.`
      : "Aucun objectif annuel relie pour l'instant.";

  if (snapshot.weeklyReviewsCompleted < snapshot.weeksCovered) {
    drafts.journaux = `${snapshot.weeklyReviewsCompleted}/${snapshot.weeksCovered} revues hebdo cloturees — reconnecter les notes avant de fermer le mois.`;
  }

  return drafts;
};

const buildGoalEvaluationDrafts = (
  snapshot: MonthlySnapshot
): MonthlySynthesisResponse["goalEvaluationDrafts"] =>
  snapshot.goals.map((goal) => ({
    goalId: goal.goalId,
    score:
      goal.evaluationScore ??
      (goal.progressRatio === null ? null : Math.round(Math.min(goal.progressRatio, 1) * 100)),
    trend:
      goal.evaluationTrend === "up" || goal.evaluationTrend === "steady" || goal.evaluationTrend === "down"
        ? goal.evaluationTrend
        : goal.progressRatio !== null && goal.progressRatio >= 0.7
          ? "up"
          : goal.progressRatio !== null && goal.progressRatio >= 0.4
            ? "steady"
            : "down",
    notes:
      goal.monthValue === null
        ? "Donnees mensuelles insuffisantes pour une lecture fine."
        : `Valeur du mois: ${Math.round(goal.monthValue)} ${goal.unit}.`,
    blockers: goal.progressRatio !== null && goal.progressRatio < 0.5 ? "Ecart important vs cible annuelle." : ""
  }));

export const buildLocalMonthlySynthesis = (snapshot: MonthlySnapshot): MonthlySynthesisResponse => ({
  headline: snapshot.weeklyScoreAverage >= 0.7 ? "Mois solide a refermer" : "Mois a relire avant de cloturer",
  weekPattern: describeWeekPattern(snapshot),
  sectionDrafts: buildSectionDrafts(snapshot),
  goalEvaluationDrafts: buildGoalEvaluationDrafts(snapshot)
});
