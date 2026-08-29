import { computeAnomalyFindings } from "../../../domain/insights/anomalies";
import { computeCorrelationFindings } from "../../../domain/insights/correlations";
import { computeFocusFindings } from "../../../domain/insights/focus";
import { computeGtdHealthFindings } from "../../../domain/insights/gtd-health";
import {
  average,
  entriesInTrailingWindow,
  sortEntriesByDate
} from "../../../domain/insights/shared";
import { computeStreakFindings } from "../../../domain/insights/streaks";
import type { Finding } from "../../../domain/insights/types";
import {
  computeMetricTrendFindings,
  computeWeeklyScoreTrend,
  type TrendDirection,
  type WeeklyScoreTrendFinding,
  type WeeklyScoreTrendPoint
} from "../../../domain/insights/trends";
import { TREND_LONG_WINDOW_DAYS, TREND_SHORT_WINDOW_DAYS } from "../../../domain/insights/constants";
import { computeDisciplineScore, resolveMetricValue } from "../../../domain/daily-entry";
import { metricDefinitions, principleDefinitions } from "../../../domain/definitions";
import { calorieTargetDaily, phoneScreenTargetMinutes, pomodoroTarget } from "../../../domain/weekly-review";
import type {
  AiPayloadScope,
  DailyEntry,
  DailyStatus,
  MetricKey,
  PomodoroTaskSummary,
  PrincipleKey,
  Project,
  Task
} from "../../../domain/types";
import type { Surface } from "./types";

/** Daily metric targets known from existing product constants. `null` where none is defined yet. */
const metricDailyTargets: Partial<Record<MetricKey, number>> = {
  tempsEcranTelephone: phoneScreenTargetMinutes / 7,
  pomodoris: pomodoroTarget / 7,
  depenseCalorique: calorieTargetDaily
};

export interface DailySnapshotMetric {
  key: MetricKey;
  label: string;
  unit: string | null;
  target: number | null;
  todayValue: number | null;
  average7d: number;
  average28d: number;
  delta: number;
  direction: TrendDirection;
}

export interface DailySnapshotPrinciple {
  key: PrincipleKey;
  label: string;
  timing: "morning" | "evening" | "anytime";
  todayValue: boolean | null;
  currentStreak: number;
  longestStreak: number;
  daysSinceLastTrue: number | null;
  rate28d: number;
}

export interface DailySnapshotGtdSample {
  id: string;
  /** Present only at `metrics_and_structure` scope and above. */
  title?: string;
}

export interface DailySnapshotGtd {
  inboxBacklog: number;
  projectsWithoutNextAction: number;
  projectsWithoutNextActionSample: DailySnapshotGtdSample[];
  staleNextActions: number;
  agingWaitingFor: number;
  overdueDeadlines: number;
  scheduledVsCompletedRatio: number;
}

export interface DailySnapshotPomodoroTopTask {
  taskId: string | null;
  /** Present only at `metrics_and_structure` scope and above. */
  title?: string;
}

export interface DailySnapshotPomodoro {
  completedFocusSessionCount: number;
  totalFocusMinutes: number;
  taskConcentration: number | null;
  topTask: DailySnapshotPomodoroTopTask | null;
}

export interface DailySnapshotRescueTime {
  configured: boolean;
  /** Sunday-to-date RescueTime pulse (0-100), not a same-day figure — see `computeFocusFindings`. */
  productivityPulseWeekToDate: number | null;
}

export interface DailySnapshotHistory {
  daysConsidered: number;
  disciplineAverage7d: number;
  disciplineAverage28d: number;
}

export interface DailySnapshotNotes {
  morningIntention: string;
  nightReflection: string;
  tomorrowFocus: string;
}

export interface DailySnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  date: string;
  status: DailyStatus;
  metrics: DailySnapshotMetric[];
  principles: DailySnapshotPrinciple[];
  /** Present only at `full` scope. */
  notes?: DailySnapshotNotes;
  gtd: DailySnapshotGtd;
  pomodoro: DailySnapshotPomodoro;
  rescueTime: DailySnapshotRescueTime;
  history: DailySnapshotHistory;
  weeklyScoreTrend: WeeklyScoreTrendFinding | null;
  findings: Finding[];
}

export interface DailySnapshotInputs {
  /** Local `YYYY-MM-DD` date the snapshot is built for. */
  date: string;
  entry: DailyEntry;
  /** History used for streaks/trends/correlations/anomalies. Should include `entry` itself. */
  historyEntries: DailyEntry[];
  weeklyScoreHistory?: WeeklyScoreTrendPoint[];
  tasks: Task[];
  projects: Project[];
  pomodoroTaskSummaries: PomodoroTaskSummary[];
  completedFocusSessionCount: number;
  /** Sunday-to-date RescueTime pulse (0-100), not a same-day figure — see `computeFocusFindings`. */
  productivityPulseWeekToDate: number | null;
  rescuetimeConfigured: boolean;
  /** ISO instant used as "now" for GTD/Pomodoro findings. */
  now: string;
}

const projectTitleById = (projects: Project[]): Map<string, string> =>
  new Map(projects.map((project) => [project.id, project.title]));

/**
 * Builds the typed, labelled, compact daily snapshot (spec `ai-integration-v2.md` §5) from
 * already-fetched repository data and insight findings. Redaction is applied centrally here
 * based on `scope`, so no caller can leak a field by forgetting to redact.
 */
export const buildDailySnapshot = (inputs: DailySnapshotInputs, scope: AiPayloadScope): DailySnapshot => {
  const includeStructure = scope === "metrics_and_structure" || scope === "full";
  const includeFreeText = scope === "full";

  const ordered = sortEntriesByDate(inputs.historyEntries);
  const streakFindings = computeStreakFindings(ordered, inputs.date);
  const trendFindings = computeMetricTrendFindings(ordered, inputs.date);
  const correlationFindings = computeCorrelationFindings(ordered);
  const anomalyFindings = computeAnomalyFindings(ordered, inputs.date);
  const gtdHealthFindings = computeGtdHealthFindings(inputs.tasks, inputs.projects, inputs.now);
  const focusFindings = computeFocusFindings(
    inputs.pomodoroTaskSummaries,
    inputs.completedFocusSessionCount,
    inputs.now,
    inputs.productivityPulseWeekToDate
  );
  const weeklyScoreTrend = inputs.weeklyScoreHistory ? computeWeeklyScoreTrend(inputs.weeklyScoreHistory) : null;

  const metrics: DailySnapshotMetric[] = metricDefinitions.map((definition) => {
    const trend = trendFindings.find((finding) => finding.metricKey === definition.key);
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit ?? null,
      target: metricDailyTargets[definition.key] ?? null,
      todayValue: resolveMetricValue(inputs.entry, definition.key),
      average7d: trend?.average7d ?? 0,
      average28d: trend?.average28d ?? 0,
      delta: trend?.delta ?? 0,
      direction: trend?.direction ?? "flat"
    };
  });

  const principles: DailySnapshotPrinciple[] = principleDefinitions.map((definition) => {
    const streak = streakFindings.find((finding) => finding.principleKey === definition.key);
    return {
      key: definition.key,
      label: definition.label,
      timing: definition.timing,
      todayValue: inputs.entry.principleChecks[definition.key],
      currentStreak: streak?.currentStreak ?? 0,
      longestStreak: streak?.longestStreak ?? 0,
      daysSinceLastTrue: streak?.daysSinceLastTrue ?? null,
      rate28d: streak?.rate28d ?? 0
    };
  });

  const inboxBacklogFinding = gtdHealthFindings.find((finding) => finding.kind === "inbox_backlog");
  const projectsWithoutNextActionFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "projects_without_next_action"
  );
  const staleNextActionsFinding = gtdHealthFindings.find((finding) => finding.kind === "stale_next_actions");
  const agingWaitingForFinding = gtdHealthFindings.find((finding) => finding.kind === "aging_waiting_for");
  const overdueDeadlinesFinding = gtdHealthFindings.find((finding) => finding.kind === "overdue_deadlines");
  const scheduledVsCompletedFinding = gtdHealthFindings.find(
    (finding) => finding.kind === "scheduled_vs_completed_ratio"
  );
  const projectTitles = projectTitleById(inputs.projects);

  const gtd: DailySnapshotGtd = {
    inboxBacklog: inboxBacklogFinding?.value ?? 0,
    projectsWithoutNextAction: projectsWithoutNextActionFinding?.value ?? 0,
    projectsWithoutNextActionSample: (projectsWithoutNextActionFinding?.projectIds ?? []).slice(0, 3).map((id) => ({
      id,
      ...(includeStructure ? { title: projectTitles.get(id) ?? id } : {})
    })),
    staleNextActions: staleNextActionsFinding?.value ?? 0,
    agingWaitingFor: agingWaitingForFinding?.value ?? 0,
    overdueDeadlines: overdueDeadlinesFinding?.value ?? 0,
    scheduledVsCompletedRatio: scheduledVsCompletedFinding?.value ?? 0
  };

  const focusTotalsFinding = focusFindings.find((finding) => finding.kind === "focus_totals");
  const taskConcentrationFinding = focusFindings.find((finding) => finding.kind === "task_concentration");
  const topTaskSummary = inputs.pomodoroTaskSummaries.reduce<PomodoroTaskSummary | null>((top, summary) => {
    if (!top || summary.totalSeconds > top.totalSeconds) {
      return summary;
    }
    return top;
  }, null);
  const totalFocusSeconds = inputs.pomodoroTaskSummaries.reduce((sum, summary) => sum + summary.totalSeconds, 0);

  const pomodoro: DailySnapshotPomodoro = {
    completedFocusSessionCount: focusTotalsFinding?.value ?? inputs.completedFocusSessionCount,
    totalFocusMinutes: Math.round(totalFocusSeconds / 60),
    taskConcentration: taskConcentrationFinding?.value ?? null,
    topTask: topTaskSummary
      ? {
          taskId: topTaskSummary.taskId,
          ...(includeStructure ? { title: topTaskSummary.taskTitle } : {})
        }
      : null
  };

  const rescueTime: DailySnapshotRescueTime = {
    configured: inputs.rescuetimeConfigured,
    productivityPulseWeekToDate: inputs.productivityPulseWeekToDate
  };

  const disciplineShortWindow = entriesInTrailingWindow(ordered, inputs.date, TREND_SHORT_WINDOW_DAYS);
  const disciplineLongWindow = entriesInTrailingWindow(ordered, inputs.date, TREND_LONG_WINDOW_DAYS);
  const history: DailySnapshotHistory = {
    daysConsidered: disciplineLongWindow.length,
    disciplineAverage7d: average(disciplineShortWindow.map((entry) => computeDisciplineScore(entry))),
    disciplineAverage28d: average(disciplineLongWindow.map((entry) => computeDisciplineScore(entry)))
  };

  const findings: Finding[] = [
    ...streakFindings,
    ...trendFindings,
    ...correlationFindings,
    ...anomalyFindings,
    ...gtdHealthFindings,
    ...focusFindings,
    ...(weeklyScoreTrend ? [weeklyScoreTrend] : [])
  ];

  return {
    surface: "daily",
    scope,
    date: inputs.date,
    status: inputs.entry.status,
    metrics,
    principles,
    ...(includeFreeText
      ? {
          notes: {
            morningIntention: inputs.entry.morningIntention,
            nightReflection: inputs.entry.nightReflection,
            tomorrowFocus: inputs.entry.tomorrowFocus
          }
        }
      : {}),
    gtd,
    pomodoro,
    rescueTime,
    history,
    weeklyScoreTrend,
    findings
  };
};
