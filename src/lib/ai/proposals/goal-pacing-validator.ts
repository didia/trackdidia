import type { GoalPacingResponse, GoalPacingRiskLevel } from "../../../domain/types";

const riskLevels = new Set<GoalPacingRiskLevel>(["low", "medium", "high"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const validateGoalPacingResponse = (
  payload: unknown,
): { ok: true; value: GoalPacingResponse } | { ok: false; error: string } => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;

  if (!Array.isArray(record.goals)) {
    return { ok: false, error: "goals must be an array" };
  }

  for (const goal of record.goals) {
    if (typeof goal !== "object" || goal === null) {
      return { ok: false, error: "each goal must be an object" };
    }

    const item = goal as Record<string, unknown>;
    if (
      !isNonEmptyString(item.goalId) ||
      typeof item.onPace !== "boolean" ||
      !isNonEmptyString(item.gap) ||
      !isNonEmptyString(item.requiredWeeklyBehaviour) ||
      !riskLevels.has(String(item.riskLevel) as GoalPacingRiskLevel) ||
      !isNonEmptyString(item.recommendation)
    ) {
      return { ok: false, error: "goal pacing item is missing required fields" };
    }
  }

  return { ok: true, value: record as unknown as GoalPacingResponse };
};

export const parseGoalPacingJson = (
  raw: string,
): { ok: true; value: GoalPacingResponse } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateGoalPacingResponse(parsed);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
