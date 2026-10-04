import type { Project, Task, TaskContext } from "../../domain/types";
import { toLocalDateString } from "../date";

export {
  addDays,
  getDayRange,
  getWeekStartSunday,
  isSunday,
  isWednesday,
  toLocalDateString,
} from "../date";

export const createEntityId = (prefix: string): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}:${crypto.randomUUID()}`;
  }

  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`;
};

export const nowIso = (): string => new Date().toISOString();

export const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");

export const buildContextId = (name: string): string => `context:${slugify(name)}`;

export const isSameLocalDate = (value: string | null | undefined, date: string): boolean => {
  if (!value) {
    return false;
  }

  return toLocalDateString(value) === date;
};

export const isTaskScheduledForDate = (task: Task, date: string): boolean =>
  task.bucket === "scheduled" && isSameLocalDate(task.scheduledFor, date);

export const isTaskActionableForDate = (task: Task, date: string): boolean =>
  task.bucket === "next_action" || isTaskScheduledForDate(task, date);

export const cloneTask = (task: Task): Task => ({
  ...task,
  contextIds: [...task.contextIds],
});

export const cloneProject = (project: Project): Project => ({
  ...project,
  contextIds: [...project.contextIds],
});

export const cloneContext = (context: TaskContext): TaskContext => ({ ...context });
