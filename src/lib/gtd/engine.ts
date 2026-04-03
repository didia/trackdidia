import type {
  CreateTaskInput,
  DailyTaskStats,
  Project,
  ProjectFilters,
  Task,
  TaskContext,
  TaskEvent,
  TaskEventType,
  TaskFilters
} from "../../domain/types";
import {
  cloneContext,
  cloneProject,
  cloneTask,
  createEntityId,
  getDayRange,
  isSameLocalDate,
  isSunday,
  isTaskActionableForDate,
  nowIso
} from "./shared";

const eventFor = (
  taskId: string,
  type: TaskEventType,
  eventDate: string,
  metadata: Record<string, string> = {},
  dedupeKey: string | null = null
): TaskEvent => {
  const timestamp = nowIso();
  return {
    id: createEntityId("task-event"),
    taskId,
    type,
    eventDate,
    eventAt: timestamp,
    createdAt: timestamp,
    dedupeKey,
    metadata
  };
};

export const cloneTasks = (tasks: Task[]): Task[] => tasks.map((task) => cloneTask(task));
export const cloneProjects = (projects: Project[]): Project[] => projects.map((project) => cloneProject(project));
export const cloneContexts = (contexts: TaskContext[]): TaskContext[] => contexts.map((context) => cloneContext(context));

export const filterTasks = (tasks: Task[], filters: TaskFilters = {}): Task[] => {
  const bucketFilter = Array.isArray(filters.bucket) ? filters.bucket : filters.bucket ? [filters.bucket] : null;
  const includeCompleted = filters.includeCompleted ?? false;
  const search = filters.search?.trim().toLowerCase();

  return tasks
    .filter((task) => {
      if (!includeCompleted && task.status !== "active") {
        return false;
      }

      if (filters.status && task.status !== filters.status) {
        return false;
      }

      if (bucketFilter && !bucketFilter.includes(task.bucket)) {
        return false;
      }

      if (filters.scheduledForDate && !isSameLocalDate(task.scheduledFor, filters.scheduledForDate)) {
        return false;
      }

      if (filters.contextId && !task.contextIds.includes(filters.contextId)) {
        return false;
      }

      if (filters.projectId && task.projectId !== filters.projectId) {
        return false;
      }

      if (search) {
        const haystack = `${task.title}\n${task.notes}`.toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }

      return true;
    })
    .sort((left, right) => {
      const leftSchedule = left.scheduledFor ?? "";
      const rightSchedule = right.scheduledFor ?? "";

      if (left.bucket === "scheduled" || right.bucket === "scheduled") {
        return leftSchedule.localeCompare(rightSchedule) || left.title.localeCompare(right.title);
      }

      return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title);
    })
    .map((task) => cloneTask(task));
};

export const filterProjects = (projects: Project[], filters: ProjectFilters = {}): Project[] =>
  projects
    .filter((project) => !filters.status || project.status === filters.status)
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((project) => cloneProject(project));

export const buildDailyTaskStats = (tasks: Task[], events: TaskEvent[], date: string): DailyTaskStats => {
  const { startMs } = getDayRange(date);
  const taskEventsToday = events.filter((event) => event.eventDate === date);

  const addedToday = new Set(
    taskEventsToday
      .filter((event) =>
        event.type === "task_moved_to_next_action" ||
        event.type === "task_scheduled_for_day" ||
        event.type === "weekly_carryover"
      )
      .map((event) => event.taskId)
  );

  const completedToday = new Set(
    taskEventsToday.filter((event) => event.type === "task_completed").map((event) => event.taskId)
  );

  const startCount = tasks.filter((task) => {
    if (!isTaskActionableForDate(task, date)) {
      return false;
    }

    const createdMs = new Date(task.createdAt).getTime();
    if (!Number.isFinite(createdMs) || createdMs >= startMs) {
      return false;
    }

    if (task.completedAt) {
      const completedMs = new Date(task.completedAt).getTime();
      if (Number.isFinite(completedMs) && completedMs < startMs) {
        return false;
      }
    }

    if (task.status === "cancelled" && new Date(task.updatedAt).getTime() < startMs) {
      return false;
    }

    if (addedToday.has(task.id)) {
      return false;
    }

    return true;
  }).length;

  const tasksAdded = addedToday.size;
  const tasksCompleted = completedToday.size;

  return {
    date,
    tasksAtStart: startCount,
    tasksAdded,
    tasksCompleted,
    tasksRemaining: Math.max(0, startCount + tasksAdded - tasksCompleted)
  };
};

const collectTaskIdsByEventType = (events: TaskEvent[], types: TaskEventType[]): string[] => {
  const allowedTypes = new Set(types);
  const seen = new Set<string>();
  const orderedIds: string[] = [];

  [...events]
    .filter((event) => allowedTypes.has(event.type))
    .sort((left, right) => right.eventAt.localeCompare(left.eventAt))
    .forEach((event) => {
      if (seen.has(event.taskId)) {
        return;
      }

      seen.add(event.taskId);
      orderedIds.push(event.taskId);
    });

  return orderedIds;
};

export const buildDailyTaskBreakdown = (
  tasks: Task[],
  events: TaskEvent[],
  date: string
): { date: string; addedTasks: Task[]; completedTasks: Task[] } => {
  const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
  const taskEventsToday = events.filter((event) => event.eventDate === date);

  const addedTaskIds = collectTaskIdsByEventType(taskEventsToday, [
    "task_moved_to_next_action",
    "task_scheduled_for_day",
    "weekly_carryover"
  ]);
  const completedTaskIds = collectTaskIdsByEventType(taskEventsToday, ["task_completed"]);

  return {
    date,
    addedTasks: addedTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is Task => Boolean(task))
      .map((task) => cloneTask(task)),
    completedTasks: completedTaskIds
      .map((taskId) => tasksById.get(taskId))
      .filter((task): task is Task => Boolean(task))
      .map((task) => cloneTask(task))
  };
};

export const buildLifecycleEvents = (previous: Task | null, next: Task): TaskEvent[] => {
  const updateEventDate = next.updatedAt.slice(0, 10);
  const creationEventDate = next.createdAt.slice(0, 10);
  const events: TaskEvent[] = [];

  if (!previous) {
    events.push(eventFor(next.id, "task_created", creationEventDate, { bucket: next.bucket }));

    if (next.status === "active" && next.bucket === "next_action") {
      events.push(eventFor(next.id, "task_moved_to_next_action", creationEventDate, { bucket: next.bucket }));
    }

    if (next.status === "active" && next.bucket === "scheduled" && isSameLocalDate(next.scheduledFor, creationEventDate)) {
      events.push(
        eventFor(next.id, "task_scheduled_for_day", creationEventDate, { scheduledFor: next.scheduledFor ?? "" })
      );
    }

    return events;
  }

  if (previous.status !== "completed" && next.status === "completed") {
    events.push(eventFor(next.id, "task_completed", (next.completedAt ?? next.updatedAt).slice(0, 10), { bucket: next.bucket }));
  }

  if (
    next.isRecurringInstance &&
    previous.recurrenceDueDate !== next.recurrenceDueDate &&
    next.status === "active" &&
    next.recurrenceDueDate
  ) {
    if (next.bucket === "next_action") {
      events.push(eventFor(next.id, "task_moved_to_next_action", next.recurrenceDueDate, { recurring: "true" }));
    }

    if (next.bucket === "scheduled") {
      events.push(
        eventFor(next.id, "task_scheduled_for_day", next.recurrenceDueDate, {
          scheduledFor: next.scheduledFor ?? "",
          recurring: "true"
        })
      );
    }
  }

  if (previous.bucket !== "next_action" && next.bucket === "next_action" && next.status === "active") {
    events.push(eventFor(next.id, "task_moved_to_next_action", updateEventDate, { from: previous.bucket }));
  }

  if (
    next.status === "active" &&
    next.bucket === "scheduled" &&
    isSameLocalDate(next.scheduledFor, updateEventDate) &&
    (previous.bucket !== "scheduled" || previous.scheduledFor !== next.scheduledFor)
  ) {
    events.push(eventFor(next.id, "task_scheduled_for_day", updateEventDate, { scheduledFor: next.scheduledFor ?? "" }));
  }

  return events;
};

export const buildCarryoverEvents = (tasks: Task[], existingEvents: TaskEvent[], weekStartDate: string): TaskEvent[] => {
  if (!isSunday(weekStartDate)) {
    return [];
  }

  const existingKeys = new Set(existingEvents.map((event) => event.dedupeKey).filter(Boolean));
  const { startMs } = getDayRange(weekStartDate);

  return tasks
    .filter((task) => {
      if (task.status !== "active") {
        return false;
      }

      if (task.bucket !== "next_action" && task.bucket !== "scheduled") {
        return false;
      }

      const createdMs = new Date(task.createdAt).getTime();
      if (!Number.isFinite(createdMs) || createdMs >= startMs) {
        return false;
      }

      if (task.completedAt) {
        const completedMs = new Date(task.completedAt).getTime();
        if (Number.isFinite(completedMs) && completedMs < startMs) {
          return false;
        }
      }

      return true;
    })
    .map((task) =>
      eventFor(
        task.id,
        "weekly_carryover",
        weekStartDate,
        { bucket: task.bucket },
        `weekly_carryover:${weekStartDate}:${task.id}`
      )
    )
    .filter((event) => !existingKeys.has(event.dedupeKey));
};

export const createTaskFromInput = (input: CreateTaskInput): Task => {
  const timestamp = nowIso();

  return {
    id: input.id ?? createEntityId("task"),
    title: input.title.trim(),
    notes: input.notes?.trim() ?? "",
    status: "active",
    bucket: input.scheduledFor ? "scheduled" : input.bucket ?? "inbox",
    contextIds: [...(input.contextIds ?? [])],
    projectId: input.projectId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    scheduledFor: input.scheduledFor ?? null,
    deadline: input.deadline ?? null,
    recurringTemplateId: input.recurringTemplateId ?? null,
    recurrenceDueDate: input.recurrenceDueDate ?? null,
    isRecurringInstance: input.isRecurringInstance ?? false,
    completedAt: null,
    recurrenceGroupId: null,
    pendingPastRecurrences: 0,
    source: input.source ?? "manual",
    sourceExternalId: input.sourceExternalId ?? null,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp
  };
};
