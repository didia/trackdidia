/**
 * Date-driven promotion of due Scheduled tasks into Next Actions.
 * Shared by `MemoryRepository` and `TauriSqliteRepository` so both storage
 * implementations enforce identical invariants.
 */
import type { Task } from "../../domain/types";
import { cloneTask, toLocalDateString } from "./shared";

const isDueScheduledTask = (task: Task, today: string): boolean =>
  task.status === "active" &&
  task.bucket === "scheduled" &&
  task.scheduledFor !== null &&
  toLocalDateString(task.scheduledFor) <= today;

/**
 * Returns the tasks that must be persisted as Next Actions because their local
 * `scheduledFor` calendar date is today or earlier. Pure: callers apply and persist.
 */
export const promoteDueScheduledTasks = (tasks: Task[], today: string, now: string): Task[] =>
  tasks
    .filter((task) => isDueScheduledTask(task, today))
    .map((task) => ({
      ...cloneTask(task),
      bucket: "next_action",
      scheduledFor: null,
      updatedAt: now,
    }));
