import { addDays } from "../lib/gtd/shared";
import {
  ANNUAL_GOAL_PACE_TOLERANCE,
  computeYearProgressFraction,
  isAnnualGoalOnPace,
} from "./annual-goals";
import { getMonthEndDate, getMonthKey, getMonthStartDate } from "./monthly-review";
import type {
  AnnualGoal,
  AnnualGoalDirection,
  AnnualGoalMeasurement,
  AnnualGoalProgressPoint,
  DailyEntry,
} from "./types";
import { buildWeekDates } from "./weekly-review";

export interface AnnualGoalSourceValues {
  currentValue: number | null;
  /** One point per calendar month of the target year, independently computed by the source. */
  monthlyValues: AnnualGoalProgressPoint[];
}

export interface AnnualGoalMeasurementResult {
  currentValue: number | null;
  progressRatio: number | null;
  monthlyProgress: AnnualGoalProgressPoint[];
  measurement: AnnualGoalMeasurement;
}

/** The 12 `YYYY-MM` month keys of a calendar year, in order. */
export const buildMonthKeysForYear = (year: number): string[] =>
  Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);

/** Sunday week-start dates (`YYYY-MM-DD`) for every week overlapping the calendar year. */
export const buildWeekPeriodKeysForYear = (year: number): string[] => {
  const firstWeekStart = buildWeekDates(`${year}-01-01`);
  const lastWeekStart = buildWeekDates(`${year}-12-31`);
  const keys: string[] = [];
  let cursor = firstWeekStart;
  while (cursor <= lastWeekStart) {
    keys.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return keys;
};

export const computeMilestoneProgressRatio = (
  goal: Pick<AnnualGoal, "milestones">,
): number | null => {
  if (goal.milestones.length === 0) {
    return null;
  }

  const completed = goal.milestones.filter((milestone) => milestone.completedAt !== null).length;
  return completed / goal.milestones.length;
};

const computeFractionElapsedBetween = (
  startDate: string,
  endDate: string,
  asOfDate: string,
): number => {
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  const asOf = new Date(`${asOfDate}T12:00:00`);

  if (asOf <= start) {
    return 0;
  }

  if (asOf >= end) {
    return 1;
  }

  const totalMs = end.getTime() - start.getTime();
  if (totalMs <= 0) {
    return 1;
  }

  return (asOf.getTime() - start.getTime()) / totalMs;
};

const computeDeadlineOrYearFraction = (
  goal: Pick<AnnualGoal, "deadline">,
  year: number,
  asOfDate: string,
): number => {
  if (goal.deadline) {
    return computeFractionElapsedBetween(`${year}-01-01`, goal.deadline, asOfDate);
  }

  return computeYearProgressFraction(year, asOfDate);
};

/**
 * Per-type pacing expectation (0-1), or `null` when no honest expectation can be stated:
 * - numeric / cumulative: fraction of the year (or, with a deadline, of Jan 1 → deadline) elapsed.
 * - recurring: always `1` — adherence is expected to be 100% from week one, never graded against
 *   the calendar.
 * - binary: the deadline/year fraction when the goal has milestones to compare against; otherwise
 *   `null`, since there is nothing to interpolate between "not done" and "done".
 */
export const computeAnnualGoalExpectedRatio = (
  goal: AnnualGoal,
  year: number,
  asOfDate: string,
): number | null => {
  if (goal.measurementType === "recurring") {
    return 1;
  }

  if (goal.measurementType === "binary") {
    return computeMilestoneProgressRatio(goal) !== null
      ? computeDeadlineOrYearFraction(goal, year, asOfDate)
      : null;
  }

  return computeDeadlineOrYearFraction(goal, year, asOfDate);
};

const resolveNumericDirection = (
  goal: Pick<AnnualGoal, "direction" | "startingValue" | "targetValue">,
): AnnualGoalDirection => {
  if (goal.direction) {
    return goal.direction;
  }

  if (
    goal.startingValue !== null &&
    goal.targetValue !== null &&
    goal.targetValue < goal.startingValue
  ) {
    return "decrease";
  }

  return "increase";
};

const computeNumericRatio = (
  goal: Pick<AnnualGoal, "direction" | "startingValue" | "targetValue">,
  currentValue: number | null,
): number | null => {
  const { targetValue, startingValue } = goal;
  if (currentValue === null || targetValue === null) {
    return null;
  }

  if (startingValue !== null && startingValue !== targetValue) {
    const ratio = (currentValue - startingValue) / (targetValue - startingValue);
    return Math.max(0, ratio);
  }

  // No usable baseline (none set, or start === target): fall back to a direct ratio against the
  // target, exactly reproducing legacy `current / target` math when direction is "increase".
  const direction = resolveNumericDirection(goal);
  if (direction === "decrease") {
    if (targetValue === 0) {
      // "Reduce X to 0" with no baseline: `target / current` is undefined at target 0. Treat
      // reaching (or passing) 0 as fully achieved; otherwise there is no honest ratio to report.
      return currentValue <= 0 ? 1 : null;
    }
    return currentValue > 0 ? targetValue / currentValue : null;
  }

  return targetValue > 0 ? currentValue / targetValue : null;
};

const buildNullMonthlyProgress = (year: number): AnnualGoalProgressPoint[] =>
  buildMonthKeysForYear(year).map((monthKey) => ({ monthKey, value: null }));

const computeCumulative = (
  goal: AnnualGoal,
  year: number,
  sourceValues: AnnualGoalSourceValues,
): { currentValue: number | null; monthlyProgress: AnnualGoalProgressPoint[] } => {
  if (goal.sourceId !== null) {
    let running = 0;
    let seenValue = false;
    const monthlyProgress = sourceValues.monthlyValues.map((point) => {
      if (point.value !== null) {
        running += point.value;
        seenValue = true;
      }
      return { monthKey: point.monthKey, value: seenValue ? running : null };
    });

    return { currentValue: sourceValues.currentValue, monthlyProgress };
  }

  const monthKeys = buildMonthKeysForYear(year);
  let running = 0;
  const monthlyProgress = monthKeys.map((monthKey) => {
    const increment = goal.progressLog[monthKey];
    if (increment !== undefined) {
      running += increment;
    }
    return { monthKey, value: running };
  });

  return { currentValue: running, monthlyProgress };
};

interface RecurringPeriodInfo {
  key: string;
  count: number | null;
  logged: boolean;
  met: boolean;
  endDate: string;
}

const periodStartAndEndDate = (
  periodKey: string,
  cadencePeriod: AnnualGoal["cadencePeriod"],
): { start: string; end: string } =>
  cadencePeriod === "month"
    ? { start: getMonthStartDate(periodKey), end: getMonthEndDate(periodKey) }
    : { start: periodKey, end: addDays(periodKey, 6) };

const countTruePrincipleDaysInPeriod = (
  entries: DailyEntry[],
  principleKey: NonNullable<AnnualGoal["principleKey"]>,
  start: string,
  end: string,
): number =>
  entries.filter(
    (entry) =>
      entry.date >= start && entry.date <= end && entry.principleChecks[principleKey] === true,
  ).length;

const buildRecurringPeriodInfos = (
  goal: AnnualGoal,
  year: number,
  entries: DailyEntry[],
): RecurringPeriodInfo[] => {
  const periodKeys =
    goal.cadencePeriod === "month" ? buildMonthKeysForYear(year) : buildWeekPeriodKeysForYear(year);
  const cadenceTarget = goal.cadenceTarget;

  return periodKeys.map((key) => {
    const { start, end } = periodStartAndEndDate(key, goal.cadencePeriod);
    let count: number | null = null;
    let logged = false;

    if (goal.progressLog[key] !== undefined) {
      count = goal.progressLog[key];
      logged = true;
    } else if (goal.principleKey) {
      count = countTruePrincipleDaysInPeriod(entries, goal.principleKey, start, end);
      logged = true;
    }

    const met =
      logged && count !== null && cadenceTarget !== null && cadenceTarget > 0
        ? count >= cadenceTarget
        : false;

    return { key, count, logged, met, endDate: end };
  });
};

const computeRecurringStreak = (elapsedPeriods: RecurringPeriodInfo[]): number => {
  let streak = 0;
  let started = false;

  for (let index = elapsedPeriods.length - 1; index >= 0; index -= 1) {
    const period = elapsedPeriods[index];
    if (!started) {
      if (period.met) {
        started = true;
        streak = 1;
      } else if (!period.logged) {
        // Trailing "not logged yet" period — mirrors StreakFinding.currentStreak: absence of
        // data at the reference end is not treated as a miss.
      } else {
        break;
      }
    } else if (period.met) {
      streak += 1;
    } else {
      break;
    }
  }

  return streak;
};

const computeRecurring = (
  goal: AnnualGoal,
  year: number,
  asOfDate: string,
  entries: DailyEntry[],
): {
  currentValue: number | null;
  monthlyProgress: AnnualGoalProgressPoint[];
  progressRatio: number | null;
  currentPeriodKey: string | null;
  currentPeriodCount: number | null;
  adherenceRatio: number | null;
  periodsMet: number;
  periodsElapsed: number;
  currentStreak: number;
} => {
  const periods = buildRecurringPeriodInfos(goal, year, entries);
  const candidateCurrentKey =
    goal.cadencePeriod === "month" ? getMonthKey(asOfDate) : buildWeekDates(asOfDate);
  const currentIndex = periods.findIndex((period) => period.key === candidateCurrentKey);

  const elapsedPeriods =
    currentIndex >= 0
      ? periods.slice(0, currentIndex)
      : periods.filter((period) => period.endDate <= asOfDate);
  const currentPeriod = currentIndex >= 0 ? periods[currentIndex] : null;

  const periodsMet = elapsedPeriods.filter((period) => period.met).length;
  const periodsElapsed = elapsedPeriods.length;
  const adherenceRatio = periodsElapsed > 0 ? periodsMet / periodsElapsed : null;
  const currentStreak = computeRecurringStreak(elapsedPeriods);

  const monthlyProgress =
    goal.cadencePeriod === "month"
      ? periods.map((period) => ({ monthKey: period.key, value: period.count }))
      : buildNullMonthlyProgress(year);

  return {
    currentValue: currentPeriod?.count ?? null,
    monthlyProgress,
    progressRatio: adherenceRatio,
    currentPeriodKey: currentPeriod?.key ?? null,
    currentPeriodCount: currentPeriod?.count ?? null,
    adherenceRatio,
    periodsMet,
    periodsElapsed,
    currentStreak,
  };
};

export const computeAnnualGoalMeasurement = (
  goal: AnnualGoal,
  year: number,
  asOfDate: string,
  sourceValues: AnnualGoalSourceValues,
  yearEntries: DailyEntry[],
): AnnualGoalMeasurementResult => {
  const milestonesTotal = goal.milestones.length;
  const milestonesCompleted = goal.milestones.filter(
    (milestone) => milestone.completedAt !== null,
  ).length;
  const milestoneProgressRatio = computeMilestoneProgressRatio(goal);
  const expectedProgressRatio = computeAnnualGoalExpectedRatio(goal, year, asOfDate);

  if (goal.measurementType === "binary") {
    const achieved = goal.status === "achieved";
    const currentValue = achieved ? 1 : 0;
    const onPace = achieved
      ? true
      : expectedProgressRatio !== null
        ? isAnnualGoalOnPace(milestoneProgressRatio, expectedProgressRatio)
        : goal.deadline === null || asOfDate <= goal.deadline;

    return {
      currentValue,
      progressRatio: currentValue,
      monthlyProgress: buildNullMonthlyProgress(year),
      measurement: {
        measurementType: "binary",
        direction: "increase",
        currentPeriodKey: null,
        currentPeriodCount: null,
        cadenceTarget: null,
        adherenceRatio: null,
        periodsMet: 0,
        periodsElapsed: 0,
        currentStreak: 0,
        milestonesCompleted,
        milestonesTotal,
        milestoneProgressRatio,
        expectedProgressRatio,
        onPace,
      },
    };
  }

  if (goal.measurementType === "cumulative") {
    const { currentValue, monthlyProgress } = computeCumulative(goal, year, sourceValues);
    const progressRatio =
      goal.targetValue && goal.targetValue > 0 && currentValue !== null
        ? currentValue / goal.targetValue
        : null;
    const onPace = isAnnualGoalOnPace(
      progressRatio,
      expectedProgressRatio ?? computeYearProgressFraction(year, asOfDate),
      ANNUAL_GOAL_PACE_TOLERANCE,
    );

    return {
      currentValue,
      progressRatio,
      monthlyProgress,
      measurement: {
        measurementType: "cumulative",
        direction: "increase",
        currentPeriodKey: null,
        currentPeriodCount: null,
        cadenceTarget: null,
        adherenceRatio: null,
        periodsMet: 0,
        periodsElapsed: 0,
        currentStreak: 0,
        milestonesCompleted,
        milestonesTotal,
        milestoneProgressRatio,
        expectedProgressRatio,
        onPace,
      },
    };
  }

  if (goal.measurementType === "recurring") {
    const recurring = computeRecurring(goal, year, asOfDate, yearEntries);
    // No period has elapsed yet (e.g. the very first week of the year), so there is nothing to
    // have missed. Treat this as on pace rather than routing a null adherenceRatio through
    // isAnnualGoalOnPace, which would otherwise unconditionally report off pace.
    const onPace =
      recurring.periodsElapsed === 0
        ? true
        : isAnnualGoalOnPace(
            recurring.adherenceRatio,
            expectedProgressRatio ?? 1,
            ANNUAL_GOAL_PACE_TOLERANCE,
          );

    return {
      currentValue: recurring.currentValue,
      progressRatio: recurring.progressRatio,
      monthlyProgress: recurring.monthlyProgress,
      measurement: {
        measurementType: "recurring",
        direction: "increase",
        currentPeriodKey: recurring.currentPeriodKey,
        currentPeriodCount: recurring.currentPeriodCount,
        cadenceTarget: goal.cadenceTarget,
        adherenceRatio: recurring.adherenceRatio,
        periodsMet: recurring.periodsMet,
        periodsElapsed: recurring.periodsElapsed,
        currentStreak: recurring.currentStreak,
        milestonesCompleted,
        milestonesTotal,
        milestoneProgressRatio,
        expectedProgressRatio,
        onPace,
      },
    };
  }

  // numeric
  const currentValue = sourceValues.currentValue ?? goal.manualCurrentValue ?? null;
  const progressRatio = computeNumericRatio(goal, currentValue);
  const direction = resolveNumericDirection(goal);
  const onPace = isAnnualGoalOnPace(
    progressRatio,
    expectedProgressRatio ?? computeYearProgressFraction(year, asOfDate),
    ANNUAL_GOAL_PACE_TOLERANCE,
  );

  return {
    currentValue,
    progressRatio,
    monthlyProgress: sourceValues.monthlyValues,
    measurement: {
      measurementType: "numeric",
      direction,
      currentPeriodKey: null,
      currentPeriodCount: null,
      cadenceTarget: null,
      adherenceRatio: null,
      periodsMet: 0,
      periodsElapsed: 0,
      currentStreak: 0,
      milestonesCompleted,
      milestonesTotal,
      milestoneProgressRatio,
      expectedProgressRatio,
      onPace,
    },
  };
};
