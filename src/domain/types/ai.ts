import type { CredoKey } from "../credo";
import type { MetricKey, PrincipleKey } from "./daily";
import type { AnnualGoalTrend } from "./goals";
import type {
  MonthlyReviewSectionKey,
  RescueTimeTaxonomy,
  WeeklyObjectiveKind,
  WeeklyRitualSectionKey,
} from "./reviews";

export type AiPayloadScope = "metrics" | "metrics_and_structure" | "full";

export type AiSurface =
  | "coach_pulse"
  | "weekly_synthesis"
  | "monthly_synthesis"
  | "goal_pacing"
  | "pastor_verse";

export type CoachPulseStance = "open" | "steer" | "wind_down" | "close";

/**
 * `local` marks a `pastor_verse` row that was displayed without any model call (AI disabled or
 * unconfigured) — durable so the 7-day no-repeat rule still holds without AI, but excluded from
 * `computeAiUsageForMonth`'s call count and never treated as an `ok`/`fallback` AI outcome.
 */
export type AiMessageStatus = "ok" | "fallback" | "error" | "skipped" | "local";

export type AiDeltaClass = "progress" | "stall" | "unknown" | "idle";

export type MemoryKind = "pattern" | "preference" | "context" | "commitment" | "principle";

export type AiProposalType =
  | "intention_draft"
  | "tomorrow_focus_draft"
  | "memory"
  | "commitment"
  | "review_section_draft"
  | "weekly_objective"
  | "gtd_action"
  | "goal_evaluation";

export type WeeklySynthesisGtdAction = "schedule" | "defer" | "delegate" | "drop";

export type AiMemoryStatus = "active" | "archived" | "contradicted";

export type AiMemorySource = "ai_extracted" | "user_pinned" | "derived";

export interface AiMemory {
  id: string;
  kind: MemoryKind;
  statement: string;
  detail: string;
  confidence: number;
  source: AiMemorySource;
  status: AiMemoryStatus;
  evidenceFrom: string | null;
  evidenceTo: string | null;
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt: string | null;
  pinned: boolean;
}

export interface AiMemoryFilters {
  status?: AiMemoryStatus | AiMemoryStatus[];
  kind?: MemoryKind | MemoryKind[];
  pinned?: boolean;
  /** Include active commitments expiring on or after this local date. */
  activeOnDate?: string;
}

export type AiProposalStatus = "pending" | "accepted" | "dismissed" | "expired";

export interface CoachPulseMove {
  what: string;
  why: string;
  horizon: "now" | "today" | "tomorrow";
}

export interface CoachPulsePriority {
  taskId: string | null;
  title: string;
  why: string;
}

export interface CoachPulseCommitmentCheck {
  commitment: string;
  progress: string;
  question: string;
}

export interface CoachPulseFrictionPoint {
  what: string;
  why: string;
  adjustment: string;
}

export interface CoachPulseCommitment {
  statement: string;
  metricKey: MetricKey | null;
  target: number | null;
}

export interface CoachPulseMemoryCandidate {
  kind: MemoryKind;
  statement: string;
  confidence: number;
}

export interface CoachPulseResponse {
  stance: CoachPulseStance;
  headline: string;
  read: string;
  move: CoachPulseMove | null;
  priorities?: CoachPulsePriority[];
  intentionDraft?: string;
  commitmentCheck?: CoachPulseCommitmentCheck | null;
  wins?: string[];
  frictionPoint?: CoachPulseFrictionPoint;
  principleToRecover?: PrincipleKey | null;
  tomorrowFocusDraft?: string;
  commitment?: CoachPulseCommitment | null;
  memoryCandidates?: CoachPulseMemoryCandidate[];
}

export interface AiMessage {
  id: string;
  surface: AiSurface;
  scopeKey: string;
  stance: CoachPulseStance | null;
  kind: string;
  inputHash: string;
  promptVersion: string;
  model: string;
  status: AiMessageStatus;
  bodyJson: string | null;
  bodyText: string | null;
  deltaClass: AiDeltaClass | null;
  notified: boolean;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface AiProposal {
  id: string;
  messageId: string;
  type: AiProposalType;
  payloadJson: string;
  status: AiProposalStatus;
  appliedEntityId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AiUsageTotals {
  monthKey: string;
  callCount: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
}

export interface AiUsageSummary extends AiUsageTotals {
  /** Approximate USD; actual OpenRouter pricing varies by model. */
  estimatedCostUsd: number;
}

export interface CoachPulseResult {
  message: AiMessage;
  pulse: CoachPulseResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface WeeklySynthesisObjectiveDraft {
  title: string;
  kind: WeeklyObjectiveKind;
  targetHours: number | null;
  rescuetimeKind: RescueTimeTaxonomy | null;
  rescuetimeThing: string | null;
}

export interface WeeklySynthesisGtdActionDraft {
  taskId: string;
  taskTitle: string;
  action: WeeklySynthesisGtdAction;
  reason: string;
}

export interface WeeklySynthesisResponse {
  headline: string;
  scoreExplanation: string;
  strongestAxis: string;
  weakestAxes: string[];
  sectionDrafts: Partial<Record<WeeklyRitualSectionKey, string>>;
  nextWeekObjectives: WeeklySynthesisObjectiveDraft[];
  gtdActions: WeeklySynthesisGtdActionDraft[];
}

export interface WeeklySynthesisResult {
  message: AiMessage;
  synthesis: WeeklySynthesisResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface MonthlySynthesisGoalEvaluationDraft {
  goalId: string;
  score: number | null;
  trend: AnnualGoalTrend | null;
  notes: string;
  blockers: string;
}

export interface MonthlySynthesisResponse {
  headline: string;
  weekPattern: string;
  sectionDrafts: Partial<Record<MonthlyReviewSectionKey, string>>;
  goalEvaluationDrafts: MonthlySynthesisGoalEvaluationDraft[];
}

export interface MonthlySynthesisResult {
  message: AiMessage;
  synthesis: MonthlySynthesisResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export type GoalPacingRiskLevel = "low" | "medium" | "high";

export interface GoalPacingItem {
  goalId: string;
  onPace: boolean;
  gap: string;
  requiredWeeklyBehaviour: string;
  riskLevel: GoalPacingRiskLevel;
  recommendation: string;
}

export interface GoalPacingResponse {
  goals: GoalPacingItem[];
}

export interface GoalPacingResult {
  message: AiMessage;
  pacing: GoalPacingResponse;
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

/** Bible book code from `src/lib/pastor/bible-books.ts` (e.g. `"PHP"`), not free text. */
export interface BibleReference {
  book: string;
  chapter: number;
  verseStart: number;
  verseEnd: number;
}

/** Preferred translation order is NRSVue → NABRE → AELF → LSG1910 (`src/lib/pastor/translations.ts`). */
export type TranslationCode = "NRSVue" | "NABRE" | "AELF" | "LSG1910";

/**
 * One entry of the checked-in `verses.json` catalog (`src/lib/pastor/verse-catalog.ts`).
 * `translations` may be empty/absent — no verse text is shipped by default; the user pastes
 * verified text later. `note` is an original French reflection, never a Scripture quotation.
 *
 * `principleKeys` is the daily-checklist axis the pick engine matches against
 * (`src/lib/pastor/local-pick.ts`); `credoKeys` is the personal-credo axis the catalog is
 * curated against (`src/domain/credo.ts`). Both are always populated on a parsed entry — an
 * entry authored before `credoKeys` existed has it derived from `principleKeys`.
 */
export interface CatalogVerse {
  id: string;
  reference: BibleReference;
  principleKeys: PrincipleKey[];
  credoKeys: CredoKey[];
  themes?: string[];
  translations?: Partial<Record<TranslationCode, string>>;
  note: string;
}

export type PastorVersePick = "list" | "outside";
export type PastorVerseIntent = "reinforcement" | "new_teaching" | "both";

/**
 * Normalized shape stored in `bodyJson` for `ok`, `fallback`, and `local` `pastor_verse` rows.
 * `reference` is `null` only for the empty-catalog local fallback, which has no verse at all.
 * An off-list (`pick: "outside"`) body never carries model-authored passage text: the card shows
 * only the validated `reference` plus the "read in your Bible" instruction, exactly like a
 * catalog verse with no stored `translations` text (see `pastor-verse-validator.ts`).
 */
export interface PastorVerseBody {
  pick: PastorVersePick;
  verseId: string | null;
  reference: BibleReference | null;
  principleKey: PrincipleKey | null;
  intent: PastorVerseIntent;
  title: string;
  explanation: string;
  practice: string | null;
}

export interface PastorVerseResult {
  message: AiMessage | null;
  body: PastorVerseBody;
  verse: CatalogVerse | null;
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface CoachMessage {
  kind: "morning" | "evening";
  title: string;
  body: string;
  source: "local" | "ai" | "fallback";
  warning?: string;
}
