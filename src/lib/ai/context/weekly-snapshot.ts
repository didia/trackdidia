import { createEmptyDailyEntry, resolveMetricValue } from "../../../domain/daily-entry";
import { metricDefinitions, principleDefinitions } from "../../../domain/definitions";
import { computeAnomalyFindings } from "../../../domain/insights/anomalies";
import { computeFocusFindings } from "../../../domain/insights/focus";
import { computeGtdHealthFindings } from "../../../domain/insights/gtd-health";
import { computeStreakFindings } from "../../../domain/insights/streaks";
import type { Finding } from "../../../domain/insights/types";
import type {
  AiPayloadScope,
  DailyEntry,
  MetricKey,
  PomodoroTaskSummary,
  PrincipleKey,
  Project,
  Task,
  WeeklyReview,
  WeeklyReviewStatus,
  WeeklyReviewSummary,
  WeeklyRitualSectionKey,
} from "../../../domain/types";
import {
  applyWeeklyScoreExternalAxes,
  buildWeekDates,
  calorieTargetDaily,
  listWeekDates,
  localWeeklyScoreAxes,
  phoneScreenTargetMinutes,
  pomodoroTarget,
} from "../../../domain/weekly-review";
import type { Surface } from "./types";

const metricWeeklyTargets: Partial<Record<MetricKey, number>> = {
  tempsEcranTelephone: phoneScreenTargetMinutes,
  pomodoris: pomodoroTarget,
  depenseCalorique: calorieTargetDaily * 7,
};

export interface WeeklySnapshotAxis {
  key: string;
  label: string;
  score: number;
}

export interface WeeklySnapshotMetric {
  key: MetricKey;
  label: string;
  unit: string | null;
  target: number | null;
  weekTotal: number | null;
  weekAverage: number | null;
}

export interface WeeklySnapshotPrinciple {
  key: PrincipleKey;
  label: string;
  timing: "morning" | "evening" | "anytime";
  daysTrue: number;
  weekRate: number;
}

export interface WeeklySnapshotGtdSample {
  id: string;
  title?: string;
}

export interface WeeklySnapshotGtd {
  inboxBacklog: number;
  projectsWithoutNextAction: number;
  projectsWithoutNextActionSample: WeeklySnapshotGtdSample[];
  staleNextActions: number;
  agingWaitingFor: number;
  overdueDeadlines: number;
  scheduledVsCompletedRatio: number;
}

export interface WeeklySnapshotFocus {
  completedFocusSessionCount: number;
  totalFocusMinutes: number;
  taskConcentration: number | null;
  topTask: { taskId: string | null; title?: string } | null;
  productivityPulse: number | null;
  rescueTimeConfigured: boolean;
}

export interface WeeklySnapshotReviewNotes {
  [key: string]: string;
}

export interface WeeklySnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  weekStartDate: string;
  weekEndDate: string;
  reviewStatus: WeeklyReviewStatus;
  weeklyScore: number;
  axes: WeeklySnapshotAxis[];
  metrics: WeeklySnapshotMetric[];
  principles: WeeklySnapshotPrinciple[];
  gtd: WeeklySnapshotGtd;
  focus: WeeklySnapshotFocus;
  notes?: Partial<Record<WeeklyRitualSectionKey, string>>;
  findings: Finding[];
}

export interface WeeklySnapshotInputs {
  weekStartDate: string;
  summary: WeeklyReviewSummary;
  weekEntries: DailyEntry[];
  historyEntries: DailyEntry[];
  review: WeeklyReview | null;
  tasks: Task[];
  projects: Project[];
  pomodoroTaskSummaries: PomodoroTaskSummary[];
  completedFocusSessionCount: number;
  productivityPulse: number | null;
  rescueTimeGoalsScore: number | null;
  rescuetimeConfigured: boolean;
  now: string;
}

const axisDefinitions = (
  summary: WeeklyReviewSummary,
): Array<{ key: string; label: string; score: number }> => [
  { key: "sleepQuality", label: "Sommeil", score: summary.sleepQuality },
  { key: "respectTrc", label: "Respect TRC", score: summary.respectTrc },
  { key: "phoneScreenTime", label: "Temps d'ecran", score: summary.phoneScreenTime },
  { key: "pomodoris", label: "Pomodoris", score: summary.pomodoris },
  { key: "discipline", label: "Discipline", score: summary.discipline },
  { key: "tasksCompletionRate", label: "Completion taches", score: summary.tasksCompletionRate },
  { key: "physicalActivity", label: "Activite physique", score: summary.physicalActivity },
  ...(summary.rescueTimeGoalsScore !== null
    ? [
        {
          key: "rescueTimeGoalsScore",
          label: "Objectifs RescueTime",
          score: summary.rescueTimeGoalsScore * 100,
        },
      ]
    : []),
  ...(summary.productivityPulse !== null
    ? [
        {
          key: "productivityPulse",
          label: "Productivite ordinateur",
          score: summary.productivityPulse,
        },
      ]
    : []),
];

const projectTitleById = (projects: Project[]): Map<string, string> =>
  new Map(projects.map((project) => [project.id, project.title]));

const sanitizeFindingForScope = (finding: Finding, includeStructure: boolean): Finding => {
  if (includeStructure) {
    return finding;
  }

  const {
    taskIds: _taskIds,
    projectIds: _projectIds,
    ...rest
  } = finding as Finding & {
    taskIds?: string[];
    projectIds?: string[];
  };

  return rest as Finding;
};

const aggregatePomodoroSummaries = (
  summariesByDay: PomodoroTaskSummary[][],
): PomodoroTaskSummary[] => {
  const totals = new Map<string, PomodoroTaskSummary>();

  for (const daySummaries of summariesByDay) {
    for (const summary of daySummaries) {
      const existing = totals.get(summary.taskId ?? summary.taskTitle);
      if (!existing) {
        totals.set(summary.taskId ?? summary.taskTitle, { ...summary });
        continue;
      }

      existing.totalSeconds += summary.totalSeconds;
      existing.sessionCount += summary.sessionCount;
    }
  }

  return [...totals.values()];
};

export const buildWeeklySnapshot = (
  inputs: WeeklySnapshotInputs,
  scope: AiPayloadScope,
): WeeklySnapshot => {
  const includeStructure = scope === "metrics_and_structure" || scope === "full";
  const includeFreeText = scope === "full";
  const normalizedWeekStart = buildWeekDates(inputs.weekStartDate);
  const weekEndDate = inputs.summary.weekEndDate;
  const weekDates = listWeekDates(normalizedWeekStart);
  const entriesByDate = new Map(inputs.weekEntries.map((entry) => [entry.date, entry]));

  const enrichedSummary = applyWeeklyScoreExternalAxes(inputs.summary, {
    rescueTimeGoalsScore: inputs.rescueTimeGoalsScore,
    productivityPulse: inputs.productivityPulse,
  });

  const streakFindings = computeStreakFindings(inputs.historyEntries, weekEndDate);
  const anomalyFindings = computeAnomalyFindings(inputs.historyEntries, weekEndDate);
  const gtdHealthFindings = computeGtdHealthFindings(inputs.tasks, inputs.projects, inputs.now);
  const focusFindings = computeFocusFindings(
    inputs.pomodoroTaskSummaries,
    inputs.completedFocusSessionCount,
    inputs.now,
    inputs.productivityPulse,
  );

  const metrics: WeeklySnapshotMetric[] = metricDefinitions.map((definition) => {
    const values = weekDates
      .map((date) => entriesByDate.get(date))
      .filter((entry): entry is DailyEntry => entry !== undefined)
      .map((entry) => resolveMetricValue(entry, definition.key))
      .filter((value): value is number => value !== null);

    const weekTotal = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
    const weekAverage = values.length > 0 ? weekTotal! / values.length : null;

    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit ?? null,
      target: metricWeeklyTargets[definition.key] ?? null,
      weekTotal,
      weekAverage,
    };
  });

  const principles: WeeklySnapshotPrinciple[] = principleDefinitions.map((definition) => {
    const daysTrue = weekDates.filter(
      (date) => entriesByDate.get(date)?.principleChecks[definition.key] === true,
    ).length;

    return {
      key: definition.key,
      label: definition.label,
      timing: definition.timing,
      daysTrue,
      weekRate: daysTrue / 7,
    };
  });

  const inboxBacklogFinding = gtdHealthFindings.find((finding) => finding.kind === "inbox_backlog");
  const projectsWithoutNextActionFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "projects_without_next_action",
  );
  const staleNextActionsFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "stale_next_actions",
  );
  const agingWaitingForFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "aging_waiting_for",
  );
  const overdueDeadlinesFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "overdue_deadlines",
  );
  const scheduledVsCompletedFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "scheduled_vs_completed_ratio",
  );
  const projectTitles = projectTitleById(inputs.projects);

  const gtd: WeeklySnapshotGtd = {
    inboxBacklog: inboxBacklogFinding?.value ?? 0,
    projectsWithoutNextAction: projectsWithoutNextActionFinding?.value ?? 0,
    projectsWithoutNextActionSample: (projectsWithoutNextActionFinding?.projectIds ?? [])
      .slice(0, 3)
      .map((id) => ({
        id,
        ...(includeStructure ? { title: projectTitles.get(id) ?? id } : {}),
      })),
    staleNextActions: staleNextActionsFinding?.value ?? 0,
    agingWaitingFor: agingWaitingForFinding?.value ?? 0,
    overdueDeadlines: overdueDeadlinesFinding?.value ?? 0,
    scheduledVsCompletedRatio: scheduledVsCompletedFinding?.value ?? 0,
  };

  const focusTotalsFinding = focusFindings.find((finding) => finding.kind === "focus_totals");
  const taskConcentrationFinding = focusFindings.find(
    (finding) => finding.kind === "task_concentration",
  );
  const topTaskSummary = inputs.pomodoroTaskSummaries.reduce<PomodoroTaskSummary | null>(
    (top, summary) => {
      if (!top || summary.totalSeconds > top.totalSeconds) {
        return summary;
      }
      return top;
    },
    null,
  );
  const totalFocusSeconds = inputs.pomodoroTaskSummaries.reduce(
    (sum, summary) => sum + summary.totalSeconds,
    0,
  );

  const focus: WeeklySnapshotFocus = {
    completedFocusSessionCount: focusTotalsFinding?.value ?? inputs.completedFocusSessionCount,
    totalFocusMinutes: Math.round(totalFocusSeconds / 60),
    taskConcentration: taskConcentrationFinding?.value ?? null,
    topTask: topTaskSummary
      ? {
          taskId: topTaskSummary.taskId,
          ...(includeStructure ? { title: topTaskSummary.taskTitle } : {}),
        }
      : null,
    productivityPulse: inputs.productivityPulse,
    rescueTimeConfigured: inputs.rescuetimeConfigured,
  };

  const findings: Finding[] = [
    ...streakFindings,
    ...anomalyFindings,
    ...gtdHealthFindings,
    ...focusFindings,
  ].map((finding) => sanitizeFindingForScope(finding, includeStructure));

  return {
    surface: "weekly",
    scope,
    weekStartDate: normalizedWeekStart,
    weekEndDate,
    reviewStatus: inputs.review?.status ?? "draft",
    weeklyScore: enrichedSummary.weeklyScore,
    axes: axisDefinitions(enrichedSummary),
    metrics,
    principles,
    gtd,
    focus,
    ...(includeFreeText && inputs.review
      ? {
          notes: { ...inputs.review.notes },
        }
      : {}),
    findings,
  };
};

export const resolveWeeklySnapshotInputs = async (
  repository: import("../../storage/repository").AppRepository,
  weekStartDate: string,
  options: {
    now?: string;
    productivityPulse?: number | null;
    rescueTimeGoalsScore?: number | null;
    rescuetimeConfigured?: boolean;
  } = {},
): Promise<WeeklySnapshotInputs> => {
  const normalized = buildWeekDates(weekStartDate);
  const weekDates = listWeekDates(normalized);
  const weekEndDate = weekDates[weekDates.length - 1];
  const now = options.now ?? new Date().toISOString();

  const [summary, review, historyEntries, tasks, projects, ...weekEntryRows] = await Promise.all([
    repository.computeWeeklyReviewSummary(normalized),
    repository.getWeeklyReview(normalized),
    repository.listDailyEntriesOnOrBefore(weekEndDate, 180),
    repository.listTasks({ includeCompleted: true }),
    repository.listProjects(),
    ...weekDates.map((date) => repository.getDailyEntry(date)),
  ]);

  const weekEntries = weekDates.map(
    (date, index) => weekEntryRows[index] ?? createEmptyDailyEntry(date),
  );
  const pomodoroSummariesByDay: PomodoroTaskSummary[][] = [];
  let completedFocusSessionCount = 0;

  for (const date of weekDates) {
    const [summaries, stats] = await Promise.all([
      repository.listPomodoroTaskSummaries(date, now),
      repository.computeDailyPomodoroStats(date),
    ]);
    pomodoroSummariesByDay.push(summaries);
    completedFocusSessionCount += stats.completedFocusSessions;
  }

  const pomodoroTaskSummaries = aggregatePomodoroSummaries(pomodoroSummariesByDay);

  return {
    weekStartDate: normalized,
    summary,
    weekEntries,
    historyEntries,
    review,
    tasks,
    projects,
    pomodoroTaskSummaries,
    completedFocusSessionCount,
    productivityPulse: options.productivityPulse ?? null,
    rescueTimeGoalsScore: options.rescueTimeGoalsScore ?? null,
    rescuetimeConfigured: options.rescuetimeConfigured ?? false,
    now,
  };
};

/** Exported for fallback axis ranking. */
export const rankWeeklyAxes = (summary: WeeklyReviewSummary): WeeklySnapshotAxis[] =>
  axisDefinitions(
    applyWeeklyScoreExternalAxes(summary, {
      rescueTimeGoalsScore: summary.rescueTimeGoalsScore,
      productivityPulse: summary.productivityPulse,
    }),
  );

/** Sanity check used in tests — local axes count without external overlays. */
export const localWeeklyAxisCount = (summary: WeeklyReviewSummary): number =>
  localWeeklyScoreAxes(summary).length;
