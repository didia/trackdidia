import {
  addDays,
  addMonths,
  atLocalNoon,
  getWeekStartSunday,
  toLocalDateString,
  toMonthKey,
} from "../lib/date";
import { average } from "../lib/math";
import { computeDisciplineScore, resolveMetricValue } from "./daily-entry";
import type {
  DailyEntry,
  MonthlyReview,
  MonthlyReviewChecklist,
  MonthlyReviewNotes,
  MonthlyReviewSectionKey,
  MonthlyReviewStatus,
  MonthlyReviewSummary,
  WeeklyReview,
  WeeklyReviewSummary,
} from "./types";

const clampMonthKey = (monthKey: string): string =>
  /^\d{4}-\d{2}$/.test(monthKey) ? monthKey : monthKey.slice(0, 7);

const createDateFromMonthKey = (monthKey: string, day: number): string =>
  `${clampMonthKey(monthKey)}-${String(day).padStart(2, "0")}`;

export const getMonthKey = (date: string): string => toMonthKey(date);

export const getMonthStartDate = (monthKey: string): string => createDateFromMonthKey(monthKey, 1);

export const getMonthEndDate = (monthKey: string): string => {
  const start = atLocalNoon(getMonthStartDate(monthKey));
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1, 0);
  return toLocalDateString(end);
};

export const listMonthDates = (monthKey: string): string[] => {
  const start = getMonthStartDate(monthKey);
  const end = getMonthEndDate(monthKey);
  const dates: string[] = [];
  let current = start;

  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
};

export const listWeekStartsForMonth = (monthKey: string): string[] => {
  const monthStart = getMonthStartDate(monthKey);
  const monthEnd = getMonthEndDate(monthKey);
  const starts: string[] = [];
  let current = getWeekStartSunday(monthStart);

  while (current <= monthEnd) {
    starts.push(current);
    current = addDays(current, 7);
  }

  return starts;
};

export const getPreviousMonthKey = (date: string): string => addMonths(toMonthKey(date), -1);

export const isFirstSaturdayOfMonth = (date: string): boolean => {
  const current = atLocalNoon(date);
  return current.getDay() === 6 && current.getDate() <= 7;
};

/** First Saturday opens last month so the ritual closes the month that just ended. */
export const getDefaultMonthlyReviewMonthKey = (today: string): string =>
  isFirstSaturdayOfMonth(today) ? getPreviousMonthKey(today) : getMonthKey(today);

const emptyMonthlyNotes = (): MonthlyReviewNotes => ({
  bilan: "",
  journaux: "",
  finances: "",
  temps: "",
  progressionObjectifs: "",
  missionObjectifs: "",
  nettoyageListes: "",
  calendrier: "",
  grosProjets: "",
  developpement: "",
});

const emptyMonthlyChecklist = (): MonthlyReviewChecklist => ({
  bilan: false,
  journaux: false,
  finances: false,
  temps: false,
  progressionObjectifs: false,
  missionObjectifs: false,
  nettoyageListes: false,
  calendrier: false,
  grosProjets: false,
  developpement: false,
});

export const createEmptyMonthlyReview = (monthKey: string): MonthlyReview => {
  const normalized = clampMonthKey(monthKey);
  return {
    monthKey: normalized,
    monthStartDate: getMonthStartDate(normalized),
    monthEndDate: getMonthEndDate(normalized),
    status: "draft",
    notes: emptyMonthlyNotes(),
    ritualChecklist: emptyMonthlyChecklist(),
    updatedAt: new Date().toISOString(),
  };
};

export const cloneMonthlyReview = (review: MonthlyReview): MonthlyReview => ({
  ...review,
  notes: { ...review.notes },
  ritualChecklist: { ...review.ritualChecklist },
});

export const updateMonthlyReviewNote = (
  review: MonthlyReview,
  key: MonthlyReviewSectionKey,
  value: string,
): MonthlyReview => ({
  ...cloneMonthlyReview(review),
  notes: {
    ...review.notes,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

export const updateMonthlyReviewChecklist = (
  review: MonthlyReview,
  key: MonthlyReviewSectionKey,
  value: boolean,
): MonthlyReview => ({
  ...cloneMonthlyReview(review),
  ritualChecklist: {
    ...review.ritualChecklist,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

export const applyMonthlyReviewTransition = (
  review: MonthlyReview,
  status: MonthlyReviewStatus,
): MonthlyReview => ({
  ...cloneMonthlyReview(review),
  status,
  updatedAt: new Date().toISOString(),
});

export const buildMonthlyReviewSummary = (
  monthKey: string,
  entries: DailyEntry[],
  weeklyReviews: WeeklyReview[],
  weeklySummaries: WeeklyReviewSummary[],
): MonthlyReviewSummary => {
  const normalized = clampMonthKey(monthKey);
  const daysTracked = entries.length;
  const sleepValues = entries
    .map((entry) => resolveMetricValue(entry, "qualiteSommeil"))
    .filter((value): value is number => value !== null);
  const trcCount = entries.filter((entry) => entry.principleChecks.respectTrc === true).length;
  const screenTimeTotalMinutes = entries.reduce(
    (sum, entry) => sum + (resolveMetricValue(entry, "tempsEcranTelephone") ?? 0),
    0,
  );
  const pomodorisTotal = entries.reduce(
    (sum, entry) => sum + (resolveMetricValue(entry, "pomodoris") ?? 0),
    0,
  );
  const disciplineAverage = average(entries.map((entry) => computeDisciplineScore(entry)));
  const tasksAddedTotal = entries.reduce(
    (sum, entry) => sum + (resolveMetricValue(entry, "tachesAjoutes") ?? 0),
    0,
  );
  const tasksCompletedTotal = entries.reduce(
    (sum, entry) => sum + (resolveMetricValue(entry, "tachesRealises") ?? 0),
    0,
  );
  const tasksCompletionRate =
    tasksAddedTotal > 0 ? (tasksCompletedTotal / tasksAddedTotal) * 100 : 0;
  const weeklyScoreAverage = average(weeklySummaries.map((summary) => summary.weeklyScore));
  const weeklyReviewMap = new Map(weeklyReviews.map((review) => [review.weekStartDate, review]));
  const weeks = weeklySummaries.map((summary) => {
    const review = weeklyReviewMap.get(summary.weekStartDate);
    const noteCount = review
      ? Object.values(review.notes).filter((value) => value.trim().length > 0).length
      : 0;
    return {
      weekStartDate: summary.weekStartDate,
      weekEndDate: summary.weekEndDate,
      weeklyScore: summary.weeklyScore,
      reviewStatus: (review?.status ?? "missing") as "missing" | WeeklyReview["status"],
      noteCount,
    };
  });

  return {
    monthKey: normalized,
    monthStartDate: getMonthStartDate(normalized),
    monthEndDate: getMonthEndDate(normalized),
    daysTracked,
    weeksCovered: weeklySummaries.length,
    weeklyReviewsCompleted: weeklyReviews.filter((review) => review.status === "closed").length,
    sleepAverage: average(sleepValues),
    trcRate: daysTracked > 0 ? (trcCount / daysTracked) * 100 : 0,
    screenTimeTotalMinutes,
    pomodorisTotal,
    disciplineAverage,
    tasksCompletionRate,
    weeklyScoreAverage,
    weeks,
  };
};
