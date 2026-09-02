import { t } from "../i18n";
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

const metric = (
  key: MetricKey,
  extras: Pick<MetricDefinition, "step" | "min" | "max">
): MetricDefinition => ({
  key,
  label: t(`${key}.label`, { ns: "metrics" }),
  helper: t(`${key}.helper`, { ns: "metrics" }),
  unit: t(`${key}.unit`, { ns: "metrics" }),
  ...extras
});

const principle = (key: PrincipleKey, timing: PrincipleDefinition["timing"]): PrincipleDefinition => ({
  key,
  label: t(`${key}.label`, { ns: "principles" }),
  helper: t(`${key}.helper`, { ns: "principles" }),
  timing
});

export const metricDefinitions: MetricDefinition[] = [
  metric("course", { step: 1, min: 0 }),
  metric("marche", { step: 1, min: 0 }),
  metric("depenseCalorique", { step: 1, min: 0 }),
  metric("pushups", { step: 1, min: 0 }),
  metric("qualiteSommeil", { step: 1, min: 0, max: 100 }),
  metric("tempsEcranTelephone", { step: 1, min: 0 }),
  metric("pomodoris", { step: 1, min: 0 }),
  metric("tachesDebut", { step: 1, min: 0 }),
  metric("tachesFin", { step: 1, min: 0 }),
  metric("tachesAjoutes", { step: 1, min: 0 }),
  metric("tachesRealises", { step: 1, min: 0 })
];

export const principleDefinitions: PrincipleDefinition[] = [
  principle("priereDuMatin", "morning"),
  principle("oxytocineDuMatin", "morning"),
  principle("avoirLuMesPrincipes", "morning"),
  principle("ecriture", "anytime"),
  principle("apprentissage", "anytime"),
  principle("managedSolitude", "anytime"),
  principle("respectDeVieCommeJesus", "anytime"),
  principle("retroJournalier", "evening"),
  principle("tempsDeQualiteAvecEnfants", "evening"),
  principle("priereDuSoir", "evening"),
  principle("attentionAMonEpouse", "evening"),
  principle("respectTrc", "evening"),
  principle("respectReveil", "morning"),
  principle("objectifsAtteints", "evening")
];

export const morningPrincipleKeys: PrincipleKey[] = [
  "respectReveil",
  "priereDuMatin",
  "oxytocineDuMatin",
  "avoirLuMesPrincipes",
  "ecriture",
  "apprentissage"
];

export const eveningPrincipleKeys = principleDefinitions.map((definition) => definition.key);
