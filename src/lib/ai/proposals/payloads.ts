import { metricDefinitions } from "../../../domain/definitions";
import type {
  AiMemory,
  AiProposal,
  AnnualGoalTrend,
  MemoryKind,
  MetricKey,
  MonthlyReviewSectionKey,
  RescueTimeTaxonomy,
  WeeklyRitualSectionKey,
} from "../../../domain/types";

export interface MemoryProposalPayload {
  kind: MemoryKind;
  statement: string;
  confidence: number;
  detail?: string;
  evidenceFrom?: string | null;
  evidenceTo?: string | null;
  expiresAt?: string | null;
  source?: AiMemory["source"];
  pinned?: boolean;
}
export interface CommitmentProposalPayload {
  statement: string;
  metricKey?: MetricKey | null;
  target?: number | null;
}
export interface WeeklyObjectivePayload {
  title: string;
  kind: "time" | "manual";
  targetHours: number | null;
  rescuetimeKind: RescueTimeTaxonomy | null;
  rescuetimeThing: string | null;
}
export interface GoalEvaluationPayload {
  goalId: string;
  monthKey: string;
  score: number | null;
  trend: AnnualGoalTrend | null;
  notes: string;
  blockers: string;
}
export type DecodedProposal =
  | { type: "intention_draft" | "tomorrow_focus_draft"; payload: { text: string } }
  | {
      type: "review_section_draft";
      payload: { sectionKey: WeeklyRitualSectionKey | MonthlyReviewSectionKey; text: string };
    }
  | { type: "weekly_objective"; payload: WeeklyObjectivePayload }
  | {
      type: "gtd_action";
      payload: {
        taskId: string;
        action: "schedule" | "defer" | "delegate" | "drop";
        reason: string;
        taskTitle?: string;
      };
    }
  | { type: "goal_evaluation"; payload: GoalEvaluationPayload }
  | { type: "memory"; payload: MemoryProposalPayload }
  | { type: "commitment"; payload: CommitmentProposalPayload }
  | { type: "invalid" };

const weeklySections = [
  "bilan",
  "budget",
  "tempsEtPlan",
  "collecte",
  "calendrier",
  "gtd",
  "alignement",
  "dimanche",
] as const;
const monthlySections = [
  "bilan",
  "journaux",
  "finances",
  "temps",
  "progressionObjectifs",
  "missionObjectifs",
  "nettoyageListes",
  "calendrier",
  "grosProjets",
  "developpement",
] as const;
const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.some((item) => item === value);
export const isWeeklySectionKey = (value: unknown): value is WeeklyRitualSectionKey =>
  member(weeklySections, value);
export const isMonthlySectionKey = (value: unknown): value is MonthlyReviewSectionKey =>
  member(monthlySections, value);
const text = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());
const optionalString = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === "string";
const optionalNumber = (value: unknown): value is number | null | undefined =>
  value == null || (typeof value === "number" && Number.isFinite(value));
const invalid: DecodedProposal = { type: "invalid" };

/** Persisted proposals are untrusted input; every consumer uses this decoder. */
export const decodeProposal = (
  proposal: Pick<AiProposal, "type" | "payloadJson">,
): DecodedProposal => {
  let payload: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(proposal.payloadJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
    payload = value as Record<string, unknown>;
  } catch {
    return invalid;
  }
  switch (proposal.type) {
    case "intention_draft":
    case "tomorrow_focus_draft":
      return text(payload.text)
        ? { type: proposal.type, payload: { text: payload.text } }
        : invalid;
    case "review_section_draft":
      return (isWeeklySectionKey(payload.sectionKey) || isMonthlySectionKey(payload.sectionKey)) &&
        text(payload.text)
        ? {
            type: proposal.type,
            payload: { sectionKey: payload.sectionKey, text: payload.text.trim() },
          }
        : invalid;
    case "weekly_objective": {
      if (
        !text(payload.title) ||
        (payload.kind != null && !member(["time", "manual"], payload.kind)) ||
        !optionalNumber(payload.targetHours) ||
        (typeof payload.targetHours === "number" && payload.targetHours < 0) ||
        (payload.rescuetimeKind != null &&
          !member(["overview", "category", "activity", "productivity"], payload.rescuetimeKind)) ||
        !optionalString(payload.rescuetimeThing)
      )
        return invalid;
      return {
        type: proposal.type,
        payload: {
          title: payload.title.trim(),
          kind: (payload.kind as "time" | "manual") ?? "manual",
          targetHours: payload.targetHours ?? null,
          rescuetimeKind: (payload.rescuetimeKind as RescueTimeTaxonomy) ?? null,
          rescuetimeThing: payload.rescuetimeThing ?? null,
        },
      };
    }
    case "gtd_action":
      return text(payload.taskId) &&
        member(["schedule", "defer", "delegate", "drop"], payload.action) &&
        optionalString(payload.reason) &&
        optionalString(payload.taskTitle)
        ? {
            type: proposal.type,
            payload: {
              taskId: payload.taskId,
              action: payload.action,
              reason: payload.reason ?? "",
              taskTitle: payload.taskTitle ?? undefined,
            },
          }
        : invalid;
    case "goal_evaluation":
      if (
        !text(payload.goalId) ||
        typeof payload.monthKey !== "string" ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.monthKey) ||
        !optionalNumber(payload.score) ||
        (payload.trend != null && !member(["up", "steady", "down"], payload.trend)) ||
        !optionalString(payload.notes) ||
        !optionalString(payload.blockers)
      )
        return invalid;
      return {
        type: proposal.type,
        payload: {
          goalId: payload.goalId,
          monthKey: payload.monthKey,
          score: payload.score ?? null,
          trend: (payload.trend as AnnualGoalTrend) ?? null,
          notes: payload.notes ?? "",
          blockers: payload.blockers ?? "",
        },
      };
    case "memory":
      if (
        !member(["pattern", "preference", "context", "commitment", "principle"], payload.kind) ||
        !text(payload.statement) ||
        typeof payload.confidence !== "number" ||
        !Number.isFinite(payload.confidence) ||
        payload.confidence < 0 ||
        payload.confidence > 1 ||
        !optionalString(payload.detail) ||
        !optionalString(payload.evidenceFrom) ||
        !optionalString(payload.evidenceTo) ||
        !optionalString(payload.expiresAt) ||
        (payload.source != null &&
          !member(["ai_extracted", "user_pinned", "derived"], payload.source)) ||
        (payload.pinned != null && typeof payload.pinned !== "boolean")
      )
        return invalid;
      return {
        type: proposal.type,
        payload: {
          kind: payload.kind,
          statement: payload.statement,
          confidence: payload.confidence,
          detail: payload.detail ?? undefined,
          evidenceFrom: payload.evidenceFrom,
          evidenceTo: payload.evidenceTo,
          expiresAt: payload.expiresAt,
          source: (payload.source ?? undefined) as AiMemory["source"] | undefined,
          pinned: (payload.pinned ?? undefined) as boolean | undefined,
        },
      };
    case "commitment":
      if (
        !text(payload.statement) ||
        !optionalNumber(payload.target) ||
        (payload.metricKey != null &&
          !member(
            metricDefinitions.map((item) => item.key),
            payload.metricKey,
          ))
      )
        return invalid;
      return {
        type: proposal.type,
        payload: {
          statement: payload.statement,
          metricKey: payload.metricKey as MetricKey | null | undefined,
          target: payload.target,
        },
      };
  }
  return invalid;
};
