/**
 * Pure planning rules for moving many tasks to one bucket at once.
 * Tasks that cannot legally enter the bucket are skipped, not failed.
 */
import type { Task } from "../../domain/types";

export interface BulkBucketMovePlan {
  /** Fully updated tasks, in `ids` order, ready to be saved. */
  updates: Task[];
  skippedCount: number;
}

export const planBulkBucketMove = (
  tasks: Task[],
  ids: string[],
  bucket: Task["bucket"],
): BulkBucketMovePlan => {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const updates: Task[] = [];
  let skippedCount = 0;

  for (const id of ids) {
    const task = byId.get(id);
    if (
      !task ||
      (bucket === "scheduled" && !task.scheduledFor) ||
      (bucket === "planned" && !task.projectId)
    ) {
      skippedCount += 1;
      continue;
    }

    updates.push({
      ...task,
      bucket,
      scheduledFor: bucket === "scheduled" || bucket === "planned" ? task.scheduledFor : null,
    });
  }

  return { updates, skippedCount };
};
