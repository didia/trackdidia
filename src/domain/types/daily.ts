export type DailyStatus = "not_started" | "morning_done" | "closed";

export type MetricKey =
  | "course"
  | "marche"
  | "depenseCalorique"
  | "pushups"
  | "qualiteSommeil"
  | "tempsEcranTelephone"
  | "pomodoris"
  | "tachesDebut"
  | "tachesFin"
  | "tachesAjoutes"
  | "tachesRealises";

export type PrincipleKey =
  | "priereDuMatin"
  | "oxytocineDuMatin"
  | "avoirLuMesPrincipes"
  | "ecriture"
  | "apprentissage"
  | "managedSolitude"
  | "respectDeVieCommeJesus"
  | "retroJournalier"
  | "tempsDeQualiteAvecEnfants"
  | "priereDuSoir"
  | "attentionAMonEpouse"
  | "respectTrc"
  | "respectReveil"
  | "objectifsAtteints";

export type DailyMetrics = Record<MetricKey, number | null>;
export type PrincipleChecks = Record<PrincipleKey, boolean | null>;
export type SuggestedMetrics = Partial<Record<MetricKey, number | null>>;

export interface DailyEntry {
  date: string;
  status: DailyStatus;
  metrics: DailyMetrics;
  suggestedMetrics?: SuggestedMetrics;
  principleChecks: PrincipleChecks;
  morningIntention: string;
  nightReflection: string;
  tomorrowFocus: string;
  updatedAt: string;
}
