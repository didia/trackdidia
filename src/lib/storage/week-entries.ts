import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { DailyEntry } from "../../domain/types";
import { buildWeekDates, listWeekDates } from "../../domain/weekly-review";
import type { AppRepository } from "./repository";

/**
 * Loads the seven decorated daily entries of a week (suggested pomodoro and task metrics
 * applied), filling days with no entry row with an empty entry.
 *
 * Repository entry reads are all decorated, so this stays a per-day `getDailyEntry` read;
 * only days with no row fall back to an undecorated empty entry.
 */
export const loadDecoratedWeekEntries = async (
  repository: AppRepository,
  weekStartDate: string,
): Promise<DailyEntry[]> => {
  const weekDates = listWeekDates(buildWeekDates(weekStartDate));
  const rows = await Promise.all(weekDates.map((date) => repository.getDailyEntry(date)));
  return weekDates.map((date, index) => rows[index] ?? createEmptyDailyEntry(date));
};
