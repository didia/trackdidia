import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { DailyEntry } from "../../domain/types";
import { buildWeekDates, listWeekDates } from "../../domain/weekly-review";
import type { AppRepository } from "./repository";

/**
 * Loads the seven decorated daily entries of a week (suggested pomodoro and task metrics
 * applied), filling days with no entry row with an empty entry.
 *
 * Never use `listDailyEntriesInRange` here: it skips `decorateEntry` on purpose, which would
 * remove the suggested metrics.
 */
export const loadDecoratedWeekEntries = async (
  repository: AppRepository,
  weekStartDate: string,
): Promise<DailyEntry[]> => {
  const weekDates = listWeekDates(buildWeekDates(weekStartDate));
  const rows = await Promise.all(weekDates.map((date) => repository.getDailyEntry(date)));
  return weekDates.map((date, index) => rows[index] ?? createEmptyDailyEntry(date));
};
