import { toLocalDateString, toMonthKey } from "../../date";

/** Local calendar month boundaries for usage aggregation. */
export const monthKeyToLocalRange = (monthKey: string): { startIso: string; endIso: string } => {
  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
};

export const getCurrentMonthKey = (): string => {
  return toMonthKey(new Date());
};

export const toLocalDateKey = (isoTimestamp: string): string => toLocalDateString(isoTimestamp);
