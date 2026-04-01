import type { Project, Task, TaskContext } from "../../domain/types";

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

export const getDayRange = (date: string): { startMs: number; endMs: number } => {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
};

export const toLocalDateString = (value: string | Date): string => {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const addDays = (date: string, amount: number): string => {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + amount);
  return toLocalDateString(next);
};

export const isSunday = (date: string): boolean => new Date(`${date}T12:00:00`).getDay() === 0;

export const getWeekStartSunday = (date: string): string => {
  const current = new Date(`${date}T12:00:00`);
  const delta = current.getDay();
  current.setDate(current.getDate() - delta);
  return toLocalDateString(current);
};

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
  contextIds: [...task.contextIds]
});

export const cloneProject = (project: Project): Project => ({
  ...project,
  contextIds: [...project.contextIds]
});

export const cloneContext = (context: TaskContext): TaskContext => ({ ...context });
