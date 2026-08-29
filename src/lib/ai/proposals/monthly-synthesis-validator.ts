import type {
  AnnualGoalTrend,
  MonthlyReviewSectionKey,
  MonthlySynthesisResponse
} from "../../../domain/types";

const sectionKeys = new Set<MonthlyReviewSectionKey>([
  "bilan",
  "journaux",
  "finances",
  "temps",
  "progressionObjectifs",
  "missionObjectifs",
  "nettoyageListes",
  "calendrier",
  "grosProjets",
  "developpement"
]);

const trends = new Set<AnnualGoalTrend>(["up", "steady", "down"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateSectionDrafts = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "sectionDrafts must be an object";
  }

  for (const [key, draft] of Object.entries(value)) {
    if (!sectionKeys.has(key as MonthlyReviewSectionKey)) {
      return `sectionDrafts contains invalid key: ${key}`;
    }

    if (typeof draft !== "string") {
      return "each section draft must be a string";
    }
  }

  return null;
};

const validateGoalEvaluationDrafts = (value: unknown): string | null => {
  if (value === undefined) {
    return "goalEvaluationDrafts is required";
  }

  if (!Array.isArray(value)) {
    return "goalEvaluationDrafts must be an array";
  }

  for (const draft of value) {
    if (typeof draft !== "object" || draft === null) {
      return "each goalEvaluationDraft must be an object";
    }

    const item = draft as Record<string, unknown>;
    if (!isNonEmptyString(item.goalId)) {
      return "goalEvaluationDraft requires goalId";
    }

    if (item.score !== null && item.score !== undefined && typeof item.score !== "number") {
      return "goalEvaluationDraft score must be a number or null";
    }

    if (
      item.trend !== null &&
      item.trend !== undefined &&
      !trends.has(String(item.trend) as AnnualGoalTrend)
    ) {
      return "goalEvaluationDraft trend is invalid";
    }

    if (typeof item.notes !== "string" || typeof item.blockers !== "string") {
      return "goalEvaluationDraft notes and blockers must be strings";
    }
  }

  return null;
};

export const validateMonthlySynthesisResponse = (
  payload: unknown
): { ok: true; value: MonthlySynthesisResponse } | { ok: false; error: string } => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;

  if (!isNonEmptyString(record.headline) || !isNonEmptyString(record.weekPattern)) {
    return { ok: false, error: "headline and weekPattern are required strings" };
  }

  const sectionDraftsError = validateSectionDrafts(record.sectionDrafts);
  if (sectionDraftsError) {
    return { ok: false, error: sectionDraftsError };
  }

  const goalEvaluationsError = validateGoalEvaluationDrafts(record.goalEvaluationDrafts);
  if (goalEvaluationsError) {
    return { ok: false, error: goalEvaluationsError };
  }

  return { ok: true, value: record as unknown as MonthlySynthesisResponse };
};

export const parseMonthlySynthesisJson = (
  raw: string
): { ok: true; value: MonthlySynthesisResponse } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateMonthlySynthesisResponse(parsed);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
