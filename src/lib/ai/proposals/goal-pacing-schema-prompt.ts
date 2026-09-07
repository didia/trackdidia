export const buildGoalPacingSchemaPrompt = (goalIds: string[]): string => {
  const goalIdList = goalIds.length > 0 ? goalIds.join(", ") : "(aucun objectif dans le snapshot)";
  const measurementTypes = `Chaque objectif du snapshot porte un measurementType — adapte ton discours en consequence,
ne parle jamais d'un objectif en pourcentage s'il n'en a pas:
- "binary": termine ou non (status "achieved" = fait). S'il a des milestones, parle de leur progression
  (milestonesCompleted / milestonesTotal), jamais d'un ratio numerique global.
- "numeric": une valeur actuelle qui converge vers une cible (progressRatio est un vrai pourcentage,
  direction "increase" ou "decrease").
- "cumulative": une somme qui s'accumule sur l'annee (ex: "17 sur 24 livres"), monthlyProgress est un
  total cumule mois par mois.
- "recurring": une cadence a tenir (ex: "3x/semaine"), jamais "termine" — parle d'adherence
  (adherenceRatio, periodsMet/periodsElapsed) et de currentStreak, pas de pourcentage de cible annuelle.`;

  const fields = `Champs requis (goal_pacing S4):
- goals: Array<{ goalId: string; onPace: boolean; gap: string; requiredWeeklyBehaviour: string; riskLevel: "low" | "medium" | "high"; recommendation: string }>
  - goalId doit etre l'un des identifiants du snapshot: ${goalIdList}
  - onPace: boolean (reprends measurement.onPace du snapshot pour cet objectif)
  - gap: string (ecart vs l'attendu — adherence pour "recurring", milestones pour "binary" sans cible chiffree)
  - requiredWeeklyBehaviour: string (comportement hebdo necessaire, en langage adapte au type)
  - riskLevel: "low" | "medium" | "high"
  - recommendation: string`;

  const exampleGoalId = goalIds[0] ?? "goal-1";
  const example = `Exemple minimal:
{"goals":[{"goalId":"${exampleGoalId}","onPace":true,"gap":"Proche de la cible annuelle","requiredWeeklyBehaviour":"Maintenir 4 sessions focus","riskLevel":"low","recommendation":"Continuer le rythme actuel"}]}`;

  return [measurementTypes, fields, example].join("\n\n");
};
