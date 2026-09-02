import { t } from "../i18n";
import type {
  AnnualGoal,
  AnnualGoalDimension,
  AnnualGoalEvaluation,
  AnnualGoalSnapshot,
  AnnualGoalSourceId,
  AnnualGoalSourceType,
  AnnualGoalTrend,
  DailyEntry,
  WeeklyReviewSummary
} from "./types";
import { computeDisciplineScore, resolveMetricValue } from "./daily-entry";
import { getMonthKey, getMonthStartDate } from "./monthly-review";

interface AnnualGoalSourceDefinition {
  id: AnnualGoalSourceId;
  label: string;
  type: AnnualGoalSourceType;
  weeklyMetricLabels: string[];
  dailyHabitLabels: string[];
  computeCurrent: (entries: DailyEntry[], weeklySummaries: WeeklyReviewSummary[]) => number | null;
  computeMonth: (monthKey: string, entries: DailyEntry[], weeklySummaries: WeeklyReviewSummary[]) => number | null;
}

const average = (values: number[]): number | null =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const computePrincipleRate = (entries: DailyEntry[], key: keyof DailyEntry["principleChecks"]): number | null => {
  if (entries.length === 0) {
    return null;
  }

  const respected = entries.filter((entry) => entry.principleChecks[key] === true).length;
  return (respected / entries.length) * 100;
};

const filterEntriesByMonth = (monthKey: string, entries: DailyEntry[]): DailyEntry[] =>
  entries.filter((entry) => getMonthKey(entry.date) === monthKey);

const filterWeeklyByMonth = (monthKey: string, weeklySummaries: WeeklyReviewSummary[]): WeeklyReviewSummary[] => {
  const monthStart = getMonthStartDate(monthKey);
  return weeklySummaries.filter((summary) => getMonthKey(summary.weekStartDate) === monthKey || getMonthKey(summary.weekEndDate) === monthKey || (summary.weekStartDate < monthStart && summary.weekEndDate >= monthStart));
};

const weeklyAverage = (weeklySummaries: WeeklyReviewSummary[], selector: (summary: WeeklyReviewSummary) => number): number | null =>
  average(weeklySummaries.map(selector));

const dailyAverageMetric = (entries: DailyEntry[], key: Parameters<typeof resolveMetricValue>[1]): number | null =>
  average(entries.map((entry) => resolveMetricValue(entry, key)).filter((value): value is number => value !== null));

const sourceLabel = (id: AnnualGoalSourceId): string => t(`sources.${id}`, { ns: "goals" });
const linkedMetricLabel = (id: string): string => t(`linkedMetric.${id}`, { ns: "goals" });
const habitLabel = (key: string): string => t(`habit.${key}`, { ns: "goals" });

const sourceDefinitions: AnnualGoalSourceDefinition[] = [
  {
    id: "weekly_sleep_average",
    label: sourceLabel("weekly_sleep_average"),
    type: "weekly_summary",
    weeklyMetricLabels: [linkedMetricLabel("weekly_sleep_average")],
    dailyHabitLabels: [habitLabel("qualiteSommeil")],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.sleepAverage),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.sleepAverage)
  },
  {
    id: "weekly_respect_trc",
    label: sourceLabel("weekly_respect_trc"),
    type: "weekly_summary",
    weeklyMetricLabels: [linkedMetricLabel("weekly_respect_trc")],
    dailyHabitLabels: [habitLabel("respectTrc")],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.respectTrc),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.respectTrc)
  },
  {
    id: "weekly_weekly_score",
    label: sourceLabel("weekly_weekly_score"),
    type: "weekly_summary",
    weeklyMetricLabels: [linkedMetricLabel("weekly_weekly_score")],
    dailyHabitLabels: [
      habitLabel("sommeil"),
      habitLabel("trc"),
      habitLabel("tempsEcran"),
      habitLabel("tempsFocus"),
      habitLabel("discipline"),
      habitLabel("taches"),
      habitLabel("depenseCalorique")
    ],
    computeCurrent: (_entries, weeklySummaries) => {
      const value = weeklyAverage(weeklySummaries, (summary) => summary.weeklyScore);
      return value === null ? null : value * 100;
    },
    computeMonth: (monthKey, _entries, weeklySummaries) => {
      const value = weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.weeklyScore);
      return value === null ? null : value * 100;
    }
  },
  {
    id: "weekly_discipline",
    label: sourceLabel("weekly_discipline"),
    type: "weekly_summary",
    weeklyMetricLabels: [linkedMetricLabel("weekly_discipline")],
    dailyHabitLabels: [habitLabel("principesDeVie")],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.disciplineAverage * 100),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.disciplineAverage * 100)
  },
  {
    id: "weekly_tasks_completion_rate",
    label: sourceLabel("weekly_tasks_completion_rate"),
    type: "weekly_summary",
    weeklyMetricLabels: [linkedMetricLabel("weekly_tasks_completion_rate")],
    dailyHabitLabels: [habitLabel("tachesRealisees"), habitLabel("tachesAjoutees")],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.tasksCompletionRate),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.tasksCompletionRate)
  },
  {
    id: "daily_depense_calorique_avg",
    label: sourceLabel("daily_depense_calorique_avg"),
    type: "daily_metric",
    weeklyMetricLabels: [],
    dailyHabitLabels: [habitLabel("depenseCalorique")],
    computeCurrent: (entries) => dailyAverageMetric(entries, "depenseCalorique"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "depenseCalorique")
  },
  {
    id: "daily_qualite_sommeil_avg",
    label: sourceLabel("daily_qualite_sommeil_avg"),
    type: "daily_metric",
    weeklyMetricLabels: [linkedMetricLabel("daily_qualite_sommeil_avg")],
    dailyHabitLabels: [habitLabel("qualiteSommeil")],
    computeCurrent: (entries) => dailyAverageMetric(entries, "qualiteSommeil"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "qualiteSommeil")
  },
  {
    id: "daily_temps_ecran_avg",
    label: sourceLabel("daily_temps_ecran_avg"),
    type: "daily_metric",
    weeklyMetricLabels: [linkedMetricLabel("daily_temps_ecran_avg")],
    dailyHabitLabels: [habitLabel("tempsEcranTelephone")],
    computeCurrent: (entries) => dailyAverageMetric(entries, "tempsEcranTelephone"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "tempsEcranTelephone")
  },
  {
    id: "daily_pomodoris_sum",
    label: sourceLabel("daily_pomodoris_sum"),
    type: "daily_metric",
    weeklyMetricLabels: [linkedMetricLabel("daily_pomodoris_sum")],
    dailyHabitLabels: [habitLabel("pomodoris")],
    computeCurrent: (entries) => sum(entries.map((entry) => resolveMetricValue(entry, "pomodoris") ?? 0)),
    computeMonth: (monthKey, entries) => sum(filterEntriesByMonth(monthKey, entries).map((entry) => resolveMetricValue(entry, "pomodoris") ?? 0))
  },
  {
    id: "daily_pomodoris_avg",
    label: sourceLabel("daily_pomodoris_avg"),
    type: "daily_metric",
    weeklyMetricLabels: [linkedMetricLabel("daily_pomodoris_avg")],
    dailyHabitLabels: [habitLabel("pomodoris")],
    computeCurrent: (entries) => dailyAverageMetric(entries, "pomodoris"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "pomodoris")
  },
  {
    id: "daily_respect_trc_rate",
    label: sourceLabel("daily_respect_trc_rate"),
    type: "daily_principle",
    weeklyMetricLabels: [linkedMetricLabel("daily_respect_trc_rate")],
    dailyHabitLabels: [habitLabel("respectTrc")],
    computeCurrent: (entries) => computePrincipleRate(entries, "respectTrc"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "respectTrc")
  },
  {
    id: "daily_respect_reveil_rate",
    label: sourceLabel("daily_respect_reveil_rate"),
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: [habitLabel("respectReveil")],
    computeCurrent: (entries) => computePrincipleRate(entries, "respectReveil"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "respectReveil")
  },
  {
    id: "daily_priere_du_matin_rate",
    label: sourceLabel("daily_priere_du_matin_rate"),
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: [habitLabel("priereDuMatin")],
    computeCurrent: (entries) => computePrincipleRate(entries, "priereDuMatin"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "priereDuMatin")
  },
  {
    id: "daily_priere_du_soir_rate",
    label: sourceLabel("daily_priere_du_soir_rate"),
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: [habitLabel("priereDuSoir")],
    computeCurrent: (entries) => computePrincipleRate(entries, "priereDuSoir"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "priereDuSoir")
  },
  {
    id: "daily_objectifs_atteints_rate",
    label: sourceLabel("daily_objectifs_atteints_rate"),
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: [habitLabel("objectifsAtteints")],
    computeCurrent: (entries) => computePrincipleRate(entries, "objectifsAtteints"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "objectifsAtteints")
  }
];

export const annualGoalDimensions: Array<{ value: AnnualGoalDimension; label: string }> = [
  { value: "physique", label: t("dimensions.physique", { ns: "goals" }) },
  { value: "spirituelle", label: t("dimensions.spirituelle", { ns: "goals" }) },
  { value: "sociale", label: t("dimensions.sociale", { ns: "goals" }) },
  { value: "intellectuelle", label: t("dimensions.intellectuelle", { ns: "goals" }) },
  { value: "global", label: t("dimensions.global", { ns: "goals" }) }
];

export const annualGoalTrendOptions: Array<{ value: AnnualGoalTrend; label: string }> = [
  { value: "up", label: t("trends.up", { ns: "goals" }) },
  { value: "steady", label: t("trends.steady", { ns: "goals" }) },
  { value: "down", label: t("trends.down", { ns: "goals" }) }
];

export const annualGoalSourceOptions = sourceDefinitions.map((definition) => ({
  value: definition.id,
  label: definition.label,
  type: definition.type
}));

export const createEmptyAnnualGoal = (overrides: Partial<AnnualGoal> = {}): AnnualGoal => {
  const timestamp = new Date().toISOString();
  return {
    id: overrides.id ?? "",
    title: overrides.title ?? "",
    dimension: overrides.dimension ?? "global",
    description: overrides.description ?? "",
    targetValue: overrides.targetValue ?? null,
    unit: overrides.unit ?? "",
    sourceId: overrides.sourceId ?? null,
    manualCurrentValue: overrides.manualCurrentValue ?? null,
    evaluations: overrides.evaluations ?? {},
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp
  };
};

export const cloneAnnualGoal = (goal: AnnualGoal): AnnualGoal => ({
  ...goal,
  evaluations: Object.fromEntries(
    Object.entries(goal.evaluations).map(([monthKey, evaluation]) => [monthKey, { ...evaluation }])
  )
});

export const updateAnnualGoalEvaluation = (
  goal: AnnualGoal,
  monthKey: string,
  changes: Partial<AnnualGoalEvaluation>
): AnnualGoal => {
  const existing = goal.evaluations[monthKey] ?? {
    monthKey,
    score: null,
    trend: null,
    notes: "",
    blockers: ""
  };

  return {
    ...cloneAnnualGoal(goal),
    evaluations: {
      ...goal.evaluations,
      [monthKey]: {
        ...existing,
        ...changes
      }
    },
    updatedAt: new Date().toISOString()
  };
};

const buildMonthKeysForYear = (year: number): string[] =>
  Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);

export const getAnnualGoalSourceDefinition = (
  sourceId: AnnualGoalSourceId | null
): AnnualGoalSourceDefinition | null =>
  sourceId ? sourceDefinitions.find((definition) => definition.id === sourceId) ?? null : null;

/** Fraction of the calendar year elapsed on a local date (0–1). */
export const computeYearProgressFraction = (year: number, asOfDate: string): number => {
  const yearPrefix = `${year}-`;
  if (!asOfDate.startsWith(yearPrefix)) {
    if (asOfDate.slice(0, 4) < String(year)) {
      return 0;
    }
    if (asOfDate.slice(0, 4) > String(year)) {
      return 1;
    }
  }

  const start = new Date(`${year}-01-01T12:00:00`);
  const end = new Date(`${year}-12-31T12:00:00`);
  const asOf = new Date(`${asOfDate}T12:00:00`);

  if (asOf <= start) {
    return 0;
  }

  if (asOf >= end) {
    return 1;
  }

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = asOf.getTime() - start.getTime();
  return elapsedMs / totalMs;
};

export const ANNUAL_GOAL_PACE_TOLERANCE = 0.1;

export const isAnnualGoalOnPace = (
  progressRatio: number | null,
  expectedFraction: number,
  tolerance = ANNUAL_GOAL_PACE_TOLERANCE
): boolean => {
  if (progressRatio === null) {
    return false;
  }

  if (expectedFraction <= 0) {
    return progressRatio >= 1;
  }

  return progressRatio >= expectedFraction - tolerance;
};

export const buildAnnualGoalSnapshots = (
  goals: AnnualGoal[],
  year: number,
  entries: DailyEntry[],
  weeklySummaries: WeeklyReviewSummary[]
): AnnualGoalSnapshot[] => {
  const yearEntries = entries.filter((entry) => entry.date.startsWith(`${year}-`));
  const yearWeeklySummaries = weeklySummaries.filter(
    (summary) => summary.weekStartDate.startsWith(`${year}-`) || summary.weekEndDate.startsWith(`${year}-`)
  );

  return goals.map((rawGoal) => {
    const goal = cloneAnnualGoal(rawGoal);
    const source = getAnnualGoalSourceDefinition(goal.sourceId);
    const currentValue =
      source?.computeCurrent(yearEntries, yearWeeklySummaries) ?? goal.manualCurrentValue ?? null;
    const progressRatio =
      goal.targetValue && goal.targetValue > 0 && currentValue !== null
        ? currentValue / goal.targetValue
        : null;

    return {
      goal,
      sourceType: source?.type ?? "manual",
      sourceLabel: source?.label ?? null,
      currentValue,
      progressRatio,
      monthlyProgress: buildMonthKeysForYear(year).map((monthKey) => ({
        monthKey,
        value: source?.computeMonth(monthKey, yearEntries, yearWeeklySummaries) ?? null
      })),
      linkedWeeklyMetricLabels: source?.weeklyMetricLabels ?? [],
      linkedDailyHabitLabels: source?.dailyHabitLabels ?? []
    };
  });
};
