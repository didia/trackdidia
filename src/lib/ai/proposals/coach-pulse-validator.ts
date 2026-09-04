import { metricDefinitions, principleDefinitions } from "../../../domain/definitions";
import type {
  CoachPulseResponse,
  CoachPulseStance,
  MetricKey,
  PrincipleKey,
} from "../../../domain/types";

const metricKeys = new Set(metricDefinitions.map((definition) => definition.key));
const principleKeys = new Set(principleDefinitions.map((definition) => definition.key));
const memoryKinds = new Set(["pattern", "preference", "context", "commitment", "principle"]);
const stances = new Set(["open", "steer", "wind_down", "close"]);
const horizons = new Set(["now", "today", "tomorrow"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const validateMove = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return "move must be an object or null";
  }

  const move = value as Record<string, unknown>;
  if (!isNonEmptyString(move.what) || !isNonEmptyString(move.why)) {
    return "move.what and move.why are required strings";
  }

  if (!horizons.has(String(move.horizon))) {
    return "move.horizon must be now, today, or tomorrow";
  }

  return null;
};

const validateCommitmentCheck = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object" || value === null) {
    return "commitmentCheck must be an object or null";
  }

  const check = value as Record<string, unknown>;
  if (
    !isNonEmptyString(check.commitment) ||
    !isNonEmptyString(check.progress) ||
    !isNonEmptyString(check.question)
  ) {
    return "commitmentCheck fields must be non-empty strings";
  }

  return null;
};

export const validateCoachPulseResponse = (
  payload: unknown,
  expectedStance: CoachPulseStance,
): { ok: true; value: CoachPulseResponse } | { ok: false; error: string } => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;

  if (!stances.has(String(record.stance))) {
    return { ok: false, error: "stance is invalid" };
  }

  if (record.stance !== expectedStance) {
    return { ok: false, error: `stance must be ${expectedStance}` };
  }

  if (!isNonEmptyString(record.headline) || !isNonEmptyString(record.read)) {
    return { ok: false, error: "headline and read are required strings" };
  }

  const moveError = validateMove(record.move);
  if (moveError) {
    return { ok: false, error: moveError };
  }

  if (expectedStance === "open") {
    if (record.priorities !== undefined) {
      if (!Array.isArray(record.priorities) || record.priorities.length > 3) {
        return { ok: false, error: "priorities must be an array with at most 3 items" };
      }

      for (const priority of record.priorities) {
        if (typeof priority !== "object" || priority === null) {
          return { ok: false, error: "each priority must be an object" };
        }

        const item = priority as Record<string, unknown>;
        if (
          !(item.taskId === null || typeof item.taskId === "string") ||
          !isNonEmptyString(item.title) ||
          !isNonEmptyString(item.why)
        ) {
          return { ok: false, error: "priority items require taskId, title, and why" };
        }
      }
    }

    if (!isOptionalString(record.intentionDraft)) {
      return { ok: false, error: "intentionDraft must be a string when present" };
    }
  }

  if (expectedStance === "open" || expectedStance === "steer" || expectedStance === "wind_down") {
    const commitmentCheckError = validateCommitmentCheck(record.commitmentCheck);
    if (commitmentCheckError) {
      return { ok: false, error: commitmentCheckError };
    }
  }

  if (expectedStance === "close") {
    if (record.wins !== undefined) {
      if (!Array.isArray(record.wins) || !record.wins.every(isNonEmptyString)) {
        return { ok: false, error: "wins must be an array of non-empty strings" };
      }
    }

    if (record.frictionPoint !== undefined) {
      if (typeof record.frictionPoint !== "object" || record.frictionPoint === null) {
        return { ok: false, error: "frictionPoint must be an object" };
      }

      const friction = record.frictionPoint as Record<string, unknown>;
      if (
        !isNonEmptyString(friction.what) ||
        !isNonEmptyString(friction.why) ||
        !isNonEmptyString(friction.adjustment)
      ) {
        return { ok: false, error: "frictionPoint requires what, why, and adjustment" };
      }
    }

    if (
      record.principleToRecover !== undefined &&
      record.principleToRecover !== null &&
      !principleKeys.has(String(record.principleToRecover) as PrincipleKey)
    ) {
      return { ok: false, error: "principleToRecover must be a valid principle key or null" };
    }

    if (!isNonEmptyString(record.tomorrowFocusDraft)) {
      return { ok: false, error: "tomorrowFocusDraft is required for close stance" };
    }

    if (record.commitment !== undefined && record.commitment !== null) {
      if (typeof record.commitment !== "object") {
        return { ok: false, error: "commitment must be an object or null" };
      }

      const commitment = record.commitment as Record<string, unknown>;
      if (!isNonEmptyString(commitment.statement)) {
        return { ok: false, error: "commitment.statement is required" };
      }

      if (
        commitment.metricKey !== null &&
        commitment.metricKey !== undefined &&
        !metricKeys.has(String(commitment.metricKey) as MetricKey)
      ) {
        return { ok: false, error: "commitment.metricKey must be a valid metric key or null" };
      }
    }

    if (record.memoryCandidates !== undefined) {
      if (!Array.isArray(record.memoryCandidates)) {
        return { ok: false, error: "memoryCandidates must be an array" };
      }

      for (const candidate of record.memoryCandidates) {
        if (typeof candidate !== "object" || candidate === null) {
          return { ok: false, error: "each memory candidate must be an object" };
        }

        const item = candidate as Record<string, unknown>;
        if (
          !memoryKinds.has(String(item.kind)) ||
          !isNonEmptyString(item.statement) ||
          typeof item.confidence !== "number"
        ) {
          return { ok: false, error: "memory candidate requires kind, statement, and confidence" };
        }
      }
    }
  }

  return { ok: true, value: record as unknown as CoachPulseResponse };
};

export const parseCoachPulseJson = (
  raw: string,
  expectedStance: CoachPulseStance,
): { ok: true; value: CoachPulseResponse } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateCoachPulseResponse(parsed, expectedStance);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
