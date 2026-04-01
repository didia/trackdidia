import type { MetricKey, PrincipleKey } from "./types";

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  helper: string;
}

export interface PrincipleDefinition {
  key: PrincipleKey;
  label: string;
  helper: string;
  timing: "morning" | "evening" | "anytime";
}

export const metricDefinitions: MetricDefinition[] = [
  { key: "course", label: "Course", unit: "min", step: 1, min: 0, helper: "Temps ou volume lie a la course." },
  { key: "marche", label: "Marche", unit: "pas", step: 1, min: 0, helper: "Nombre de pas de la journee." },
  { key: "depenseCalorique", label: "Depense calorique", unit: "kcal", step: 1, min: 0, helper: "Calories depensees." },
  { key: "pushups", label: "Pushups", unit: "rep", step: 1, min: 0, helper: "Total de pushups." },
  { key: "qualiteSommeil", label: "Qualite du sommeil", unit: "/100", step: 1, min: 0, max: 100, helper: "Score de sommeil." },
  { key: "tempsEcranTelephone", label: "Temps d'ecran telephone", unit: "min", step: 1, min: 0, helper: "Temps d'ecran total." },
  { key: "pomodoris", label: "Pomodoris", unit: "sessions", step: 1, min: 0, helper: "Nombre de blocs concentres." },
  { key: "tachesDebut", label: "Taches debut", unit: "nb", step: 1, min: 0, helper: "Taches prevues au debut de la journee." },
  { key: "tachesFin", label: "Taches fin", unit: "nb", step: 1, min: 0, helper: "Taches restantes en fin de journee." },
  { key: "tachesAjoutes", label: "Taches ajoutes", unit: "nb", step: 1, min: 0, helper: "Taches ajoutees apres le depart." },
  { key: "tachesRealises", label: "Taches realises", unit: "nb", step: 1, min: 0, helper: "Taches completees." }
];

export const principleDefinitions: PrincipleDefinition[] = [
  { key: "priereDuMatin", label: "Priere du matin", helper: "Avoir commence la journee dans la priere.", timing: "morning" },
  { key: "oxytocineDuMatin", label: "Oxytocine du matin", helper: "Connexion affective ou relationnelle le matin.", timing: "morning" },
  { key: "avoirLuMesPrincipes", label: "Avoir lu mes principes", helper: "Relecture des principes personnels.", timing: "morning" },
  { key: "ecriture", label: "Ecriture", helper: "Temps d'ecriture ou de journal.", timing: "anytime" },
  { key: "apprentissage", label: "Apprentissage", helper: "Progression intellectuelle ou spirituelle.", timing: "anytime" },
  { key: "managedSolitude", label: "Managed solitude", helper: "Solitude choisie et saine.", timing: "anytime" },
  { key: "respectDeVieCommeJesus", label: "Respect de vie comme Jesus", helper: "Alignement avec le style de vie vise.", timing: "anytime" },
  { key: "retroJournalier", label: "Retro journalier", helper: "Fermeture et revue de la journee.", timing: "evening" },
  { key: "tempsDeQualiteAvecEnfants", label: "Temps de qualite avec enfants", helper: "Presence intentionnelle avec les enfants.", timing: "evening" },
  { key: "priereDuSoir", label: "Priere du soir", helper: "Cloturer la journee dans la priere.", timing: "evening" },
  { key: "attentionAMonEpouse", label: "Attention a mon epouse", helper: "Action concrete ou presence envers mon epouse.", timing: "evening" },
  { key: "respectTrc", label: "Respect TRC", helper: "Respect du cadre TRC.", timing: "evening" },
  { key: "respectReveil", label: "Respect reveil", helper: "Heure de reveil respectee.", timing: "morning" },
  { key: "objectifsAtteints", label: "Objectifs atteints", helper: "Objectifs du jour reellement atteints.", timing: "evening" }
];

export const morningPrincipleKeys = principleDefinitions
  .filter((definition) => definition.timing === "morning" || definition.timing === "anytime")
  .map((definition) => definition.key);

export const eveningPrincipleKeys = principleDefinitions.map((definition) => definition.key);

