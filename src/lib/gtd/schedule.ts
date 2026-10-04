/**
 * Bucket rule for changing a task's `scheduledFor` date.
 * Shared by both repositories' `scheduleTask` and the AI GTD "schedule" accept path so the
 * three call sites cannot drift.
 */
import type { Task } from "../../domain/types";

/**
 * - An active Planned task keeps its bucket: `scheduledFor` is a planned-date display value,
 *   never a coercion to Scheduled.
 * - Otherwise a date moves the task to Scheduled.
 * - Clearing the date leaves Scheduled for Next Actions; any other bucket is unchanged.
 *
 * Pure: returns a new task, does not touch `updatedAt` or emit events (callers persist through
 * `saveTask`, which owns lifecycle events).
 */
export const applyScheduleChange = (task: Task, scheduledFor: string | null): Task => {
  if (task.status === "active" && task.bucket === "planned") {
    return { ...task, scheduledFor };
  }

  return {
    ...task,
    bucket: scheduledFor ? "scheduled" : task.bucket === "scheduled" ? "next_action" : task.bucket,
    scheduledFor,
  };
};
