import type { CoachMessage, DailyEntry } from "../../domain/types";

export type CoachPartOfDay = "morning" | "afternoon" | "evening";

export const resolvePartOfDay = (now: Date = new Date()): CoachPartOfDay => {
  const hour = now.getHours();

  if (hour >= 5 && hour < 12) {
    return "morning";
  }

  if (hour >= 12 && hour < 17) {
    return "afternoon";
  }

  return "evening";
};

export const getLocalTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Text the user has written for a coach slot (informational; no longer gates AI calls). */
export const getCoachInputText = (entry: DailyEntry, partOfDay: CoachPartOfDay): string => {
  if (partOfDay === "morning" || partOfDay === "afternoon") {
    return entry.morningIntention.trim();
  }

  return [entry.nightReflection, entry.tomorrowFocus]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
};

export const buildCoachCacheKey = (
  date: string,
  partOfDay: CoachPartOfDay,
  inputContent: string,
): string => `${date}|${partOfDay}|${inputContent}`;

/** Part of day used for caching a coach slot: evening coach stays evening; morning adapts to morning/afternoon. */
export const resolveCoachCachePartOfDay = (
  kind: CoachMessage["kind"],
  now: Date = new Date(),
): CoachPartOfDay => {
  if (kind === "evening") {
    return "evening";
  }

  const current = resolvePartOfDay(now);
  return current === "evening" ? "morning" : current;
};
