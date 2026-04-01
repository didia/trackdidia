import type { GtdImportSummary, Project, Task, TaskBucket, TaskContext } from "../../domain/types";
import { buildContextId, nowIso } from "./shared";

interface GoogleTask {
  id: string;
  title: string;
  status: string;
  notes?: string;
  parent?: string;
  created?: string;
  updated?: string;
  task_recurrence_id?: string;
  scheduled_time?: Array<{
    current?: boolean;
    start?: string;
  }>;
}

interface GoogleTaskList {
  id: string;
  title: string;
  items?: GoogleTask[];
}

interface GoogleTasksExport {
  items?: GoogleTaskList[];
}

interface ImportPayload {
  contexts: TaskContext[];
  projects: Project[];
  tasks: Task[];
  recurringSourceTaskIds: Record<string, string[]>;
  summary: GtdImportSummary;
}

interface TaskListMapping {
  bucket: TaskBucket;
  contextNames: string[];
}

const normalizeListTitle = (value: string): string => value.replace(/\s+\(\d+\)\s*$/, "").trim();

const getScheduledFor = (task: GoogleTask): string | null =>
  task.scheduled_time?.find((item) => item.current)?.start ?? task.scheduled_time?.[0]?.start ?? null;

const getSortTimestamp = (task: GoogleTask): string =>
  getScheduledFor(task) ?? task.updated ?? task.created ?? nowIso();

const buildContext = (name: string): TaskContext => {
  const timestamp = nowIso();
  return {
    id: buildContextId(name),
    name,
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

const mapTaskList = (title: string): TaskListMapping | null => {
  if (title === "In-Basket") {
    return { bucket: "inbox", contextNames: [] };
  }

  if (title === "Waiting for") {
    return { bucket: "waiting_for", contextNames: [] };
  }

  if (title === "Scheduled") {
    return { bucket: "scheduled", contextNames: [] };
  }

  if (title === "Next Calls") {
    return { bucket: "next_action", contextNames: ["Call"] };
  }

  if (title === "Reading") {
    return { bucket: "reference", contextNames: ["Reading"] };
  }

  if (title === "Next Articles to write") {
    return { bucket: "next_action", contextNames: ["Writing"] };
  }

  if (title === "Next Tech Articles to Read") {
    return { bucket: "reference", contextNames: ["Reading", "Tech"] };
  }

  if (title === "Next General Articles to Read") {
    return { bucket: "reference", contextNames: ["Reading", "General"] };
  }

  if (title === "LinkedIn Monday (Professional)") {
    return { bucket: "next_action", contextNames: ["Writing", "Professional"] };
  }

  if (title === "LinkedIn Weekend (Personal)") {
    return { bucket: "next_action", contextNames: ["Writing", "Personal"] };
  }

  const nextActionMatch = /^Next Actions - (.+)$/.exec(title);
  if (nextActionMatch) {
    return { bucket: "next_action", contextNames: [nextActionMatch[1].trim()] };
  }

  const somedayMatch = /^Someday\/Maybe - (.+)$/.exec(title);
  if (somedayMatch) {
    return { bucket: "someday_maybe", contextNames: [somedayMatch[1].trim()] };
  }

  return null;
};

const buildProjectFromGoogleTask = (task: GoogleTask, contextId: string): Project => ({
  id: `google-project:${task.id}`,
  title: task.title.trim(),
  status: "active",
  statusChangedAt: task.updated ?? task.created ?? nowIso(),
  notes: task.notes?.trim() ?? "",
  contextIds: [contextId],
  source: "google_import",
  sourceExternalId: task.id,
  createdAt: task.created ?? task.updated ?? nowIso(),
  updatedAt: task.updated ?? task.created ?? nowIso()
});

const buildTaskFromGoogleTask = (
  task: GoogleTask,
  mapping: TaskListMapping,
  contextIds: string[],
  recurrenceTaskIds: string[] = []
): Task => {
  const scheduledFor = getScheduledFor(task);
  const recurrenceGroupId = task.task_recurrence_id ?? null;
  return {
    id: recurrenceGroupId ? `google-recurrence:${recurrenceGroupId}` : `google-task:${task.id}`,
    title: task.title.trim(),
    notes: task.notes?.trim() ?? "",
    status: "active",
    bucket: scheduledFor ? "scheduled" : mapping.bucket,
    contextIds,
    projectId: null,
    parentTaskId: task.parent ? `google-task:${task.parent}` : null,
    scheduledFor,
    completedAt: null,
    recurrenceGroupId,
    pendingPastRecurrences: Math.max(0, recurrenceTaskIds.length - 1),
    source: "google_import",
    sourceExternalId: recurrenceGroupId ?? task.id,
    createdAt: task.created ?? task.updated ?? nowIso(),
    updatedAt: task.updated ?? task.created ?? nowIso()
  };
};

export const buildGoogleTasksImport = (rawJson: unknown): ImportPayload => {
  const payload = rawJson as GoogleTasksExport;
  const contextMap = new Map<string, TaskContext>();
  const taskMap = new Map<string, Task>();
  const projectMap = new Map<string, Project>();
  const recurringGroups = new Map<
    string,
    Array<{ task: GoogleTask; mapping: TaskListMapping; contextIds: string[] }>
  >();
  const recurringSourceTaskIds: Record<string, string[]> = {};
  let skippedCompletedTasks = 0;

  const ensureContextIds = (names: string[]): string[] =>
    names.map((name) => {
      const trimmed = name.trim();
      const id = buildContextId(trimmed);

      if (!contextMap.has(id)) {
        contextMap.set(id, buildContext(trimmed));
      }

      return id;
    });

  for (const list of payload.items ?? []) {
    const normalizedTitle = normalizeListTitle(list.title ?? "");
    const activeTasks = (list.items ?? []).filter((task) => {
      if (task.status === "needsAction") {
        return true;
      }

      skippedCompletedTasks += 1;
      return false;
    });

    const projectMatch = /^Projects - (.+)$/.exec(normalizedTitle);
    if (projectMatch) {
      const contextIds = ensureContextIds([projectMatch[1].trim()]);

      for (const task of activeTasks) {
        const project = buildProjectFromGoogleTask(task, contextIds[0]);
        projectMap.set(project.id, project);
      }

      continue;
    }

    const mapping = mapTaskList(normalizedTitle);
    if (!mapping) {
      continue;
    }

    const contextIds = ensureContextIds(mapping.contextNames);

    for (const task of activeTasks) {
      if (task.task_recurrence_id) {
        const group = recurringGroups.get(task.task_recurrence_id) ?? [];
        group.push({ task, mapping, contextIds });
        recurringGroups.set(task.task_recurrence_id, group);
        continue;
      }

      const normalizedTask = buildTaskFromGoogleTask(task, mapping, contextIds);
      taskMap.set(normalizedTask.id, normalizedTask);
    }
  }

  for (const [recurrenceId, group] of recurringGroups.entries()) {
    const sortedGroup = [...group].sort((left, right) => getSortTimestamp(right.task).localeCompare(getSortTimestamp(left.task)));
    const latest = sortedGroup[0];
    const sourceTaskIds = sortedGroup.map((item) => item.task.id);
    const normalizedTask = buildTaskFromGoogleTask(latest.task, latest.mapping, latest.contextIds, sourceTaskIds);
    taskMap.set(normalizedTask.id, normalizedTask);
    recurringSourceTaskIds[normalizedTask.id] = sourceTaskIds;
  }

  return {
    contexts: [...contextMap.values()],
    projects: [...projectMap.values()],
    tasks: [...taskMap.values()],
    recurringSourceTaskIds,
    summary: {
      importedTasks: taskMap.size,
      importedProjects: projectMap.size,
      importedContexts: contextMap.size,
      skippedCompletedTasks
    }
  };
};
