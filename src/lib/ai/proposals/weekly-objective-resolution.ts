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
