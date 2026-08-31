export const buildGoalPacingSchemaPrompt = (goalIds: string[]): string => {
  const goalIdList = goalIds.length > 0 ? goalIds.join(", ") : "(aucun objectif dans le snapshot)";
  const fields = `Champs requis (goal_pacing S4):
- goals: Array<{ goalId: string; onPace: boolean; gap: string; requiredWeeklyBehaviour: string; riskLevel: "low" | "medium" | "high"; recommendation: string }>
  - goalId doit etre l'un des identifiants du snapshot: ${goalIdList}
  - onPace: boolean (true si la progression suit le rythme attendu pour la date de reference)
  - gap: string (ecart vs la cible annuelle)
  - requiredWeeklyBehaviour: string (comportement hebdo necessaire)
  - riskLevel: "low" | "medium" | "high"
  - recommendation: string`;

  const exampleGoalId = goalIds[0] ?? "goal-1";
  const example = `Exemple minimal:
{"goals":[{"goalId":"${exampleGoalId}","onPace":true,"gap":"Proche de la cible annuelle","requiredWeeklyBehaviour":"Maintenir 4 sessions focus","riskLevel":"low","recommendation":"Continuer le rythme actuel"}]}`;

  return [fields, example].join("\n\n");
};
