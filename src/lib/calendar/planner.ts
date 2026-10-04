/**
 * Pure desired-state reconciliation planner for one-way TrackDidia -> Google Calendar
 * sync. Diffs current tasks against current `calendar_sync_links` rows; it never touches
 * storage or the network. See "Transition matrix", "Promotion capture", "Reclaimable
 * links" and "Safety valves" in `specs/done/calendar-sync.md`.
 */
import {
  CALENDAR_SYNC_PENDING_STALENESS_DAYS,
  type CalendarSyncCreateAction,
  type CalendarSyncDeleteAction,
  type CalendarSyncDetachAction,
  type CalendarSyncDetachReason,
  type CalendarSyncEventPayload,
  type CalendarSyncLink,
  type CalendarSyncPlan,
  type CalendarSyncPurgeAction,
  type CalendarSyncSettings,
  type CalendarSyncUpdateAction,
} from "../../domain/calendar-sync";
import type { Task } from "../../domain/types";
import {
  buildCalendarSyncSignatureForTask,
  calendarOccurrenceKeyFor,
  isRecurrenceGeneratedTask,
} from "./eligibility";

export interface PlanCalendarSyncInput {
  tasks: Task[];
  links: CalendarSyncLink[];
  today: string;
  now: string;
  settings: CalendarSyncSettings;
  /**
   * Single-use override carried by `confirmMassDelete(n)`. The plan executes only when
   * the recomputed delete count is `<= confirmedMassDelete`.
   */
  confirmedMassDelete?: number;
}

const linkKey = (taskId: string, occurrenceKey: string): string =>
  `${taskId}\u0000${occurrenceKey}`;

const daysBetweenLocalDates = (earlier: string, later: string): number => {
  const earlierMs = new Date(`${earlier}T12:00:00`).getTime();
  const laterMs = new Date(`${later}T12:00:00`).getTime();
  return Math.round((laterMs - earlierMs) / (24 * 60 * 60 * 1000));
};

const detachReasonForMissingTask = (task: Task | null): CalendarSyncDetachReason => {
  if (!task) {
    return "task_deleted";
  }
  if (task.status === "completed") {
    return "completed";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  return "unscheduled";
};

const emptyActions = (): Omit<CalendarSyncPlan, "abort"> => ({
  creates: [],
  updates: [],
  deletes: [],
  detaches: [],
  purges: [],
});

export function planCalendarSync(input: PlanCalendarSyncInput): CalendarSyncPlan {
  const { tasks, links, today, settings, confirmedMassDelete } = input;

  if (tasks.length === 0 && links.length > 0) {
    return {
      ...emptyActions(),
      abort: { reason: "empty_task_set", lastError: "calendar_sync_empty_task_set" },
    };
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
  // Foreign-generation links are purged in pass 1 and must not shadow a fresh link under
  // the current generation at the same key.
  const linksByKey = new Map(
    links
      .filter((link) => link.generation === settings.generation)
      .map((link) => [linkKey(link.taskId, link.occurrenceKey), link] as const),
  );

  const creates: CalendarSyncCreateAction[] = [];
  const updates: CalendarSyncUpdateAction[] = [];
  const deletes: CalendarSyncDeleteAction[] = [];
  const detaches: CalendarSyncDetachAction[] = [];
  const purges: CalendarSyncPurgeAction[] = [];
  const consumedLinkKeys = new Set<string>();

  const materializePending = (link: CalendarSyncLink): void => {
    if (daysBetweenLocalDates(link.occurrenceKey, today) > CALENDAR_SYNC_PENDING_STALENESS_DAYS) {
      purges.push({ taskId: link.taskId, occurrenceKey: link.occurrenceKey });
      return;
    }
    creates.push({
      taskId: link.taskId,
      occurrenceKey: link.occurrenceKey,
      calendarId: link.calendarId,
      payload: JSON.parse(link.payloadSignature) as CalendarSyncEventPayload,
      payloadSignature: link.payloadSignature,
      fromPendingSnapshot: true,
    });
  };

  // Pass 1: every existing link whose occurrence key no longer matches the task's
  // current eligible key (or whose generation is foreign).
  for (const link of links) {
    const key = linkKey(link.taskId, link.occurrenceKey);

    if (link.generation !== settings.generation) {
      // Dropped outright; `linksByKey` already excludes it, so pass 2 treats this key as
      // having no link and can create a fresh one under the current generation.
      purges.push({ taskId: link.taskId, occurrenceKey: link.occurrenceKey });
      continue;
    }

    const task = tasksById.get(link.taskId) ?? null;
    const eligibleKey = task ? calendarOccurrenceKeyFor(task) : null;
    const recurring = task ? isRecurrenceGeneratedTask(task) : false;

    if (eligibleKey === link.occurrenceKey) {
      // Same occurrence key: handled in pass 2 below.
      continue;
    }

    if (link.state === "detached") {
      if (link.detachReason === "promoted" && eligibleKey !== null && !recurring) {
        // Rescheduling a promoted task: promotion is a placeholder, not a record.
        deletes.push({
          taskId: link.taskId,
          occurrenceKey: link.occurrenceKey,
          calendarId: link.calendarId,
          eventId: link.eventId,
          reason: "rescheduled_after_promotion",
        });
        consumedLinkKeys.add(key);
      }
      // Otherwise terminal: never updated, recreated or re-adopted.
      continue;
    }

    if (link.state === "pending") {
      if (!recurring && eligibleKey !== null) {
        // Suppressed pending create: the user re-dated before the reconciler ran.
        purges.push({ taskId: link.taskId, occurrenceKey: link.occurrenceKey });
        consumedLinkKeys.add(key);
        continue;
      }
      // Recurrence-generated, or no longer desired anywhere: still a virtual occurrence.
      materializePending(link);
      consumedLinkKeys.add(key);
      continue;
    }

    // synced or failed
    if (eligibleKey !== null) {
      // Reschedule refinement: delete the old event regardless of its date; the
      // replacement is created below in pass 2.
      deletes.push({
        taskId: link.taskId,
        occurrenceKey: link.occurrenceKey,
        calendarId: link.calendarId,
        eventId: link.eventId,
        reason: "reschedule",
      });
      consumedLinkKeys.add(key);
      continue;
    }

    // Exit rule: the task no longer wants this occurrence at all.
    const reason = detachReasonForMissingTask(task);
    if (link.occurrenceKey > today) {
      deletes.push({
        taskId: link.taskId,
        occurrenceKey: link.occurrenceKey,
        calendarId: link.calendarId,
        eventId: link.eventId,
        reason: "exit",
      });
    } else {
      detaches.push({ taskId: link.taskId, occurrenceKey: link.occurrenceKey, reason });
    }
    consumedLinkKeys.add(key);
  }

  // Pass 2: every task currently eligible, matched against any link at its current key.
  for (const task of tasks) {
    const eligibleKey = calendarOccurrenceKeyFor(task);
    if (eligibleKey === null) {
      continue;
    }

    const key = linkKey(task.id, eligibleKey);
    if (consumedLinkKeys.has(key)) {
      continue;
    }

    const existing = linksByKey.get(key) ?? null;
    const { payload, signature } = buildCalendarSyncSignatureForTask(task, settings);

    if (!existing) {
      creates.push({
        taskId: task.id,
        occurrenceKey: eligibleKey,
        calendarId: settings.calendarId ?? "",
        payload,
        payloadSignature: signature,
        fromPendingSnapshot: false,
      });
      continue;
    }

    if (existing.state === "detached") {
      if (existing.detachReason !== "promoted") {
        // Terminal for its occurrence key: never updated, recreated or re-adopted.
        continue;
      }
      // Reclaimable: the live payload supersedes the stored snapshot.
      if (existing.eventId === null) {
        creates.push({
          taskId: task.id,
          occurrenceKey: eligibleKey,
          calendarId: existing.calendarId,
          payload,
          payloadSignature: signature,
          fromPendingSnapshot: false,
        });
      } else if (existing.payloadSignature !== signature) {
        updates.push({
          taskId: task.id,
          occurrenceKey: eligibleKey,
          calendarId: existing.calendarId,
          eventId: existing.eventId,
          payload,
          payloadSignature: signature,
        });
      }
      continue;
    }

    if (existing.eventId === null) {
      // pending (always), or synced/failed that never got an event: create/retry.
      creates.push({
        taskId: task.id,
        occurrenceKey: eligibleKey,
        calendarId: existing.calendarId,
        payload,
        payloadSignature: signature,
        fromPendingSnapshot: false,
      });
    } else if (existing.payloadSignature !== signature) {
      updates.push({
        taskId: task.id,
        occurrenceKey: eligibleKey,
        calendarId: existing.calendarId,
        eventId: existing.eventId,
        payload,
        payloadSignature: signature,
      });
    }
  }

  const activeLinkCount = links.filter((link) => link.state !== "detached").length;
  const deleteThreshold = Math.max(10, Math.ceil(0.25 * activeLinkCount));

  if (deletes.length > deleteThreshold) {
    if (confirmedMassDelete !== undefined && deletes.length <= confirmedMassDelete) {
      return { creates, updates, deletes, detaches, purges };
    }
    return {
      ...emptyActions(),
      abort: {
        reason: "needs_confirmation",
        lastError: `calendar_sync_mass_delete:${deletes.length}`,
        deleteCount: deletes.length,
      },
    };
  }

  return { creates, updates, deletes, detaches, purges };
}
