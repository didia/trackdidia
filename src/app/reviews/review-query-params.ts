import { buildWeekDates, getDefaultWeeklyReviewWeekStart } from "../../domain/weekly-review";
import { getDefaultMonthlyReviewMonthKey, getMonthKey } from "../../domain/monthly-review";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

export const isIsoDateString = (value: string | null | undefined): value is string =>
  typeof value === "string" && ISO_DATE_PATTERN.test(value);

export const isMonthKey = (value: string | null | undefined): value is string =>
  typeof value === "string" && MONTH_KEY_PATTERN.test(value);

/**
 * Week the weekly review opens on: the Sunday of a well-formed `?date=` deep link,
 * otherwise the default ritual week for `today`.
 */
export const resolveInitialWeeklyReviewWeek = (dateParam: string | null, today: string): string =>
  buildWeekDates(isIsoDateString(dateParam) ? dateParam : getDefaultWeeklyReviewWeekStart(today));

/** Month the monthly review opens on: a well-formed `?month=` deep link, otherwise the default. */
export const resolveInitialMonthlyReviewMonth = (
  monthParam: string | null,
  today: string,
): string =>
  isMonthKey(monthParam) ? getMonthKey(`${monthParam}-01`) : getDefaultMonthlyReviewMonthKey(today);
