/**
 * Explicit day reconciliation shared by `MemoryRepository` and `TauriSqliteRepository`.
 *
 * Repository reads (`listTasks`, `computeDailyTaskStats`, `getDailyTaskBreakdown`,
 * `computeDailyPomodoroStats`, `getDailyEntry`, `listDailyEntries*`) are side-effect free.
 * Time-driven writes live here and are called only by the time owners: app bootstrap, the
 * local-day boundary hook, and explicit refreshes (Pomodoro refresh, GTD mutations).
 */
import type { PomodoroState } from "../../domain/types";
import { getTodayDate, getWeekStartSunday } from "../date";
import type { AppRepository } from "../storage/repository";

export interface ReconcileDayResult {
  /** Recurring task occurrences generated for the reconciled day. */
  generatedRecurrences: number;
  /** Due Scheduled tasks promoted to Next Actions. */
  promotedScheduled: number;
  /** `weekly_carryover` events written for the most recent Sunday (0 when already applied). */
  carryoverEvents: number;
  /** Pomodoro state after expired sessions were auto-completed. */
  pomodoroState: PomodoroState;
}

export type ReconcileDayPort = Pick<
  AppRepository,
  | "generateDueRecurringTasks"
  | "promoteDueScheduledTasks"
  | "applyWeeklyCarryover"
  | "completeExpiredPomodoroSessions"
>;

/**
 * Runs, in order: recurrence generation for `date`, promotion of due Scheduled tasks,
 * weekly carryover for the most recent Sunday on or before `date` (back-filling a Sunday the
 * app was not opened on; never a future Sunday), then auto-completion of expired Pomodoro
 * sessions at `now`.
 *
 * Every step is idempotent (recurrences by occurrence date, promotion by bucket, carryover by
 * `weekly_carryover:<sunday>:<taskId>` dedupe key), so running it repeatedly is safe. Scheduled
 * promotion never looks past today even if a future `date` is passed.
 */
export const reconcileGtdDay = async (
  repository: ReconcileDayPort,
  date: string,
  now?: string,
): Promise<ReconcileDayResult> => {
  const today = getTodayDate();
  const generatedRecurrences = await repository.generateDueRecurringTasks(date);
  const promotedScheduled = await repository.promoteDueScheduledTasks(date <= today ? date : today);
  // `getWeekStartSunday` always returns a Sunday, and clamping to today means it is never in the
  // future. On a weekday this back-fills the Sunday that started the current week.
  const carryoverEvents = await repository.applyWeeklyCarryover(
    getWeekStartSunday(date <= today ? date : today),
  );
  const pomodoroState = await repository.completeExpiredPomodoroSessions(now);

  return { generatedRecurrences, promotedScheduled, carryoverEvents, pomodoroState };
};
