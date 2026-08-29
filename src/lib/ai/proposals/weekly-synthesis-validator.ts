import type {
  RescueTimeTaxonomy,
  WeeklyObjectiveKind,
  WeeklyRitualSectionKey,
  WeeklySynthesisGtdAction,
  WeeklySynthesisResponse
} from "../../../domain/types";

const ritualSectionKeys = new Set<WeeklyRitualSectionKey>([
  "bilan",
  "budget",
  "tempsEtPlan",
  "collecte",
  "calendrier",
  "gtd",
  "alignement",
  "dimanche"
]);

const objectiveKinds = new Set<WeeklyObjectiveKind>(["time", "manual"]);
const rescuetimeKinds = new Set<RescueTimeTaxonomy>(["overview", "category", "activity", "productivity"]);
const gtdActions = new Set<WeeklySynthesisGtdAction>(["schedule", "defer", "delegate", "drop"]);

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
    if (!ritualSectionKeys.has(key as WeeklyRitualSectionKey)) {
      return `sectionDrafts contains invalid key: ${key}`;
    }

    if (typeof draft !== "string") {
      return "each section draft must be a string";
    }
  }

  return null;
};

const validateNextWeekObjectives = (value: unknown): string | null => {
  if (value === undefined) {
    return "nextWeekObjectives is required";
  }

  if (!Array.isArray(value)) {
    return "nextWeekObjectives must be an array";
  }

  if (value.length > 5) {
    return "nextWeekObjectives must contain at most 5 items";
  }

  for (const objective of value) {
    if (typeof objective !== "object" || objective === null) {
      return "each nextWeekObjective must be an object";
    }

    const item = objective as Record<string, unknown>;
    if (!isNonEmptyString(item.title) || !objectiveKinds.has(String(item.kind) as WeeklyObjectiveKind)) {
      return "nextWeekObjective requires title and kind";
    }

    if (item.targetHours !== null && item.targetHours !== undefined && typeof item.targetHours !== "number") {
      return "nextWeekObjective targetHours must be a number or null";
    }

    if (
      item.rescuetimeKind !== null &&
      item.rescuetimeKind !== undefined &&
      !rescuetimeKinds.has(String(item.rescuetimeKind) as RescueTimeTaxonomy)
    ) {
      return "nextWeekObjective rescuetimeKind is invalid";
    }

    if (item.rescuetimeThing !== null && item.rescuetimeThing !== undefined && typeof item.rescuetimeThing !== "string") {
      return "nextWeekObjective rescuetimeThing must be a string or null";
    }
  }

  return null;
};

const validateGtdActions = (value: unknown): string | null => {
  if (value === undefined) {
    return "gtdActions is required";
  }

  if (!Array.isArray(value)) {
    return "gtdActions must be an array";
  }

  for (const action of value) {
    if (typeof action !== "object" || action === null) {
      return "each gtdAction must be an object";
    }

    const item = action as Record<string, unknown>;
    if (
      !isNonEmptyString(item.taskId) ||
      !gtdActions.has(String(item.action) as WeeklySynthesisGtdAction) ||
      !isNonEmptyString(item.reason)
    ) {
      return "gtdAction requires taskId, action, and reason";
    }
  }

  return null;
};

export const validateWeeklySynthesisResponse = (
  payload: unknown
): { ok: true; value: WeeklySynthesisResponse } | { ok: false; error: string } => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;

  if (!isNonEmptyString(record.headline) || !isNonEmptyString(record.scoreExplanation)) {
    return { ok: false, error: "headline and scoreExplanation are required strings" };
  }

  if (!isNonEmptyString(record.strongestAxis)) {
    return { ok: false, error: "strongestAxis is required" };
  }

  if (!Array.isArray(record.weakestAxes) || record.weakestAxes.length !== 2) {
    return { ok: false, error: "weakestAxes must be an array of exactly 2 strings" };
  }

  if (!record.weakestAxes.every(isNonEmptyString)) {
    return { ok: false, error: "weakestAxes entries must be non-empty strings" };
  }

  const sectionDraftsError = validateSectionDrafts(record.sectionDrafts);
  if (sectionDraftsError) {
    return { ok: false, error: sectionDraftsError };
  }

  const objectivesError = validateNextWeekObjectives(record.nextWeekObjectives);
  if (objectivesError) {
    return { ok: false, error: objectivesError };
  }

  const gtdActionsError = validateGtdActions(record.gtdActions);
  if (gtdActionsError) {
    return { ok: false, error: gtdActionsError };
  }

  return { ok: true, value: record as unknown as WeeklySynthesisResponse };
};

export const parseWeeklySynthesisJson = (
  raw: string
): { ok: true; value: WeeklySynthesisResponse } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateWeeklySynthesisResponse(parsed);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
