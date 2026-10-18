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

/**
 * Mints a row id. There is deliberately no weaker fallback: with two independent writers a
 * `Math.random()` id is a real collision (and therefore data-loss) path, so a missing
 * `crypto.randomUUID` is a hard error.
 */
export const createEntityId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is unavailable; refusing to mint a non-unique entity id.");
  }

  return `${prefix}:${globalThis.crypto.randomUUID()}`;
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
