// Pure 90-day suppression window for dismissed category suggestions. See
// specs/todo/finance.md "Learning from corrections": "Dismissing a suggestion
// records a negative signal: the (merchantKey, suggestedCategory) pair is
// suppressed for future ... suggestions for 90 days." The repository stores
// build `DismissedSuggestionPair[]` from `finance_category_suggestions` rows
// with `status = 'dismissed'`; this module has no I/O of its own.

export interface DismissedSuggestionPair {
  merchantKey: string;
  categoryId: string;
  /** ISO timestamp (or local date) the suggestion was dismissed. */
  dismissedAt: string;
}

export const DISMISSED_SUGGESTION_SUPPRESSION_WINDOW_DAYS = 90;

const daysBetween = (fromIso: string, toIso: string): number => {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return (to - from) / 86_400_000;
};

/**
 * True when `(merchantKey, categoryId)` was dismissed within the last 90
 * days of `today` (injectable so tests never depend on the real clock).
 */
export const isSuggestionDismissed = (
  dismissed: DismissedSuggestionPair[],
  merchantKey: string,
  categoryId: string,
  today: string,
): boolean =>
  dismissed.some(
    (pair) =>
      pair.merchantKey === merchantKey &&
      pair.categoryId === categoryId &&
      daysBetween(pair.dismissedAt, today) >= 0 &&
      daysBetween(pair.dismissedAt, today) < DISMISSED_SUGGESTION_SUPPRESSION_WINDOW_DAYS,
  );
