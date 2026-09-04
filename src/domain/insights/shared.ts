import { addDays } from "../../lib/gtd/shared";
import type { DailyEntry } from "../types";
import type { EvidenceWindow } from "./types";

/** Internal helpers shared across the insight engine modules. Not part of the spec's module table. */

export const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const sortEntriesByDate = (entries: DailyEntry[]): DailyEntry[] =>
  [...entries].sort((left, right) => left.date.localeCompare(right.date));

export const daysBetweenDates = (from: string, to: string): number => {
  const startMs = new Date(`${from}T12:00:00`).getTime();
  const endMs = new Date(`${to}T12:00:00`).getTime();
  return Math.round((endMs - startMs) / 86400000);
};

/** Entries whose date falls within the trailing `windowDays` ending at `referenceDate`, inclusive. */
export const entriesInTrailingWindow = (
  entries: DailyEntry[],
  referenceDate: string,
  windowDays: number,
): DailyEntry[] => {
  const from = addDays(referenceDate, -(windowDays - 1));
  return entries.filter((entry) => entry.date >= from && entry.date <= referenceDate);
};

export const buildEvidenceWindow = (from: string, to: string): EvidenceWindow => ({
  from,
  to,
  days: daysBetweenDates(from, to) + 1,
});

export const trailingEvidenceWindow = (
  referenceDate: string,
  windowDays: number,
): EvidenceWindow => {
  const from = addDays(referenceDate, -(windowDays - 1));
  return buildEvidenceWindow(from, referenceDate);
};

/** Latest date carried by `entries`, or `null` when there is no history. */
export const latestEntryDate = (entries: DailyEntry[]): string | null => {
  if (entries.length === 0) {
    return null;
  }

  return sortEntriesByDate(entries)[entries.length - 1].date;
};
