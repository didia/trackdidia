import { addDays, getWeekStartSunday } from "../lib/gtd/shared";
import { computeDisciplineScore, resolveMetricValue } from "./daily-entry";
import type {
  DailyEntry,
  WeeklyReview,
  WeeklyReviewDaySummary,
  WeeklyReviewNotes,
  WeeklyReviewStatus,
  WeeklyReviewSummary,
  WeeklyRitualChecklist,
  WeeklyRitualSectionKey
} from "./types";

const phoneScreenTargetMinutes = 840;
const pomodoroTarget = 56;

const emptyWeeklyNotes = (): WeeklyReviewNotes => ({
  bilan: "",
  budget: "",
  tempsEtPlan: "",
  collecte: "",
  calendrier: "",
  gtd: "",
  alignement: "",
  dimanche: ""
});

const emptyWeeklyChecklist = (): WeeklyRitualChecklist => ({
  bilan: false,
  budget: false,
  tempsEtPlan: false,
  collecte: false,
  calendrier: false,
  gtd: false,
  alignement: false,
  dimanche: false
});

const clampAtZero = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const scoreAgainstTarget = (value: number, target: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) {
    return 0;
  }

  const safeValue = Math.max(0, value);
  if (safeValue <= target) {
    return safeValue / target;
  }

  return 1 + (safeValue - target) / (2 * target);
};

const toPhoneScreenAxisValue = (totalMinutes: number): number =>
  clampAtZero(100 + ((phoneScreenTargetMinutes - totalMinutes) / phoneScreenTargetMinutes) * 100);

const toPomodoroAxisValue = (pomodorisTotal: number): number =>
  pomodoroTarget > 0 ? clampAtZero((pomodorisTotal * 100) / pomodoroTarget) : 0;

export const buildWeekDates = (weekStartDate: string): string => {
  const normalized = getWeekStartSunday(weekStartDate);
  return normalized;
};

export const listWeekDates = (weekStartDate: string): string[] => {
  const normalized = buildWeekDates(weekStartDate);
  return Array.from({ length: 7 }, (_, index) => addDays(normalized, index));
};

export const createEmptyWeeklyReview = (weekStartDate: string): WeeklyReview => {
  const normalized = buildWeekDates(weekStartDate);

  return {
    weekStartDate: normalized,
    weekEndDate: addDays(normalized, 6),
    status: "draft",
    notes: emptyWeeklyNotes(),
    ritualChecklist: emptyWeeklyChecklist(),
    updatedAt: new Date().toISOString()
  };
};

export const cloneWeeklyReview = (review: WeeklyReview): WeeklyReview => ({
  ...review,
  notes: { ...review.notes },
  ritualChecklist: { ...review.ritualChecklist }
});

export const updateWeeklyReviewNote = (
  review: WeeklyReview,
  key: WeeklyRitualSectionKey,
  value: string
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  notes: {
    ...review.notes,
    [key]: value
  },
  updatedAt: new Date().toISOString()
});

export const updateWeeklyReviewChecklist = (
  review: WeeklyReview,
  key: WeeklyRitualSectionKey,
  value: boolean
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  ritualChecklist: {
    ...review.ritualChecklist,
    [key]: value
  },
  updatedAt: new Date().toISOString()
});

export const applyWeeklyReviewTransition = (
  review: WeeklyReview,
  status: WeeklyReviewStatus
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  status,
  updatedAt: new Date().toISOString()
});

const buildDaySummary = (entry: DailyEntry): WeeklyReviewDaySummary => ({
  date: entry.date,
  status: entry.status,
  sleepQuality: resolveMetricValue(entry, "qualiteSommeil"),
  trcRespected: entry.principleChecks.respectTrc === true,
  screenTimeMinutes: resolveMetricValue(entry, "tempsEcranTelephone") ?? 0,
  pomodoris: resolveMetricValue(entry, "pomodoris") ?? 0,
  disciplineScore: computeDisciplineScore(entry),
  tasksAdded: resolveMetricValue(entry, "tachesAjoutes") ?? 0,
  tasksCompleted: resolveMetricValue(entry, "tachesRealises") ?? 0
});

export const buildWeeklyReviewSummary = (
  weekStartDate: string,
  entries: DailyEntry[]
): WeeklyReviewSummary => {
  const normalized = buildWeekDates(weekStartDate);
  const orderedEntries = [...entries].sort((left, right) => left.date.localeCompare(right.date));
  const daySummaries = orderedEntries.map(buildDaySummary);
  const sleepValues = daySummaries
    .map((day) => day.sleepQuality)
    .filter((value): value is number => value !== null);
  const sleepAverage = average(sleepValues);
  const trcDaysRespected = daySummaries.filter((day) => day.trcRespected).length;
  const screenTimeTotalMinutes = daySummaries.reduce((sum, day) => sum + day.screenTimeMinutes, 0);
  const pomodorisTotal = daySummaries.reduce((sum, day) => sum + day.pomodoris, 0);
  const disciplineAverage = average(daySummaries.map((day) => day.disciplineScore));
  const tasksAddedTotal = daySummaries.reduce((sum, day) => sum + day.tasksAdded, 0);
  const tasksCompletedTotal = daySummaries.reduce((sum, day) => sum + day.tasksCompleted, 0);
  const sleepQuality = sleepAverage;
  const respectTrc = (trcDaysRespected / 7) * 100;
  const phoneScreenTime = toPhoneScreenAxisValue(screenTimeTotalMinutes);
  const pomodoris = toPomodoroAxisValue(pomodorisTotal);
  const discipline = disciplineAverage * 100;
  const tasksCompletionRate =
    tasksAddedTotal > 0 ? (tasksCompletedTotal / tasksAddedTotal) * 100 : 0;
  const weeklyScore = average([
    scoreAgainstTarget(sleepQuality, 100),
    scoreAgainstTarget(respectTrc, 100),
    scoreAgainstTarget(phoneScreenTime, 100),
    scoreAgainstTarget(pomodoris, 100),
    scoreAgainstTarget(discipline, 100),
    scoreAgainstTarget(tasksCompletionRate, 100)
  ]);

  return {
    weekStartDate: normalized,
    weekEndDate: addDays(normalized, 6),
    sleepAverage,
    sleepQuality,
    trcDaysRespected,
    respectTrc,
    screenTimeTotalMinutes,
    phoneScreenTime,
    pomodorisTotal,
    pomodoris,
    disciplineAverage,
    discipline,
    tasksAddedTotal,
    tasksCompletedTotal,
    tasksCompletionRate,
    weeklyScore,
    days: daySummaries
  };
};
