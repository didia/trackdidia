import type {
  RecurringPreviewOccurrence,
  RecurringTargetBucket,
  RecurringTaskTemplate,
  RecurringTemplateFilters,
  Task
} from "../../domain/types";
import { createEntityId, toLocalDateString } from "../gtd/shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const atLocalNoon = (date: string): Date => new Date(`${date}T12:00:00`);

const addDays = (date: string, amount: number): string => {
  const next = atLocalNoon(date);
  next.setDate(next.getDate() + amount);
  return toLocalDateString(next);
};

const addMonths = (date: string, amount: number): string => {
  const next = atLocalNoon(date);
  next.setMonth(next.getMonth() + amount, 1);
  return toLocalDateString(next);
};

const diffDays = (left: string, right: string): number =>
  Math.floor((atLocalNoon(left).getTime() - atLocalNoon(right).getTime()) / MS_PER_DAY);

const buildScheduledFor = (date: string, time: string | null): string | null => {
  if (!time) {
    return new Date(`${date}T12:00:00`).toISOString();
  }

  return new Date(`${date}T${time}:00`).toISOString();
};

const matchesTemplateSearch = (template: RecurringTaskTemplate, filters: RecurringTemplateFilters): boolean => {
  if (filters.status && template.status !== filters.status) {
    return false;
  }

  if (filters.targetBucket && template.targetBucket !== filters.targetBucket) {
    return false;
  }

  if (filters.contextId && !template.contextIds.includes(filters.contextId)) {
    return false;
  }

  if (filters.projectId && template.projectId !== filters.projectId) {
    return false;
  }

  if (filters.ruleType && template.ruleType !== filters.ruleType) {
    return false;
  }

  if (filters.search) {
    const search = filters.search.trim().toLowerCase();
    const haystack = `${template.title}\n${template.notes}`.toLowerCase();
    if (!haystack.includes(search)) {
      return false;
    }
  }

  return true;
};

export const filterRecurringTemplates = (
  templates: RecurringTaskTemplate[],
  filters: RecurringTemplateFilters = {}
): RecurringTaskTemplate[] =>
  templates
    .filter((template) => matchesTemplateSearch(template, filters))
    .sort((left, right) => left.title.localeCompare(right.title));

export const cloneRecurringTemplate = (template: RecurringTaskTemplate): RecurringTaskTemplate => ({
  ...template,
  contextIds: [...template.contextIds],
  weeklyDays: [...template.weeklyDays]
});

export const createRecurringTemplate = (
  template: Partial<RecurringTaskTemplate> & Pick<RecurringTaskTemplate, "title" | "startDate">
): RecurringTaskTemplate => {
  const timestamp = new Date().toISOString();

  return {
    id: template.id ?? createEntityId("recurring-template"),
    title: template.title.trim(),
    notes: template.notes?.trim() ?? "",
    targetBucket: template.targetBucket ?? "next_action",
    contextIds: [...(template.contextIds ?? [])],
    projectId: template.projectId ?? null,
    ruleType: template.ruleType ?? "weekly",
    dailyInterval: Math.max(1, template.dailyInterval ?? 1),
    weeklyInterval: Math.max(1, template.weeklyInterval ?? 1),
    weeklyDays: [...(template.weeklyDays ?? [atLocalNoon(template.startDate).getDay()])],
    monthlyMode: template.monthlyMode ?? "day_of_month",
    dayOfMonth: template.dayOfMonth ?? atLocalNoon(template.startDate).getDate(),
    nthWeek: template.nthWeek ?? 1,
    weekday: template.weekday ?? atLocalNoon(template.startDate).getDay(),
    scheduledTime: template.scheduledTime ?? null,
    startDate: template.startDate,
    status: template.status ?? "active",
    lastGeneratedForDate: template.lastGeneratedForDate ?? null,
    pendingMissedOccurrences: Math.max(0, template.pendingMissedOccurrences ?? 0),
    statusChangedAt: template.statusChangedAt ?? timestamp,
    createdAt: template.createdAt ?? timestamp,
    updatedAt: template.updatedAt ?? timestamp
  };
};

const monthDueDate = (template: RecurringTaskTemplate, date: string): string | null => {
  const base = atLocalNoon(date);
  const year = base.getFullYear();
  const monthIndex = base.getMonth();

  if (template.monthlyMode === "day_of_month") {
    const day = template.dayOfMonth ?? atLocalNoon(template.startDate).getDate();
    const candidate = new Date(year, monthIndex, day, 12, 0, 0, 0);
    if (candidate.getMonth() !== monthIndex) {
      return null;
    }
    return toLocalDateString(candidate);
  }

  const weekday = template.weekday ?? 0;
  const nthWeek = template.nthWeek ?? 1;
  const firstOfMonth = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const delta = (weekday - firstOfMonth.getDay() + 7) % 7;
  const day = 1 + delta + (nthWeek - 1) * 7;
  const candidate = new Date(year, monthIndex, day, 12, 0, 0, 0);
  if (candidate.getMonth() !== monthIndex) {
    return null;
  }
  return toLocalDateString(candidate);
};

const occursOnDate = (template: RecurringTaskTemplate, date: string): boolean => {
  if (date < template.startDate) {
    return false;
  }

  if (template.ruleType === "daily") {
    return diffDays(date, template.startDate) % Math.max(1, template.dailyInterval) === 0;
  }

  if (template.ruleType === "weekly") {
    const current = atLocalNoon(date);
    const start = atLocalNoon(template.startDate);
    const weekDelta = Math.floor(diffDays(date, template.startDate) / 7);
    return template.weeklyDays.includes(current.getDay()) && weekDelta >= 0 && weekDelta % Math.max(1, template.weeklyInterval) === 0 && current >= start;
  }

  const candidate = monthDueDate(template, date);
  if (!candidate || candidate !== date) {
    return false;
  }

  const start = atLocalNoon(template.startDate);
  const current = atLocalNoon(date);
  const monthDelta =
    (current.getFullYear() - start.getFullYear()) * 12 + (current.getMonth() - start.getMonth());
  return monthDelta >= 0;
};

export const listDueDatesBetween = (
  template: RecurringTaskTemplate,
  rangeStart: string,
  rangeEnd: string
): string[] => {
  const dueDates: string[] = [];
  let cursor = rangeStart;

  while (cursor <= rangeEnd) {
    if (occursOnDate(template, cursor)) {
      dueDates.push(cursor);
    }
    cursor = addDays(cursor, 1);
  }

  return dueDates;
};

export const findNextRecurringDate = (
  template: RecurringTaskTemplate,
  fromDate: string,
  maxDaysToInspect = 366
): string | null => {
  let cursor = fromDate < template.startDate ? template.startDate : fromDate;

  for (let index = 0; index < maxDaysToInspect; index += 1) {
    if (occursOnDate(template, cursor)) {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }

  return null;
};

export const buildRecurringPreviewOccurrences = (
  templates: RecurringTaskTemplate[],
  tasks: Task[],
  rangeStart: string,
  rangeEnd: string
): RecurringPreviewOccurrence[] => {
  const activeTasksByTemplate = new Map(
    tasks
      .filter((task) => task.status === "active" && task.recurringTemplateId)
      .map((task) => [task.recurringTemplateId as string, task] as const)
  );
  const previews: RecurringPreviewOccurrence[] = [];

  for (const template of templates) {
    if (template.status !== "active") {
      continue;
    }

    const dueDates = listDueDatesBetween(template, rangeStart, rangeEnd);
    for (const dueDate of dueDates) {
      const activeTask = activeTasksByTemplate.get(template.id);
      if (activeTask?.recurrenceDueDate === dueDate) {
        continue;
      }

      const scheduledFor = buildScheduledFor(dueDate, template.targetBucket === "scheduled" ? template.scheduledTime : null);
      previews.push({
        id: `preview:${template.id}:${dueDate}`,
        templateId: template.id,
        title: template.title,
        notes: template.notes,
        targetBucket: template.targetBucket,
        contextIds: [...template.contextIds],
        projectId: template.projectId,
        dueDate,
        scheduledFor,
        scheduledTime: template.scheduledTime,
        status: activeTask && dueDate < toLocalDateString(new Date()) ? "overdue_preview" : "future"
      });
    }
  }

  return previews.sort((left, right) => {
    const leftKey = left.scheduledFor ?? `${left.dueDate}T12:00:00`;
    const rightKey = right.scheduledFor ?? `${right.dueDate}T12:00:00`;
    return leftKey.localeCompare(rightKey) || left.title.localeCompare(right.title);
  });
};

export const buildTaskFromRecurringTemplate = (
  template: RecurringTaskTemplate,
  dueDate: string,
  pendingPastRecurrences: number
): Task => ({
  id: `recurring-task:${template.id}`,
  title: template.title,
  notes: template.notes,
  status: "active",
  bucket: template.targetBucket,
  contextIds: [...template.contextIds],
  projectId: template.projectId,
  parentTaskId: null,
  scheduledFor: template.targetBucket === "scheduled" ? buildScheduledFor(dueDate, template.scheduledTime) : null,
  deadline: null,
  recurringTemplateId: template.id,
  recurrenceDueDate: dueDate,
  isRecurringInstance: true,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences,
  source: "manual",
  sourceExternalId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

export const syncTemplateStatusChange = (
  template: RecurringTaskTemplate,
  nextStatus: RecurringTaskTemplate["status"]
): RecurringTaskTemplate => {
  const timestamp = new Date().toISOString();
  return {
    ...cloneRecurringTemplate(template),
    status: nextStatus,
    statusChangedAt: template.status === nextStatus ? template.statusChangedAt : timestamp,
    updatedAt: timestamp
  };
};

export const applySeriesChangesToTemplate = (
  template: RecurringTaskTemplate,
  changes: {
    title?: string;
    notes?: string;
    bucket?: RecurringTargetBucket;
    contextIds?: string[];
    projectId?: string | null;
    scheduledFor?: string | null;
  }
): RecurringTaskTemplate => {
  const timestamp = new Date().toISOString();
  const nextTargetBucket = changes.bucket ?? template.targetBucket;
  let scheduledTime = template.scheduledTime;

  if (nextTargetBucket === "next_action") {
    scheduledTime = null;
  } else if (changes.scheduledFor) {
    const local = new Date(changes.scheduledFor);
    scheduledTime = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  }

  return {
    ...cloneRecurringTemplate(template),
    title: changes.title?.trim() ?? template.title,
    notes: changes.notes?.trim() ?? template.notes,
    targetBucket: nextTargetBucket,
    contextIds: changes.contextIds ? [...changes.contextIds] : [...template.contextIds],
    projectId: changes.projectId === undefined ? template.projectId : changes.projectId,
    scheduledTime,
    updatedAt: timestamp
  };
};

export const findProcessingRangeStart = (template: RecurringTaskTemplate, activeTask: Task | null): string => {
  const candidates = [template.startDate];

  if (template.lastGeneratedForDate) {
    candidates.push(addDays(template.lastGeneratedForDate, 1));
  }

  if (activeTask?.recurrenceDueDate) {
    candidates.push(addDays(activeTask.recurrenceDueDate, 1));
  }

  return candidates.sort()[0] ?? template.startDate;
};
