import type { GoalPacingResponse, GoalPacingRiskLevel } from "../../../domain/types";
import type { GoalPacingSnapshot } from "../context/goal-pacing-snapshot";

const riskFromGap = (progressRatio: number | null, expected: number): GoalPacingRiskLevel => {
  if (progressRatio === null) {
    return "high";
  }

  const gap = expected - progressRatio;
  if (gap <= 0.05) {
    return "low";
  }

  if (gap <= 0.15) {
    return "medium";
  }

  return "high";
};

const formatGap = (progressRatio: number | null, expected: number): string => {
  if (progressRatio === null) {
    return "Pas assez de donnees pour mesurer l'ecart.";
  }

  const delta = progressRatio - expected;
  const deltaPercent = Math.round(Math.abs(delta) * 100);
  return delta >= 0
    ? `En avance d'environ ${deltaPercent} point(s) vs le rythme annuel attendu.`
    : `En retard d'environ ${deltaPercent} point(s) vs le rythme annuel attendu.`;
};

const weeklyBehaviour = (onPace: boolean, progressRatio: number | null): string =>
  onPace
    ? "Maintenir le rythme actuel: une revue hebdo courte suffit pour garder la trajectoire."
    : progressRatio === null
      ? "Commencer par tracer la metrique liee chaque semaine avant d'ajuster la cible."
      : "Bloquer un creneau hebdomadaire dedie et reduire l'ecart par petits increments mesurables.";

const recommendation = (onPace: boolean, riskLevel: GoalPacingRiskLevel): string => {
  if (onPace && riskLevel === "low") {
    return "Conserver la cadence actuelle et noter ce qui fonctionne pour le repeter.";
  }

  if (riskLevel === "high") {
    return "Recalibrer la cible ou le plan d'execution ce mois-ci — l'ecart risque de se cristalliser.";
  }

  return "Ajuster une habitude hebdomadaire concrete plutot que revoir toute la cible annuelle.";
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
      recommendation: recommendation(goal.onPace, riskLevel)
    };
  })
});
