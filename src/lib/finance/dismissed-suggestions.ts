// Pure 90-day suppression window for dismissed category suggestions. See
// specs/done/finance.md "Learning from corrections": "Dismissing a suggestion
// records a negative signal: the (merchantKey, suggestedCategory) pair is
// suppressed for future ... suggestions for 90 days." The repository stores
// build `DismissedSuggestionPair[]` from `finance_category_suggestions` rows
// with `status = 'dismissed'`; this module has no I/O of its own.

import { toLocalDateInputValue } from "../date";

export interface DismissedSuggestionPair {
  merchantKey: string;
  categoryId: string;
  /** ISO timestamp (or a bare local YYYY-MM-DD) the suggestion was dismissed. */
  dismissedAt: string;
}

export const DISMISSED_SUGGESTION_SUPPRESSION_WINDOW_DAYS = 90;

/**
 * Normalizes a possibly-timestamped value to a local `YYYY-MM-DD`. A bare
 * 10-character date is already a local calendar date and is returned as-is —
 * routing it through `Date` parsing would read it as UTC midnight and could
 * shift it a day in a negative-UTC-offset zone (`vite.config.ts` pins tests
 * to `America/Toronto`). A full ISO timestamp (e.g. `nowIso()`, always UTC)
 * is converted to the equivalent local calendar date via `toLocalDateInputValue`.
 */
const toLocalDate = (value: string): string =>
  value.length === 10 ? value : toLocalDateInputValue(value);

const epochDay = (localDate: string): number => {
  const [year, month, day] = localDate.split("-").map((part) => Number.parseInt(part, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

/** Whole local calendar days between two local `YYYY-MM-DD` dates (never fractional). */
const daysBetween = (fromLocalDate: string, toLocalDateValue: string): number =>
  epochDay(toLocalDateValue) - epochDay(fromLocalDate);

/**
 * True when `(merchantKey, categoryId)` was dismissed within the last 90
 * local calendar days of `today` (injectable local `YYYY-MM-DD` so tests
 * never depend on the real clock). Both `dismissedAt` and `today` are
 * normalized to a local calendar date before the day-difference arithmetic,
 * so a same-day dismissal reliably compares as 0 days regardless of either
 * value's time-of-day component.
 */
export const isSuggestionDismissed = (
  dismissed: DismissedSuggestionPair[],
  merchantKey: string,
  categoryId: string,
  today: string,
): boolean => {
  const todayLocalDate = toLocalDate(today);
  return dismissed.some((pair) => {
    if (pair.merchantKey !== merchantKey || pair.categoryId !== categoryId) {
      return false;
    }
    const diff = daysBetween(toLocalDate(pair.dismissedAt), todayLocalDate);
    return diff >= 0 && diff < DISMISSED_SUGGESTION_SUPPRESSION_WINDOW_DAYS;
  });
};
