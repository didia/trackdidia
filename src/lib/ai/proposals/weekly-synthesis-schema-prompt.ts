const ritualSectionKeys = [
  "bilan",
  "budget",
  "tempsEtPlan",
  "collecte",
  "calendrier",
  "gtd",
  "alignement",
  "dimanche"
] as const;

export const buildWeeklySynthesisSchemaPrompt = (): string => {
  const fields = `Champs requis (weekly_synthesis S2):
- headline: string (une ligne)
- scoreExplanation: string (lecture du score hebdo)
- strongestAxis: string (libelle d'axe)
- weakestAxes: string[2] (exactement deux libelles d'axes)
- sectionDrafts?: objet optionnel — cles autorisees: ${ritualSectionKeys.join(", ")}; chaque valeur est un string
- nextWeekObjectives: Array<{ title: string; kind: "time" | "manual"; targetHours: number | null; rescuetimeKind: "overview" | "category" | "activity" | "productivity" | null; rescuetimeThing: string | null }> (max 5)
  - kind "time": targetHours > 0 requis; rescuetimeKind + rescuetimeThing non vides requis
  - kind "manual": targetHours, rescuetimeKind et rescuetimeThing doivent etre null
- gtdActions: Array<{ taskId: string; action: "schedule" | "defer" | "delegate" | "drop"; reason: string }>`;

  const example = `Exemple minimal:
{"headline":"Semaine solide","scoreExplanation":"Le score reflete une bonne discipline.","strongestAxis":"Discipline","weakestAxes":["Temps d'ecran","Pomodoris"],"sectionDrafts":{"bilan":"Note de bilan"},"nextWeekObjectives":[{"title":"Deep work","kind":"manual","targetHours":null,"rescuetimeKind":null,"rescuetimeThing":null}],"gtdActions":[{"taskId":"task-1","action":"defer","reason":"Stale"}]}`;

  return [fields, example].join("\n\n");
};
