/**
 * Pure planning for collapsing Google recurring-task groups to a single row each.
 * Shared by `MemoryRepository` and `TauriSqliteRepository`.
 */
import type { Task } from "../../domain/types";
import type { ImportPayload } from "./google-tasks-import";
import { cloneTask } from "./shared";

export interface GoogleRecurringCollapsePlan {
  /** Tasks to insert or replace, one per recurring group, in payload order. */
  upserts: Task[];
  /** Existing duplicate task ids to delete after the upserts are applied. */
  deleteIds: string[];
}

/**
 * For every desired recurring task, merges the existing `google_import` rows that belong to its
 * group (same id, same `recurrenceGroupId`, or a source id listed in `recurringSourceTaskIds`)
 * into one: it keeps a non-blank existing note and the existing `projectId`, and every other
 * matching row is scheduled for deletion. Matching runs against a working copy so earlier
 * groups' upserts and deletes are visible to later ones.
 */
export const planGoogleRecurringCollapse = (
  payload: Pick<ImportPayload, "tasks" | "recurringSourceTaskIds">,
  tasks: Task[],
  now: string,
): GoogleRecurringCollapsePlan => {
  const working = new Map(tasks.map((task) => [task.id, task] as const));
  const upserts = new Map<string, Task>();
  const deleteIds = new Set<string>();

  for (const desiredTask of payload.tasks.filter((task) => task.recurrenceGroupId)) {
    const sourceIds = new Set(payload.recurringSourceTaskIds[desiredTask.id] ?? []);
    const existingMatches = [...working.values()].filter(
      (task) =>
        task.source === "google_import" &&
        (task.id === desiredTask.id ||
          task.recurrenceGroupId === desiredTask.recurrenceGroupId ||
          (task.sourceExternalId ? sourceIds.has(task.sourceExternalId) : false)),
    );

    const previousPrimary =
      existingMatches.find((task) => task.id === desiredTask.id) ?? existingMatches[0] ?? null;
    const nextTask: Task = {
      ...cloneTask(desiredTask),
      notes: previousPrimary?.notes?.trim() ? previousPrimary.notes : desiredTask.notes,
      projectId: previousPrimary?.projectId ?? desiredTask.projectId,
      updatedAt: now,
    };

    working.set(nextTask.id, nextTask);
    upserts.set(nextTask.id, nextTask);
    deleteIds.delete(nextTask.id);

    for (const duplicate of existingMatches) {
      if (duplicate.id === nextTask.id) {
        continue;
      }

      working.delete(duplicate.id);
      upserts.delete(duplicate.id);
      deleteIds.add(duplicate.id);
    }
  }

  return { upserts: [...upserts.values()].map(cloneTask), deleteIds: [...deleteIds] };
};
