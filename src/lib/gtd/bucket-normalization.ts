/**
 * Selection rule for one-time startup bucket normalizations (Reading -> References,
 * dated work -> Scheduled). Shared by both repositories.
 *
 * These passes deliberately bypass `buildLifecycleEvents`: they are compatibility rewrites of
 * historical data, so they must not emit `task_moved_to_next_action` / `task_scheduled_for_day`
 * events that would retroactively change daily metrics. They only touch `bucket` and
 * `updatedAt`; `scheduledFor` and `plannedOrder` are left as stored.
 */
import type { Task } from "../../domain/types";
import { cloneTask } from "./shared";

export const hasContext =
  (contextId: string) =>
  (task: Task): boolean =>
    task.contextIds.includes(contextId);

export const hasScheduledDate = (task: Task): boolean => Boolean(task.scheduledFor);

/**
 * Returns the active tasks that match `predicate` and are not already in `bucket`, already
 * rewritten into `bucket` with `updatedAt = now`. Callers persist the result and report its length.
 */
export const selectTasksForBucketNormalization = (
  tasks: Iterable<Task>,
  predicate: (task: Task) => boolean,
  bucket: Task["bucket"],
  now: string,
): Task[] => {
  const updates: Task[] = [];

  for (const task of tasks) {
    if (task.status !== "active" || task.bucket === bucket || !predicate(task)) {
      continue;
    }

    updates.push({ ...cloneTask(task), bucket, updatedAt: now });
  }

  return updates;
};
