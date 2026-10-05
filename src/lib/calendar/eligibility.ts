/**
 * Calendar-sync eligibility, identity and payload helpers. Pure functions only; see
 * "Eligibility", "Identity" and "Event payload" in `specs/done/calendar-sync.md`.
 */
import type { CalendarSyncEventPayload, CalendarSyncSettings } from "../../domain/calendar-sync";
import { clampCalendarSyncDurationMinutes } from "../../domain/calendar-sync";
import type { Task } from "../../domain/types";
import { toLocalDateString } from "../gtd/shared";

/**
 * A `(task, occurrence_key)` is calendar-eligible iff the task is active, has a
 * `scheduledFor`, and is a Scheduled task or a Planned task attached to a project.
 * Deadlines, recurrence previews (not task rows), Next Actions, Inbox, Waiting For,
 * Someday and References are excluded.
 */
export const isCalendarEligibleTask = (task: Task): boolean =>
  task.status === "active" &&
  task.scheduledFor !== null &&
  (task.bucket === "scheduled" || (task.bucket === "planned" && task.projectId !== null));

/**
 * The local `YYYY-MM-DD` of `scheduledFor`, used as the stable half of the
 * `(task_id, occurrence_key)` identity. `null` when the task is not currently eligible.
 */
export const calendarOccurrenceKeyFor = (task: Task): string | null =>
  isCalendarEligibleTask(task) ? toLocalDateString(task.scheduledFor as string) : null;

/** Ids minted by recurrence generation reuse one task id across occurrences. */
export const isRecurrenceGeneratedTask = (task: Task): boolean =>
  task.isRecurringInstance === true || task.recurrenceGroupId !== null;

/** Canonical JSON, stable key order, compared with `===` and stored as the link snapshot. */
export const canonicalCalendarSyncSignature = (payload: CalendarSyncEventPayload): string =>
  JSON.stringify({
    summary: payload.summary,
    description: payload.description,
    start: { dateTime: payload.start.dateTime },
    end: { dateTime: payload.end.dateTime },
    transparency: payload.transparency,
    reminders: { useDefault: payload.reminders.useDefault, overrides: payload.reminders.overrides },
    extendedProperties: {
      private: {
        trackdidiaTaskId: payload.extendedProperties.private.trackdidiaTaskId,
        trackdidiaOccurrence: payload.extendedProperties.private.trackdidiaOccurrence,
      },
    },
  });

/**
 * Builds the canonical event body for an eligible task. `scheduledFor` always carries a
 * time, so the event is always timed; the bucket is deliberately not part of the payload.
 */
export const buildCalendarSyncEventPayload = (
  task: Task,
  settings: Pick<
    CalendarSyncSettings,
    "defaultDurationMinutes" | "includeNotes" | "markBusy" | "remindersEnabled"
  >,
): CalendarSyncEventPayload => {
  const start = task.scheduledFor as string;
  const durationMinutes = clampCalendarSyncDurationMinutes(settings.defaultDurationMinutes);
  const end = new Date(new Date(start).getTime() + durationMinutes * 60_000).toISOString();

  return {
    summary: task.title.trim(),
    description: settings.includeNotes ? task.notes : "",
    start: { dateTime: start },
    end: { dateTime: end },
    transparency: settings.markBusy ? "opaque" : "transparent",
    reminders: settings.remindersEnabled
      ? { useDefault: true, overrides: [] }
      : { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        trackdidiaTaskId: task.id,
        trackdidiaOccurrence: toLocalDateString(start),
      },
    },
  };
};

export const buildCalendarSyncSignatureForTask = (
  task: Task,
  settings: Pick<
    CalendarSyncSettings,
    "defaultDurationMinutes" | "includeNotes" | "markBusy" | "remindersEnabled"
  >,
): { payload: CalendarSyncEventPayload; signature: string } => {
  const payload = buildCalendarSyncEventPayload(task, settings);
  return { payload, signature: canonicalCalendarSyncSignature(payload) };
};
