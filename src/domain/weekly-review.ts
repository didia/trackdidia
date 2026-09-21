import { addDays, getWeekStartSunday, isSunday } from "../lib/gtd/shared";
import { computeDisciplineScore, resolveMetricValue } from "./daily-entry";
import type {
  DailyEntry,
  WeeklyReview,
  WeeklyReviewDaySummary,
  WeeklyReviewNotes,
  WeeklyReviewStatus,
  WeeklyReviewSummary,
  WeeklyRitualChecklist,
  WeeklyRitualSectionKey,
} from "./types";

export const phoneScreenTargetMinutes = 840;
export const pomodoroTarget = 56;
export const calorieTargetDaily = 3800;

const emptyWeeklyNotes = (): WeeklyReviewNotes => ({
  bilan: "",
  budget: "",
  tempsEtPlan: "",
  collecte: "",
  calendrier: "",
  gtd: "",
  alignement: "",
  dimanche: "",
});

const emptyWeeklyChecklist = (): WeeklyRitualChecklist => ({
  bilan: false,
  budget: false,
  tempsEtPlan: false,
  collecte: false,
  calendrier: false,
  gtd: false,
  alignement: false,
  dimanche: false,
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

const toPhysicalActivityAxisValue = (calorieAverage: number): number =>
  calorieTargetDaily > 0 ? clampAtZero((calorieAverage * 100) / calorieTargetDaily) : 0;

export const buildWeekDates = (weekStartDate: string): string => {
  const normalized = getWeekStartSunday(weekStartDate);
  return normalized;
};

/** Sunday opens last week so the ritual closes the week that just ended. */
export const getDefaultWeeklyReviewWeekStart = (today: string): string => {
  const weekStart = getWeekStartSunday(today);
  return isSunday(today) ? addDays(weekStart, -7) : weekStart;
};

export const listWeekDates = (weekStartDate: string): string[] => {
  const normalized = buildWeekDates(weekStartDate);
  return Array.from({ length: 7 }, (_, index) => addDays(normalized, index));
};

/**
 * Dimanche notes describe the week that is starting, not the one being closed.
 * `dimancheNotesWeekStart` is only the ritual write target: reviewing a past
 * week writes the following Sunday. The opened week's stored kickoff is always
 * that week itself, even when both weeks are already past — do not use this
 * helper to decide which notes to display.
 */
const localTodayDate = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

export const dimancheNotesWeekStart = (
  displayedWeekStart: string,
  today = localTodayDate(),
): string => {
  const displayed = buildWeekDates(displayedWeekStart);
  const currentWeek = getWeekStartSunday(today);
  if (displayed < currentWeek) {
    return addDays(displayed, 7);
  }
  return displayed;
};

export const createEmptyWeeklyReview = (weekStartDate: string): WeeklyReview => {
  const normalized = buildWeekDates(weekStartDate);

  return {
    weekStartDate: normalized,
    weekEndDate: addDays(normalized, 6),
    status: "draft",
    notes: emptyWeeklyNotes(),
    ritualChecklist: emptyWeeklyChecklist(),
    updatedAt: new Date().toISOString(),
  };
};

export const cloneWeeklyReview = (review: WeeklyReview): WeeklyReview => ({
  ...review,
  notes: { ...review.notes },
  ritualChecklist: { ...review.ritualChecklist },
});

export const updateWeeklyReviewNote = (
  review: WeeklyReview,
  key: WeeklyRitualSectionKey,
  value: string,
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  notes: {
    ...review.notes,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

const hasDimancheNote = (review: WeeklyReview): boolean => review.notes.dimanche.trim().length > 0;

/**
 * One-shot move decided from an immutable snapshot. Isolated Dimanche notes
 * move from week W onto W+7 when that week is empty. A consecutive run of
 * weeks that already have notes is frozen: if W has text and W+7 has text,
 * both stay. The later note is not shifted to W+14.
 */
export const relocateDimancheNotesToNextWeek = (reviews: WeeklyReview[]): WeeklyReview[] => {
  const byWeek = new Map<string, WeeklyReview>();
  for (const review of reviews) {
    const weekStartDate = buildWeekDates(review.weekStartDate);
    byWeek.set(weekStartDate, cloneWeeklyReview({ ...review, weekStartDate }));
  }

  const occupied = new Set(
    [...byWeek.entries()]
      .filter(([, review]) => hasDimancheNote(review))
      .map(([weekStartDate]) => weekStartDate),
  );
  const moves: Array<{ sourceWeek: string; text: string }> = [];

  for (const weekStartDate of occupied) {
    const previousWeek = addDays(weekStartDate, -7);
    const targetWeek = addDays(weekStartDate, 7);
    if (occupied.has(previousWeek) || occupied.has(targetWeek)) {
      continue;
    }

    const review = byWeek.get(weekStartDate);
    if (!review) {
      continue;
    }
    moves.push({ sourceWeek: weekStartDate, text: review.notes.dimanche });
  }

  const changed = new Map<string, WeeklyReview>();
  for (const move of moves) {
    const source = byWeek.get(move.sourceWeek);
    if (!source) {
      continue;
    }
    const targetWeek = addDays(move.sourceWeek, 7);
    const target = byWeek.get(targetWeek) ?? createEmptyWeeklyReview(targetWeek);
    changed.set(move.sourceWeek, updateWeeklyReviewNote(source, "dimanche", ""));
    changed.set(targetWeek, updateWeeklyReviewNote(target, "dimanche", move.text));
  }

  return [...changed.values()];
};

export const updateWeeklyReviewChecklist = (
  review: WeeklyReview,
  key: WeeklyRitualSectionKey,
  value: boolean,
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  ritualChecklist: {
    ...review.ritualChecklist,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

export const applyWeeklyReviewTransition = (
  review: WeeklyReview,
  status: WeeklyReviewStatus,
): WeeklyReview => ({
  ...cloneWeeklyReview(review),
  status,
  updatedAt: new Date().toISOString(),
});

const buildDaySummary = (entry: DailyEntry): WeeklyReviewDaySummary => ({
  date: entry.date,
  status: entry.status,
  sleepQuality: resolveMetricValue(entry, "qualiteSommeil"),
  trcRespected: entry.principleChecks.respectTrc === true,
  screenTimeMinutes: resolveMetricValue(entry, "tempsEcranTelephone") ?? 0,
  pomodoris: resolveMetricValue(entry, "pomodoris") ?? 0,
  calorieExpenditure: resolveMetricValue(entry, "depenseCalorique") ?? 0,
  disciplineScore: computeDisciplineScore(entry),
  tasksAdded: resolveMetricValue(entry, "tachesAjoutes") ?? 0,
  tasksCompleted: resolveMetricValue(entry, "tachesRealises") ?? 0,
});

export const localWeeklyScoreAxes = (summary: WeeklyReviewSummary): number[] => [
  scoreAgainstTarget(summary.sleepQuality, 100),
  scoreAgainstTarget(summary.respectTrc, 100),
  scoreAgainstTarget(summary.phoneScreenTime, 100),
  scoreAgainstTarget(summary.pomodoris, 100),
  scoreAgainstTarget(summary.discipline, 100),
  scoreAgainstTarget(summary.tasksCompletionRate, 100),
  scoreAgainstTarget(summary.physicalActivity, 100),
];

export const applyWeeklyScoreExternalAxes = (
  summary: WeeklyReviewSummary,
  external: {
    rescueTimeGoalsScore: number | null;
    productivityPulse: number | null;
  },
): WeeklyReviewSummary => {
  const axisScores = [...localWeeklyScoreAxes(summary)];

  if (external.rescueTimeGoalsScore !== null) {
    axisScores.push(scoreAgainstTarget(external.rescueTimeGoalsScore * 100, 100));
  }

  if (external.productivityPulse !== null) {
    axisScores.push(scoreAgainstTarget(external.productivityPulse, 100));
  }

  return {
    ...summary,
    rescueTimeGoalsScore: external.rescueTimeGoalsScore,
    productivityPulse: external.productivityPulse,
    weeklyScore: average(axisScores),
  };
};

export const buildWeeklyReviewSummary = (
  weekStartDate: string,
  entries: DailyEntry[],
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
  const calorieAverage = average(daySummaries.map((day) => day.calorieExpenditure));
  const disciplineAverage = average(daySummaries.map((day) => day.disciplineScore));
  const tasksAddedTotal = daySummaries.reduce((sum, day) => sum + day.tasksAdded, 0);
  const tasksCompletedTotal = daySummaries.reduce((sum, day) => sum + day.tasksCompleted, 0);
  const sleepQuality = sleepAverage;
  const respectTrc = (trcDaysRespected / 7) * 100;
  const phoneScreenTime = toPhoneScreenAxisValue(screenTimeTotalMinutes);
  const pomodoris = toPomodoroAxisValue(pomodorisTotal);
  const physicalActivity = toPhysicalActivityAxisValue(calorieAverage);
  const discipline = disciplineAverage * 100;
  const tasksCompletionRate =
    tasksAddedTotal > 0 ? (tasksCompletedTotal / tasksAddedTotal) * 100 : 0;

  const baseSummary: WeeklyReviewSummary = {
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
    calorieAverage,
    physicalActivity,
    productivityPulse: null,
    rescueTimeGoalsScore: null,
    weeklyScore: 0,
    days: daySummaries,
  };

  return {
    ...baseSummary,
    weeklyScore: average(localWeeklyScoreAxes(baseSummary)),
  };
};
