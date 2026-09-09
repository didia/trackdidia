import type {
  EmailTriageClassifierDecision,
  EmailTriageClassifierOutput,
  EmailTriageIgnoreReason,
  EmailTriageRelevance,
} from "../../domain/email-triage";
import {
  EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
  EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
} from "./constants";

const VALID_DECISIONS = new Set<EmailTriageClassifierDecision>(["relevant", "ignore", "review"]);
const VALID_RELEVANCE = new Set<NonNullable<EmailTriageRelevance>>([
  "action_required",
  "information_to_retain",
]);
const VALID_IGNORE_REASONS = new Set<NonNullable<EmailTriageIgnoreReason>>([
  "newsletter",
  "promotion",
  "automated_notification",
  "receipt_or_confirmation",
  "social_update",
  "spam_or_suspicious",
  "low_value_fyi",
  "other",
]);

const ALLOWED_KEYS = new Set([
  "decision",
  "relevance",
  "ignoreReason",
  "confidence",
  "summary",
  "rationale",
  "suggestedTaskTitle",
]);

export interface ClassifierValidationResult {
  ok: boolean;
  output: EmailTriageClassifierOutput | null;
  errors: string[];
}

export const parseClassifierJson = (raw: string): ClassifierValidationResult => {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, output: null, errors: ["malformed_json"] };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, output: null, errors: ["not_object"] };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`unexpected_field:${key}`);
    }
  }

  const decision = record.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision as EmailTriageClassifierDecision)) {
    errors.push("invalid_decision");
  }

  const relevance = record.relevance;
  if (relevance !== null && (typeof relevance !== "string" || !VALID_RELEVANCE.has(relevance as NonNullable<EmailTriageRelevance>))) {
    errors.push("invalid_relevance");
  }

  const ignoreReason = record.ignoreReason;
  if (
    ignoreReason !== null &&
    (typeof ignoreReason !== "string" ||
      !VALID_IGNORE_REASONS.has(ignoreReason as NonNullable<EmailTriageIgnoreReason>))
  ) {
    errors.push("invalid_ignore_reason");
  }

  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("invalid_confidence");
  }

  for (const field of ["summary", "rationale", "suggestedTaskTitle"] as const) {
    if (typeof record[field] !== "string") {
      errors.push(`invalid_${field}`);
    }
  }

  const typedDecision = decision as EmailTriageClassifierDecision;
  const typedRelevance = (relevance ?? null) as EmailTriageRelevance;
  const typedIgnoreReason = (ignoreReason ?? null) as EmailTriageIgnoreReason;

  if (typedDecision === "relevant" && typedRelevance === null) {
    errors.push("relevant_missing_relevance");
  }
  if (typedDecision === "relevant" && typedIgnoreReason !== null) {
    errors.push("relevant_with_ignore_reason");
  }
  if (typedDecision === "ignore" && typedIgnoreReason === null) {
    errors.push("ignore_missing_reason");
  }
  if (typedDecision === "ignore" && typedRelevance !== null) {
    errors.push("ignore_with_relevance");
  }
  if (typedDecision === "review" && typedRelevance !== null) {
    errors.push("review_with_relevance");
  }
  if (typedDecision === "review" && typedIgnoreReason !== null) {
    errors.push("review_with_ignore_reason");
  }

  if (errors.length > 0) {
    return { ok: false, output: null, errors };
  }

  return {
    ok: true,
    errors: [],
    output: {
      decision: typedDecision,
      relevance: typedRelevance,
      ignoreReason: typedIgnoreReason,
      confidence: confidence as number,
      summary: record.summary as string,
      rationale: record.rationale as string,
      suggestedTaskTitle: record.suggestedTaskTitle as string,
    },
  };
};

export interface ThresholdRoutingInput {
  output: EmailTriageClassifierOutput;
  reviewReasons: string[];
  relevantThreshold?: number;
  ignoreThreshold?: number;
}

export const applyClassifierThresholds = ({
  output,
  reviewReasons,
  relevantThreshold = EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
  ignoreThreshold = EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
}: ThresholdRoutingInput): EmailTriageClassifierDecision => {
  if (output.decision === "review" || reviewReasons.length > 0) {
    return "review";
  }
  if (output.decision === "relevant") {
    return output.confidence >= relevantThreshold ? "relevant" : "review";
  }
  if (output.decision === "ignore") {
    return output.confidence >= ignoreThreshold ? "ignore" : "review";
  }
  return "review";
};
