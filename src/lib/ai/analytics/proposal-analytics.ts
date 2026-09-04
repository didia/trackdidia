import type {
  AiMessage,
  AiProposal,
  AiProposalStatus,
  AiProposalType,
  AiSurface,
  CoachPulseStance,
} from "../../../domain/types";
import { t } from "../../../i18n";
import { promptVersionForSurface } from "../prompts/registry";
import { toLocalDateKey } from "./month-range";

export interface AiProposalWithMessage {
  proposal: AiProposal;
  message: AiMessage;
}

export interface AcceptanceRateBucket {
  key: string;
  label: string;
  total: number;
  accepted: number;
  dismissed: number;
  pending: number;
  expired: number;
  decided: number;
  acceptanceRate: number | null;
  dismissalRate: number | null;
}

export interface DismissalTrendPoint {
  date: string;
  dismissed: number;
  decided: number;
  dismissalRate: number | null;
}

export interface LowAcceptanceSignal {
  dimension: "surface" | "type" | "stance";
  key: string;
  label: string;
  acceptanceRate: number;
  sampleSize: number;
  promptVersion: string | null;
  note: string;
}

export interface CoachAnalyticsSummary {
  bySurface: AcceptanceRateBucket[];
  byType: AcceptanceRateBucket[];
  byStance: AcceptanceRateBucket[];
  dismissalTrend: DismissalTrendPoint[];
  lowAcceptanceSignals: LowAcceptanceSignal[];
}

const DECIDED_STATUSES: AiProposalStatus[] = ["accepted", "dismissed"];

const SURFACE_LABELS: Record<AiSurface, string> = {
  coach_pulse: t("analytics.surface.coach_pulse", { ns: "coach" }),
  weekly_synthesis: t("analytics.surface.weekly_synthesis", { ns: "coach" }),
  monthly_synthesis: t("analytics.surface.monthly_synthesis", { ns: "coach" }),
  goal_pacing: t("analytics.surface.goal_pacing", { ns: "coach" }),
};

const TYPE_LABELS: Record<AiProposalType, string> = {
  intention_draft: t("analytics.type.intention_draft", { ns: "coach" }),
  tomorrow_focus_draft: t("analytics.type.tomorrow_focus_draft", { ns: "coach" }),
  memory: t("analytics.type.memory", { ns: "coach" }),
  commitment: t("analytics.type.commitment", { ns: "coach" }),
  review_section_draft: t("analytics.type.review_section_draft", { ns: "coach" }),
  weekly_objective: t("analytics.type.weekly_objective", { ns: "coach" }),
  gtd_action: t("analytics.type.gtd_action", { ns: "coach" }),
  goal_evaluation: t("analytics.type.goal_evaluation", { ns: "coach" }),
};

const STANCE_LABELS: Record<CoachPulseStance, string> = {
  open: t("analytics.stance.open", { ns: "coach" }),
  steer: t("analytics.stance.steer", { ns: "coach" }),
  wind_down: t("analytics.stance.wind_down", { ns: "coach" }),
  close: t("analytics.stance.close", { ns: "coach" }),
};

const LOW_ACCEPTANCE_THRESHOLD = 0.35;
const LOW_ACCEPTANCE_MIN_SAMPLE = 3;
const PROMPT_REVISION_NOTE = t("promptRevisionNote", { ns: "coach" });

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

const emptyBucket = (key: string, label: string): AcceptanceRateBucket => ({
  key,
  label,
  total: 0,
  accepted: 0,
  dismissed: 0,
  pending: 0,
  expired: 0,
  decided: 0,
  acceptanceRate: null,
  dismissalRate: null,
});

const finalizeBucket = (bucket: AcceptanceRateBucket): AcceptanceRateBucket => ({
  ...bucket,
  decided: bucket.accepted + bucket.dismissed,
  acceptanceRate: rate(bucket.accepted, bucket.accepted + bucket.dismissed),
  dismissalRate: rate(bucket.dismissed, bucket.accepted + bucket.dismissed),
});

export const joinProposalsWithMessages = (
  proposals: AiProposal[],
  messages: AiMessage[],
): AiProposalWithMessage[] => {
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  return proposals
    .map((proposal) => {
      const message = messagesById.get(proposal.messageId);
      return message ? { proposal, message } : null;
    })
    .filter((row): row is AiProposalWithMessage => row !== null);
};

const accumulateStatus = (
  bucket: AcceptanceRateBucket,
  status: AiProposalStatus,
): AcceptanceRateBucket => {
  const next = { ...bucket, total: bucket.total + 1 };
  if (status === "accepted") {
    next.accepted += 1;
  } else if (status === "dismissed") {
    next.dismissed += 1;
  } else if (status === "pending") {
    next.pending += 1;
  } else {
    next.expired += 1;
  }
  return next;
};

const buildBuckets = <T extends string>(
  rows: AiProposalWithMessage[],
  pickKey: (row: AiProposalWithMessage) => T | null,
  labels: Record<T, string>,
): AcceptanceRateBucket[] => {
  const buckets = new Map<string, AcceptanceRateBucket>();

  for (const row of rows) {
    const key = pickKey(row);
    if (!key) {
      continue;
    }

    const existing = buckets.get(key) ?? emptyBucket(key, labels[key as T] ?? key);
    buckets.set(key, accumulateStatus(existing, row.proposal.status));
  }

  return [...buckets.values()]
    .map(finalizeBucket)
    .sort(
      (left, right) => right.decided - left.decided || left.label.localeCompare(right.label, "fr"),
    );
};

export const computeAcceptanceRatesBySurface = (
  rows: AiProposalWithMessage[],
): AcceptanceRateBucket[] => buildBuckets(rows, (row) => row.message.surface, SURFACE_LABELS);

export const computeAcceptanceRatesByType = (
  rows: AiProposalWithMessage[],
): AcceptanceRateBucket[] => buildBuckets(rows, (row) => row.proposal.type, TYPE_LABELS);

export const computeAcceptanceRatesByStance = (
  rows: AiProposalWithMessage[],
): AcceptanceRateBucket[] =>
  buildBuckets(
    rows.filter((row) => row.message.surface === "coach_pulse" && row.message.stance),
    (row) => row.message.stance,
    STANCE_LABELS,
  );

export const computeDismissalTrend = (
  rows: AiProposalWithMessage[],
  lastNDays = 30,
  referenceDate = new Date(),
): DismissalTrendPoint[] => {
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (lastNDays - 1));

  const points = new Map<string, DismissalTrendPoint>();
  for (let offset = 0; offset < lastNDays; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const date = toLocalDateKey(day.toISOString());
    points.set(date, { date, dismissed: 0, decided: 0, dismissalRate: null });
  }

  for (const row of rows) {
    if (!DECIDED_STATUSES.includes(row.proposal.status)) {
      continue;
    }

    const timestamp = row.proposal.decidedAt ?? row.proposal.createdAt;
    const date = toLocalDateKey(timestamp);
    const point = points.get(date);
    if (!point) {
      continue;
    }

    point.decided += 1;
    if (row.proposal.status === "dismissed") {
      point.dismissed += 1;
    }
  }

  return [...points.values()].map((point) => ({
    ...point,
    dismissalRate: rate(point.dismissed, point.decided),
  }));
};

const lowAcceptanceFromBuckets = (
  dimension: LowAcceptanceSignal["dimension"],
  buckets: AcceptanceRateBucket[],
  promptVersionForKey: (key: string) => string | null,
): LowAcceptanceSignal[] =>
  buckets
    .filter(
      (bucket) =>
        bucket.decided >= LOW_ACCEPTANCE_MIN_SAMPLE &&
        bucket.acceptanceRate !== null &&
        bucket.acceptanceRate < LOW_ACCEPTANCE_THRESHOLD,
    )
    .map((bucket) => ({
      dimension,
      key: bucket.key,
      label: bucket.label,
      acceptanceRate: bucket.acceptanceRate as number,
      sampleSize: bucket.decided,
      promptVersion: promptVersionForKey(bucket.key),
      note: PROMPT_REVISION_NOTE,
    }));

export const flagLowAcceptanceSignals = (summary: {
  bySurface: AcceptanceRateBucket[];
  byType: AcceptanceRateBucket[];
  byStance: AcceptanceRateBucket[];
}): LowAcceptanceSignal[] => [
  ...lowAcceptanceFromBuckets("surface", summary.bySurface, (key) =>
    promptVersionForSurface(key as AiSurface),
  ),
  ...lowAcceptanceFromBuckets("type", summary.byType, () => null),
  ...lowAcceptanceFromBuckets("stance", summary.byStance, () =>
    promptVersionForSurface("coach_pulse"),
  ),
];

export const buildCoachAnalyticsSummary = (
  rows: AiProposalWithMessage[],
  referenceDate = new Date(),
): CoachAnalyticsSummary => {
  const bySurface = computeAcceptanceRatesBySurface(rows);
  const byType = computeAcceptanceRatesByType(rows);
  const byStance = computeAcceptanceRatesByStance(rows);
  const dismissalTrend = computeDismissalTrend(rows, 30, referenceDate);
  const lowAcceptanceSignals = flagLowAcceptanceSignals({ bySurface, byType, byStance });

  return {
    bySurface,
    byType,
    byStance,
    dismissalTrend,
    lowAcceptanceSignals,
  };
};
