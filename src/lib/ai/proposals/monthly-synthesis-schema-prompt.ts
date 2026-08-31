const ritualSectionKeys = [
  "bilan",
  "journaux",
  "finances",
  "temps",
  "progressionObjectifs",
  "missionObjectifs",
  "nettoyageListes",
  "calendrier",
  "grosProjets",
  "developpement"
] as const;

export const buildMonthlySynthesisSchemaPrompt = (goalIds: string[]): string => {
  const goalIdList = goalIds.length > 0 ? goalIds.join(", ") : "(aucun objectif dans le snapshot)";
  const fields = `Champs requis (monthly_synthesis S3):
- headline: string (une ligne)
- weekPattern: string (lecture des semaines du mois)
- sectionDrafts?: objet optionnel — cles autorisees: ${ritualSectionKeys.join(", ")}; chaque valeur est un string
- goalEvaluationDrafts: Array<{ goalId: string; score: number | null; trend: "up" | "steady" | "down" | null; notes: string; blockers: string }>
  - goalId doit etre l'un des identifiants du snapshot: ${goalIdList}
  - score: entier ou decimal entre 0 et 100 inclusivement, ou null`;

  const exampleGoalId = goalIds[0] ?? "goal-1";
  const example = `Exemple minimal:
{"headline":"Mois solide","weekPattern":"Score stable sur quatre semaines.","sectionDrafts":{"bilan":"Note de bilan"},"goalEvaluationDrafts":[{"goalId":"${exampleGoalId}","score":75,"trend":"up","notes":"Bonne progression","blockers":""}]}`;

  return [fields, example].join("\n\n");
};
