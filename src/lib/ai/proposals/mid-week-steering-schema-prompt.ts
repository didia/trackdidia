export const buildMidWeekSteeringSchemaPrompt = (actionableKeys: string[]): string => {
  const keyList =
    actionableKeys.length > 0 ? actionableKeys.join(", ") : "(aucun signal actionnable)";

  const fields = `Champs requis (mid_week_steering):
- headline: string (une phrase: ou en est la semaine)
- read: string (lecture courte: ce qui va bien et ce qui derape, en t'appuyant sur les signaux du snapshot)
- focusShift: string (un seul changement de focus pour le reste de la semaine)
- actions: Array<{ signalKey: string; title: string; why: string; effort: "low" | "medium" | "high" }>
  - signalKey doit etre l'une des cles actionnables du snapshot: ${keyList}
  - chaque cle au plus une fois; ne cite jamais un signal "ahead", "on_pace" ou "unknown"
  - ${actionableKeys.length > 0 ? "3 actions au maximum, de la plus urgente a la moins urgente" : "actions doit etre un tableau vide []"}
  - title: string (action concrete, courte), why: string (lie a l'ecart du signal), effort: "low" | "medium" | "high"
Un jour sans donnee n'est pas un echec: ne reproche jamais un signal "unknown". Ne pose aucun diagnostic sur la personne.`;

  const example = `Exemple minimal:
{"headline":"Semaine dans le rythme sauf le focus","read":"Le focus est en retard.","focusShift":"Reserver deux blocs de focus demain matin","actions":[${
    actionableKeys[0]
      ? `{"signalKey":"${actionableKeys[0]}","title":"Deux blocs de focus","why":"En retard sur le rythme attendu","effort":"medium"}`
      : ""
  }]}`;

  return [fields, example].join("\n\n");
};
