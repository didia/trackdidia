import type { RescueTimeVocabulary, WeeklySynthesisObjectiveDraft } from "../../../domain/types";

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The model only sees titles, so it tends to invent `rescuetimeThing` from an objective's title
 * (e.g. a course code) instead of an activity or category RescueTime actually reports, and an
 * invented name always reads back as 0 h. Given the real names, snap a near-exact match
 * (case/whitespace) to the canonical spelling and turn anything unmatched into a manual
 * objective so it never silently tracks nothing. Without a vocabulary the objective is kept as is.
 */
export const resolveObjectiveAgainstVocabulary = (
  objective: WeeklySynthesisObjectiveDraft,
  vocabulary: RescueTimeVocabulary | null | undefined,
): WeeklySynthesisObjectiveDraft => {
  if (
    !vocabulary ||
    objective.kind !== "time" ||
    (objective.rescuetimeKind !== "category" && objective.rescuetimeKind !== "activity") ||
    !objective.rescuetimeThing
  ) {
    return objective;
  }

  const wanted = normalizeName(objective.rescuetimeThing);
  const match = vocabulary[objective.rescuetimeKind].find((name) => normalizeName(name) === wanted);
  if (match) {
    return { ...objective, rescuetimeThing: match };
  }

  return {
    title: objective.title,
    kind: "manual",
    targetHours: null,
    rescuetimeKind: null,
    rescuetimeThing: null,
  };
};

const normalizeLabel = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const MIN_SUBJECT_LENGTH = 5;

/** "more than 25m on MagSelf (Weekdays)" -> "MagSelf"; other titles are used whole. */
const goalSubject = (goalTitle: string): string => {
  const match = goalTitle.match(/\bon (.+) \([^()]*\)\s*$/i);
  return match ? match[1] : goalTitle;
};

/**
 * A RescueTime goal is already scored and listed in the weekly review, so a standing `time`
 * objective about the same subject only duplicates it (and, mapped to an activity, reads 0 h).
 * Matches when the objective's RescueTime name appears in a goal title, or a goal's subject
 * appears in the objective's title.
 */
export const isCoveredByRescueTimeGoal = (
  objective: WeeklySynthesisObjectiveDraft,
  goalTitles: readonly string[],
): boolean => {
  if (objective.kind !== "time") {
    return false;
  }

  const title = normalizeLabel(objective.title);
  const thing = normalizeLabel(objective.rescuetimeThing ?? "");

  return goalTitles.some((goalTitle) => {
    const subject = normalizeLabel(goalSubject(goalTitle));
    return (
      (thing.length >= MIN_SUBJECT_LENGTH && normalizeLabel(goalTitle).includes(thing)) ||
      (subject.length >= MIN_SUBJECT_LENGTH && title.includes(subject))
    );
  });
};
