import { principleDefinitions } from "../definitions";
import type { DailyEntry, PrincipleKey } from "../types";
import { TREND_LONG_WINDOW_DAYS } from "./constants";
import { daysBetweenDates, entriesInTrailingWindow, latestEntryDate, sortEntriesByDate, trailingEvidenceWindow } from "./shared";
import type { Finding } from "./types";

export interface StreakFinding extends Finding {
  principleKey: PrincipleKey;
  /** Consecutive `true` days ending at the reference date (0 when the most recent answered day is false/unanswered). */
  currentStreak: number;
  /** Longest run of consecutive `true` days across the whole provided history. */
  longestStreak: number;
  /** Days elapsed since the last `true`, or `null` when the principle was never `true` in the history. */
  daysSinceLastTrue: number | null;
  /** Share of the trailing 28-day window (or shorter, if less history exists) answered `true`. */
  rate28d: number;
}

/**
 * Per-principle streak stats (spec `ai-integration-v2.md` §3): current streak, longest streak,
 * days since last `true`, 28-day rate. `referenceDate` defaults to the most recent entry's date.
 */
export const computeStreakFindings = (entries: DailyEntry[], referenceDate?: string): StreakFinding[] => {
  const ordered = sortEntriesByDate(entries);
  const reference = referenceDate ?? latestEntryDate(ordered);

  if (!reference) {
    return [];
  }

  const upToReference = ordered.filter((entry) => entry.date <= reference);
  const windowEntries = entriesInTrailingWindow(upToReference, reference, TREND_LONG_WINDOW_DAYS);
  const evidenceWindow = trailingEvidenceWindow(reference, TREND_LONG_WINDOW_DAYS);

  return principleDefinitions.map(({ key }) => {
    let currentStreak = 0;
    let currentStreakPreviousDate: string | null = null;
    for (let index = upToReference.length - 1; index >= 0; index -= 1) {
      const entry = upToReference[index];
      if (entry.principleChecks[key] !== true) {
        break;
      }
      if (currentStreakPreviousDate !== null && daysBetweenDates(entry.date, currentStreakPreviousDate) !== 1) {
        break;
      }
      currentStreak += 1;
      currentStreakPreviousDate = entry.date;
    }

    let longestStreak = 0;
    let runningStreak = 0;
    let longestStreakPreviousDate: string | null = null;
    for (const entry of upToReference) {
      if (entry.principleChecks[key] === true) {
        runningStreak =
          longestStreakPreviousDate !== null && daysBetweenDates(longestStreakPreviousDate, entry.date) === 1
            ? runningStreak + 1
            : 1;
        longestStreak = Math.max(longestStreak, runningStreak);
        longestStreakPreviousDate = entry.date;
      } else {
        runningStreak = 0;
        longestStreakPreviousDate = null;
      }
    }

    let daysSinceLastTrue: number | null = null;
    for (let index = upToReference.length - 1; index >= 0; index -= 1) {
      if (upToReference[index].principleChecks[key] === true) {
        daysSinceLastTrue = daysBetweenDates(upToReference[index].date, reference);
        break;
      }
    }

    const answeredInWindow = windowEntries.filter((entry) => entry.principleChecks[key] !== null);
    const trueInWindow = answeredInWindow.filter((entry) => entry.principleChecks[key] === true);
    const rate28d = answeredInWindow.length > 0 ? trueInWindow.length / answeredInWindow.length : 0;

    const severity: StreakFinding["severity"] =
      currentStreak >= 3 ? "positive" : daysSinceLastTrue !== null && daysSinceLastTrue >= 3 ? "watch" : "info";

    return {
      id: `streak:${key}:${reference}`,
      severity,
      evidenceWindow,
      sampleSize: answeredInWindow.length,
      value: currentStreak,
      label: `Streak actuel de ${currentStreak} jour(s) pour ${key} (taux 28j: ${Math.round(rate28d * 100)}%).`,
      principleKey: key,
      currentStreak,
      longestStreak,
      daysSinceLastTrue,
      rate28d
    };
  });
};
