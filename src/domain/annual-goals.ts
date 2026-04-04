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

const sourceDefinitions: AnnualGoalSourceDefinition[] = [
  {
    id: "weekly_sleep_average",
    label: "Sommeil moyen hebdo",
    type: "weekly_summary",
    weeklyMetricLabels: ["Sommeil moyen"],
    dailyHabitLabels: ["Qualite du sommeil"],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.sleepAverage),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.sleepAverage)
  },
  {
    id: "weekly_respect_trc",
    label: "Respect TRC hebdo",
    type: "weekly_summary",
    weeklyMetricLabels: ["Respect TRC"],
    dailyHabitLabels: ["Respect TRC"],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.respectTrc),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.respectTrc)
  },
  {
    id: "weekly_weekly_score",
    label: "Score hebdo moyen",
    type: "weekly_summary",
    weeklyMetricLabels: ["Score hebdo"],
    dailyHabitLabels: ["Sommeil", "TRC", "Temps d'ecran", "Pomodoris", "Discipline", "Taches"],
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
    label: "Discipline hebdo",
    type: "weekly_summary",
    weeklyMetricLabels: ["Discipline moyenne"],
    dailyHabitLabels: ["Principes de vie"],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.disciplineAverage * 100),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.disciplineAverage * 100)
  },
  {
    id: "weekly_tasks_completion_rate",
    label: "Completion des taches hebdo",
    type: "weekly_summary",
    weeklyMetricLabels: ["Taux de completion des taches"],
    dailyHabitLabels: ["Taches realisees", "Taches ajoutees"],
    computeCurrent: (_entries, weeklySummaries) => weeklyAverage(weeklySummaries, (summary) => summary.tasksCompletionRate),
    computeMonth: (monthKey, _entries, weeklySummaries) => weeklyAverage(filterWeeklyByMonth(monthKey, weeklySummaries), (summary) => summary.tasksCompletionRate)
  },
  {
    id: "daily_depense_calorique_avg",
    label: "Depense calorique moyenne",
    type: "daily_metric",
    weeklyMetricLabels: [],
    dailyHabitLabels: ["Depense calorique"],
    computeCurrent: (entries) => dailyAverageMetric(entries, "depenseCalorique"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "depenseCalorique")
  },
  {
    id: "daily_qualite_sommeil_avg",
    label: "Qualite du sommeil moyenne",
    type: "daily_metric",
    weeklyMetricLabels: ["Sommeil moyen hebdo"],
    dailyHabitLabels: ["Qualite du sommeil"],
    computeCurrent: (entries) => dailyAverageMetric(entries, "qualiteSommeil"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "qualiteSommeil")
  },
  {
    id: "daily_temps_ecran_avg",
    label: "Temps d'ecran moyen",
    type: "daily_metric",
    weeklyMetricLabels: ["Temps d'ecran hebdo"],
    dailyHabitLabels: ["Temps d'ecran telephone"],
    computeCurrent: (entries) => dailyAverageMetric(entries, "tempsEcranTelephone"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "tempsEcranTelephone")
  },
  {
    id: "daily_pomodoris_sum",
    label: "Pomodoris mensuels",
    type: "daily_metric",
    weeklyMetricLabels: ["Pomodoris hebdo"],
    dailyHabitLabels: ["Pomodoris"],
    computeCurrent: (entries) => sum(entries.map((entry) => resolveMetricValue(entry, "pomodoris") ?? 0)),
    computeMonth: (monthKey, entries) => sum(filterEntriesByMonth(monthKey, entries).map((entry) => resolveMetricValue(entry, "pomodoris") ?? 0))
  },
  {
    id: "daily_pomodoris_avg",
    label: "Pomodoris moyens",
    type: "daily_metric",
    weeklyMetricLabels: ["Pomodoris hebdo"],
    dailyHabitLabels: ["Pomodoris"],
    computeCurrent: (entries) => dailyAverageMetric(entries, "pomodoris"),
    computeMonth: (monthKey, entries) => dailyAverageMetric(filterEntriesByMonth(monthKey, entries), "pomodoris")
  },
  {
    id: "daily_respect_trc_rate",
    label: "Respect TRC quotidien",
    type: "daily_principle",
    weeklyMetricLabels: ["Respect TRC hebdo"],
    dailyHabitLabels: ["Respect TRC"],
    computeCurrent: (entries) => computePrincipleRate(entries, "respectTrc"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "respectTrc")
  },
  {
    id: "daily_respect_reveil_rate",
    label: "Respect reveil",
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: ["Respect reveil"],
    computeCurrent: (entries) => computePrincipleRate(entries, "respectReveil"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "respectReveil")
  },
  {
    id: "daily_priere_du_matin_rate",
    label: "Priere du matin",
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: ["Priere du matin"],
    computeCurrent: (entries) => computePrincipleRate(entries, "priereDuMatin"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "priereDuMatin")
  },
  {
    id: "daily_priere_du_soir_rate",
    label: "Priere du soir",
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: ["Priere du soir"],
    computeCurrent: (entries) => computePrincipleRate(entries, "priereDuSoir"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "priereDuSoir")
  },
  {
    id: "daily_objectifs_atteints_rate",
    label: "Objectifs atteints",
    type: "daily_principle",
    weeklyMetricLabels: [],
    dailyHabitLabels: ["Objectifs atteints"],
    computeCurrent: (entries) => computePrincipleRate(entries, "objectifsAtteints"),
    computeMonth: (monthKey, entries) => computePrincipleRate(filterEntriesByMonth(monthKey, entries), "objectifsAtteints")
  }
];

export const annualGoalDimensions: Array<{ value: AnnualGoalDimension; label: string }> = [
  { value: "physique", label: "Dimension physique" },
  { value: "spirituelle", label: "Dimension spirituelle" },
  { value: "sociale", label: "Dimension sociale" },
  { value: "intellectuelle", label: "Dimension intellectuelle" },
  { value: "global", label: "Global" }
];

export const annualGoalTrendOptions: Array<{ value: AnnualGoalTrend; label: string }> = [
  { value: "up", label: "En hausse" },
  { value: "steady", label: "Stable" },
  { value: "down", label: "En baisse" }
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
