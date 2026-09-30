import type { MidWeekSteeringEffort, MidWeekSteeringResponse } from "../../../domain/types";

const MAX_STEERING_ACTIONS = 3;

const efforts = new Set<MidWeekSteeringEffort>(["low", "medium", "high"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

type ValidationResult = { ok: true; value: MidWeekSteeringResponse } | { ok: false; error: string };

/**
 * Validates a steering payload. When `actionableKeys` is given (fresh model output), every
 * `actions[].signalKey` must be one of them and appear once: a green, `unknown` or absent key,
 * or a repeated key, is invalid, and with no actionable key only `actions: []` is valid. Stored
 * rows are re-parsed without `actionableKeys` (they were checked when generated).
 * `asOfDate` is not required from the model: the service sets it from the snapshot.
 */
export const validateMidWeekSteeringResponse = (
  payload: unknown,
  actionableKeys?: string[],
): ValidationResult => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;
  if (
    !isNonEmptyString(record.headline) ||
    !isNonEmptyString(record.read) ||
    !isNonEmptyString(record.focusShift)
  ) {
    return { ok: false, error: "headline, read and focusShift must be non-empty strings" };
  }
  if (!Array.isArray(record.actions)) {
    return { ok: false, error: "actions must be an array" };
  }

  if (record.actions.length > MAX_STEERING_ACTIONS) {
    return { ok: false, error: `actions must contain at most ${MAX_STEERING_ACTIONS} items` };
  }

  const allowed = actionableKeys ? new Set(actionableKeys) : null;
  if (allowed && allowed.size === 0 && record.actions.length > 0) {
    return { ok: false, error: "actions must be empty when no signal is actionable" };
  }

  const seen = new Set<string>();
  for (const action of record.actions) {
    if (typeof action !== "object" || action === null) {
      return { ok: false, error: "each action must be an object" };
    }
    const item = action as Record<string, unknown>;
    if (
      !isNonEmptyString(item.signalKey) ||
      !isNonEmptyString(item.title) ||
      !isNonEmptyString(item.why) ||
      !efforts.has(String(item.effort) as MidWeekSteeringEffort)
    ) {
      return { ok: false, error: "steering action is missing required fields" };
    }
    if (allowed && !allowed.has(item.signalKey)) {
      return { ok: false, error: `signalKey ${item.signalKey} is not an actionable signal` };
    }
    if (seen.has(item.signalKey)) {
      return { ok: false, error: `signalKey ${item.signalKey} is repeated` };
    }
    seen.add(item.signalKey);
  }

  return {
    ok: true,
    value: {
      asOfDate: typeof record.asOfDate === "string" ? record.asOfDate : "",
      headline: record.headline,
      read: record.read,
      focusShift: record.focusShift,
      actions: record.actions as MidWeekSteeringResponse["actions"],
    },
  };
};

export const parseMidWeekSteeringJson = (
  raw: string,
  actionableKeys?: string[],
): ValidationResult => {
  try {
    return validateMidWeekSteeringResponse(JSON.parse(raw) as unknown, actionableKeys);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
