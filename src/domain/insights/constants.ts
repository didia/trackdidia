/**
 * Named tuning constants for the insight engine (spec `ai-integration-v2.md` §3, §14.5).
 * `MIN_SAMPLE_DAYS` is a guess per the spec's open question #5 and is meant to be
 * revisited once phase 0 can report real history sizes.
 */

/** Minimum number of days of evidence required before a correlation or anomaly is reported. */
export const MIN_SAMPLE_DAYS = 10;

/** A next action is "stale" once it has gone untouched for more than this many days. */
export const STALE_NEXT_ACTION_DAYS = 7;

/** A waiting-for item is "aging" once it has gone untouched for more than this many days. */
export const AGING_WAITING_FOR_DAYS = 14;

/** Trailing window used for the short-horizon trend average. */
export const TREND_SHORT_WINDOW_DAYS = 7;

/** Trailing window used for the long-horizon trend average and most rate calculations. */
export const TREND_LONG_WINDOW_DAYS = 28;

/** Daily completed-focus-session target used to normalize focus load (mirrors the weekly `pomodoroTarget` of 56/7). */
export const POMODORO_DAILY_TARGET_SESSIONS = 8;
