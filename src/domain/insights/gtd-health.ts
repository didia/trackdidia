import { t } from "../../i18n";
import { addDays, toLocalDateString } from "../../lib/gtd/shared";
import type { Project, Task } from "../types";
import {
  AGING_WAITING_FOR_DAYS,
  STALE_NEXT_ACTION_DAYS,
  TREND_LONG_WINDOW_DAYS,
} from "./constants";
import { buildEvidenceWindow, daysBetweenDates } from "./shared";
import type { Finding } from "./types";

export type GtdHealthFindingKind =
  | "inbox_backlog"
  | "projects_without_next_action"
  | "stale_next_actions"
  | "aging_waiting_for"
  | "overdue_deadlines"
  | "scheduled_vs_completed_ratio";

export interface GtdHealthFinding extends Finding {
  kind: GtdHealthFindingKind;
  taskIds: string[];
  projectIds: string[];
}

const buildFinding = (
  kind: GtdHealthFindingKind,
  now: string,
  value: number,
  /** Size of the population this finding was evaluated over (not just the matching items). */
  sampleSize: number,
  label: string,
  options: { taskIds?: string[]; projectIds?: string[]; severity?: Finding["severity"] } = {},
): GtdHealthFinding => {
  const nowDate = toLocalDateString(now);
  return {
    id: `gtd_health:${kind}:${nowDate}`,
    severity: options.severity ?? (value > 0 ? "watch" : "info"),
    evidenceWindow: buildEvidenceWindow(nowDate, nowDate),
    sampleSize,
    value,
    label,
    kind,
    taskIds: options.taskIds ?? [],
    projectIds: options.projectIds ?? [],
  };
};

/**
 * GTD workspace health (spec `ai-integration-v2.md` §3): inbox backlog, projects with no
 * next action, next actions untouched for too long, aging waiting-for items, overdue
 * deadlines, and the scheduled-vs-completed ratio. `now` is an ISO instant so callers stay
 * in control of "current time" for deterministic tests.
 */
export const computeGtdHealthFindings = (
  tasks: Task[],
  projects: Project[],
  now: string,
): GtdHealthFinding[] => {
  const nowDate = toLocalDateString(now);
  const findings: GtdHealthFinding[] = [];

  const activeTasks = tasks.filter((task) => task.status === "active");

  const inboxTasks = activeTasks.filter((task) => task.bucket === "inbox");
  findings.push(
    buildFinding(
      "inbox_backlog",
      now,
      inboxTasks.length,
      activeTasks.length,
      t("inboxBacklog", { ns: "insights", count: inboxTasks.length }),
      { taskIds: inboxTasks.map((task) => task.id) },
    ),
  );

  const activeNextActionProjectIds = new Set(
    activeTasks
      .filter((task) => task.bucket === "next_action" && task.projectId)
      .map((task) => task.projectId as string),
  );
  const activeProjects = projects.filter((project) => project.status === "active");
  const projectsWithoutNextAction = activeProjects.filter(
    (project) => !activeNextActionProjectIds.has(project.id),
  );
  findings.push(
    buildFinding(
      "projects_without_next_action",
      now,
      projectsWithoutNextAction.length,
      activeProjects.length,
      t("projectsWithoutNext", { ns: "insights", count: projectsWithoutNextAction.length }),
      { projectIds: projectsWithoutNextAction.map((project) => project.id) },
    ),
  );

  const nextActions = activeTasks.filter((task) => task.bucket === "next_action");
  const staleNextActions = nextActions.filter(
    (task) => daysBetweenDates(toLocalDateString(task.updatedAt), nowDate) > STALE_NEXT_ACTION_DAYS,
  );
  findings.push(
    buildFinding(
      "stale_next_actions",
      now,
      staleNextActions.length,
      nextActions.length,
      t("staleNextActions", {
        ns: "insights",
        count: staleNextActions.length,
        days: STALE_NEXT_ACTION_DAYS,
      }),
      { taskIds: staleNextActions.map((task) => task.id) },
    ),
  );

  const waitingForTasks = activeTasks.filter((task) => task.bucket === "waiting_for");
  const agingWaitingFor = waitingForTasks.filter(
    (task) => daysBetweenDates(toLocalDateString(task.updatedAt), nowDate) > AGING_WAITING_FOR_DAYS,
  );
  findings.push(
    buildFinding(
      "aging_waiting_for",
      now,
      agingWaitingFor.length,
      waitingForTasks.length,
      t("agingWaiting", {
        ns: "insights",
        count: agingWaitingFor.length,
        days: AGING_WAITING_FOR_DAYS,
      }),
      { taskIds: agingWaitingFor.map((task) => task.id) },
    ),
  );

  const tasksWithDeadline = activeTasks.filter((task) => task.deadline !== null);
  const overdueDeadlines = tasksWithDeadline.filter((task) => (task.deadline as string) < nowDate);
  findings.push(
    buildFinding(
      "overdue_deadlines",
      now,
      overdueDeadlines.length,
      tasksWithDeadline.length,
      t("overdueDeadlines", { ns: "insights", count: overdueDeadlines.length }),
      { taskIds: overdueDeadlines.map((task) => task.id) },
    ),
  );

  const scheduledActive = activeTasks.filter((task) => task.bucket === "scheduled");
  const windowStartDate = addDays(nowDate, -TREND_LONG_WINDOW_DAYS);
  const completedInWindow = tasks.filter(
    (task) =>
      task.status === "completed" &&
      task.completedAt !== null &&
      toLocalDateString(task.completedAt) >= windowStartDate,
  );
  const scheduledVsCompletedRatio = scheduledActive.length / Math.max(1, completedInWindow.length);
  findings.push(
    buildFinding(
      "scheduled_vs_completed_ratio",
      now,
      scheduledVsCompletedRatio,
      scheduledActive.length + completedInWindow.length,
      t("scheduledVsCompleted", {
        ns: "insights",
        count: scheduledActive.length,
        scheduled: scheduledActive.length,
        done: completedInWindow.length,
        days: TREND_LONG_WINDOW_DAYS,
        ratio: scheduledVsCompletedRatio.toFixed(2),
      }),
      {
        taskIds: [
          ...scheduledActive.map((task) => task.id),
          ...completedInWindow.map((task) => task.id),
        ],
        severity: "info",
      },
    ),
  );

  return findings;
};
