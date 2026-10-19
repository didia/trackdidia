const ritualSectionKeys = [
  "bilan",
  "budget",
  "tempsEtPlan",
  "collecte",
  "calendrier",
  "gtd",
  "alignement",
  "dimanche",
] as const;

export const buildWeeklySynthesisSchemaPrompt = (): string => {
  const fields = `Champs requis (weekly_synthesis S2):
- headline: string (une ligne)
- scoreExplanation: string (lecture du score hebdo)
- strongestAxis: string (libelle d'axe)
- weakestAxes: string[2] (exactement deux libelles d'axes)
- sectionDrafts?: objet optionnel — cles autorisees: ${ritualSectionKeys.join(", ")}; chaque valeur est un string
  - "tempsEtPlan" doit tenir compte non seulement des Pomodoros mais aussi, quand \`rescueTimeGoals\`
    est present dans le snapshot, de l'atteinte de chaque objectif RescueTime (\`achievement\`,
    \`actualHours\` vs \`weeklyTargetHours\`) — mentionner explicitement les objectifs mal atteints.
  - Metriques de taches du snapshot (\`metrics\`): \`tachesAjoutes\` = taches nouvellement entrees ou
    re-entrees dans Next Actions ce jour-la (le dimanche inclut le report de la semaine precedente);
    \`tachesDebut\` / \`tachesFin\` = taille de la pile en debut / fin de journee (\`aggregation: "level"\`,
    pas de \`weekTotal\`). Ne jamais additionner ces niveaux ni les presenter comme des « taches commencees »;
    utiliser \`meaning\` quand il est fourni.
- nextWeekObjectives: Array<{ title: string; kind: "time" | "manual"; targetHours: number | null; rescuetimeKind: "overview" | "category" | "activity" | "productivity" | null; rescuetimeThing: string | null }> (max 5)
  - kind "time": targetHours > 0 requis; rescuetimeKind + rescuetimeThing non vides requis
  - rescuetimeThing doit etre copie EXACTEMENT depuis \`rescueTimeVocabulary\` du snapshot
    (\`activity\` pour rescuetimeKind "activity", \`category\` pour "category") — ne jamais l'inventer
    a partir du titre (code de cours, nom de projet). Sans correspondance exacte dans cette liste
    (ou si \`rescueTimeVocabulary\` est absent), utiliser kind "manual".
  - Ne propose pas d'objectif kind "time" pour un sujet deja suivi par un objectif de
    \`rescueTimeGoals\` (les goals RescueTime sont deja scores et listes dans la revue): ce serait un doublon.
  - kind "manual": targetHours, rescuetimeKind et rescuetimeThing doivent etre null
- gtdActions: Array<{ taskId: string; taskTitle: string; action: "schedule" | "defer" | "delegate" | "drop"; reason: string }>
  - taskTitle doit reprendre exactement le titre de la tache concernee, tel que fourni dans le
    snapshot (ex. \`gtd.staleNextActionsSample\`) — ne jamais laisser une action GTD sans titre.`;

  const example = `Exemple minimal:
{"headline":"Semaine solide","scoreExplanation":"Le score reflete une bonne discipline.","strongestAxis":"Discipline","weakestAxes":["Temps d'ecran","Pomodoris"],"sectionDrafts":{"bilan":"Note de bilan"},"nextWeekObjectives":[{"title":"Deep work","kind":"manual","targetHours":null,"rescuetimeKind":null,"rescuetimeThing":null}],"gtdActions":[{"taskId":"task-1","taskTitle":"Relancer le fournisseur","action":"defer","reason":"Stale"}]}`;

  return [fields, example].join("\n\n");
};
