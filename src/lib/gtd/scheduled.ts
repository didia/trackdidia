/**
 * Date-driven promotion of due Scheduled tasks into Next Actions.
 * Shared by `MemoryRepository` and `TauriSqliteRepository` so both storage
 * implementations enforce identical invariants.
 */
import type { CalendarSyncLink, CalendarSyncSettings } from "../../domain/calendar-sync";
import type { Task } from "../../domain/types";
import {
  buildCalendarSyncSignatureForTask,
  calendarOccurrenceKeyFor,
} from "../calendar/eligibility";
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

/**
 * Promotion capture (see "Promotion capture" in `specs/todo/calendar-sync.md`): the
 * instant before `scheduledFor` is cleared is the only place that instant still exists.
 * `task` is the task as it is about to be promoted (its original `scheduledFor`, before
 * promotion mutates it). Returns the upsert both repositories must persist in the same
 * atomic step as the promotion, or `null` when nothing needs to change.
 *
 * - No existing link, or an existing link whose stored/last-synced payload differs ->
 *   upsert a `pending` link with the freshly captured snapshot. An existing `event_id` is
 *   kept so the planner issues an update from the snapshot before detaching.
 * - A `synced` link whose `payloadSignature` already matches the captured payload -> no
 *   write (the event already represents the day and stays as the record of it).
 */
export const buildCalendarSyncCaptureLink = (
  task: Task,
  existingLink: CalendarSyncLink | null,
  settings: CalendarSyncSettings,
  now: string,
): CalendarSyncLink | null => {
  const occurrenceKey = calendarOccurrenceKeyFor(task);
  if (occurrenceKey === null) {
    return null;
  }

  const { signature } = buildCalendarSyncSignatureForTask(task, settings);

  if (existingLink?.state === "synced" && existingLink.payloadSignature === signature) {
    return null;
  }

  return {
    taskId: task.id,
    occurrenceKey,
    calendarId: existingLink?.calendarId ?? settings.calendarId ?? "",
    eventId: existingLink?.eventId ?? null,
    generation: existingLink?.generation ?? settings.generation,
    state: "pending",
    payloadSignature: signature,
    eventStartAt: task.scheduledFor as string,
    detachReason: null,
    failureCount: existingLink?.failureCount ?? 0,
    lastError: existingLink?.lastError ?? null,
    createdAt: existingLink?.createdAt ?? now,
    updatedAt: now,
  };
};

/** `enabled` and connected per "Promotion capture": `active` or `needs_confirmation`. */
export const isCalendarSyncCaptureActive = (settings: CalendarSyncSettings): boolean =>
  settings.enabled && (settings.state === "active" || settings.state === "needs_confirmation");
