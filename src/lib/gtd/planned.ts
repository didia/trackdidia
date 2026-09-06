/**
 * Pure ordering and reconciliation rules for the project-only "planned" task bucket.
 * Shared by `MemoryRepository` and `TauriSqliteRepository` so both storage
 * implementations enforce identical invariants.
 */
import type { Project, Task } from "../../domain/types";
import { cloneTask } from "./shared";

const isActivePlannedForProject = (task: Task, projectId: string): boolean =>
  task.status === "active" && task.bucket === "planned" && task.projectId === projectId;

export const activePlannedTasksForProject = (tasks: Task[], projectId: string): Task[] =>
  tasks.filter((task) => isActivePlannedForProject(task, projectId));

/** Deterministic order: `plannedOrder` ascending, then `createdAt`, then `id`. */
const compareByPlannedOrder = (left: Task, right: Task): number => {
  const leftOrder = left.plannedOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.plannedOrder ?? Number.MAX_SAFE_INTEGER;

  return (
    leftOrder - rightOrder ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
};

export const sortedActivePlannedTasks = (tasks: Task[], projectId: string): Task[] =>
  [...activePlannedTasksForProject(tasks, projectId)].sort(compareByPlannedOrder);

/** Order to assign to a task newly appended to a project's active planned queue. */
export const nextPlannedOrder = (
  tasks: Task[],
  projectId: string,
  excludeTaskId?: string,
): number => {
  const active = activePlannedTasksForProject(tasks, projectId).filter(
    (task) => task.id !== excludeTaskId,
  );

  if (active.length === 0) {
    return 0;
  }

  return Math.max(...active.map((task) => task.plannedOrder ?? -1)) + 1;
};

export const countActiveNextActions = (tasks: Task[], projectId: string): number =>
  tasks.filter(
    (task) =>
      task.status === "active" && task.bucket === "next_action" && task.projectId === projectId,
  ).length;

/**
 * Normalizes the active planned queue of a project to a contiguous `0..n-1` order.
 * Returns only the tasks whose `plannedOrder` actually changed.
 */
export const compactPlannedOrders = (tasks: Task[], projectId: string): Task[] => {
  const sorted = sortedActivePlannedTasks(tasks, projectId);
  const changed: Task[] = [];

  sorted.forEach((task, index) => {
    if (task.plannedOrder !== index) {
      changed.push({ ...cloneTask(task), plannedOrder: index });
    }
  });

  return changed;
};

/**
 * Determines the fields a task destined for (or leaving) the `planned` bucket must carry so
 * that `scheduledFor`/`plannedOrder` invariants hold, independent of what the caller supplied.
 *
 * `tasksSnapshot` must reflect storage state *before* this mutation is applied.
 */
export const adjustPlannedFieldsForSave = (
  previous: Task | null,
  requested: Task,
  tasksSnapshot: Task[],
): Task => {
  const enteringPlanned = requested.bucket === "planned";
  const wasPlannedSameProject =
    !!previous && previous.bucket === "planned" && previous.projectId === requested.projectId;

  if (enteringPlanned) {
    if (!requested.projectId) {
      throw new Error("Une tache planifiee doit etre rattachee a un projet");
    }

    if (wasPlannedSameProject) {
      return {
        ...requested,
        plannedOrder:
          previous!.plannedOrder ?? nextPlannedOrder(tasksSnapshot, requested.projectId),
      };
    }

    return {
      ...requested,
      plannedOrder: nextPlannedOrder(tasksSnapshot, requested.projectId, requested.id),
    };
  }

  if (previous && previous.bucket === "planned") {
    if (requested.bucket === "scheduled") {
      // Planned -> Scheduled retains the reused scheduledFor value and drops ordering.
      return { ...requested, plannedOrder: null };
    }

    // Planned -> any other bucket clears both the reused date and the order.
    return { ...requested, scheduledFor: null, plannedOrder: null };
  }

  return { ...requested, plannedOrder: null };
};

export interface ReconciliationOutcome {
  promotedTaskId: string | null;
  updatedTasks: Task[];
}

/**
 * Promotes at most one active planned task to `next_action` when `project` is active and has
 * zero active next actions, then compacts the remaining active planned queue. Pure: returns the
 * tasks that must be persisted, callers apply and persist them.
 */
export const reconcileProjectPlannedTasks = (
  tasks: Task[],
  project: Project | null,
  now: string,
): ReconciliationOutcome => {
  if (!project) {
    return { promotedTaskId: null, updatedTasks: [] };
  }

  const projectId = project.id;
  const updated: Task[] = [];
  let promoted: Task | null = null;

  if (project.status === "active" && countActiveNextActions(tasks, projectId) === 0) {
    const candidate = sortedActivePlannedTasks(tasks, projectId)[0] ?? null;

    if (candidate) {
      promoted = {
        ...cloneTask(candidate),
        bucket: "next_action",
        scheduledFor: null,
        plannedOrder: null,
        updatedAt: now,
      };
      updated.push(promoted);
    }
  }

  const workingTasks = promoted
    ? tasks.map((task) => (task.id === promoted!.id ? promoted! : task))
    : tasks;

  for (const compacted of compactPlannedOrders(workingTasks, projectId)) {
    if (!updated.some((task) => task.id === compacted.id)) {
      updated.push({ ...compacted, updatedAt: now });
    }
  }

  return { promotedTaskId: promoted?.id ?? null, updatedTasks: updated };
};

export type PlannedMoveDirection = "up" | "down";

/**
 * Swaps a planned task with its adjacent active sibling in the same project. Returns `null`
 * when the task is not an eligible active planned task, and an empty update list for a
 * harmless boundary no-op (already first/last).
 */
export const swapPlannedOrder = (
  tasks: Task[],
  taskId: string,
  direction: PlannedMoveDirection,
  now: string,
): Task[] | null => {
  const task = tasks.find((candidate) => candidate.id === taskId);

  if (!task || task.status !== "active" || task.bucket !== "planned" || !task.projectId) {
    return null;
  }

  const sorted = sortedActivePlannedTasks(tasks, task.projectId);
  const index = sorted.findIndex((candidate) => candidate.id === taskId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;

  if (targetIndex < 0 || targetIndex >= sorted.length) {
    return [];
  }

  const sibling = sorted[targetIndex];

  return [
    { ...cloneTask(task), plannedOrder: sibling.plannedOrder, updatedAt: now },
    { ...cloneTask(sibling), plannedOrder: task.plannedOrder, updatedAt: now },
  ];
};
