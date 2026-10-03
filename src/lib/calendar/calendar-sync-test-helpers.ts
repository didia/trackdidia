/** Shared fixtures for calendar-sync tests (eligibility, planner, repository parity). */
import {
  defaultCalendarSyncSettings,
  type CalendarSyncLink,
  type CalendarSyncSettings,
} from "../../domain/calendar-sync";
import type { Task } from "../../domain/types";
import { buildCalendarSyncSignatureForTask } from "./eligibility";

export const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: overrides.id ?? "task:1",
  title: overrides.title ?? "Task",
  notes: "",
  status: overrides.status ?? "active",
  bucket: overrides.bucket ?? "scheduled",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: overrides.scheduledFor ?? "2026-01-12T15:00:00",
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  sourceUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

export const baseSettings = (
  overrides: Partial<CalendarSyncSettings> = {},
): CalendarSyncSettings => ({
  ...defaultCalendarSyncSettings("2026-01-01T00:00:00.000Z"),
  enabled: true,
  calendarId: "calendar:trackdidia",
  connectedAccountId: "account:1",
  state: "active",
  ...overrides,
});

export const baseLink = (
  task: Task,
  settings: CalendarSyncSettings,
  overrides: Partial<CalendarSyncLink> = {},
): CalendarSyncLink => {
  const { signature } = buildCalendarSyncSignatureForTask(task, settings);
  return {
    taskId: task.id,
    occurrenceKey: overrides.occurrenceKey ?? "2026-01-12",
    calendarId: overrides.calendarId ?? settings.calendarId ?? "calendar:trackdidia",
    eventId: overrides.eventId === undefined ? "event:1" : overrides.eventId,
    generation: overrides.generation ?? settings.generation,
    state: overrides.state ?? "synced",
    payloadSignature: overrides.payloadSignature ?? signature,
    eventStartAt: overrides.eventStartAt ?? (task.scheduledFor as string),
    detachReason: overrides.detachReason ?? null,
    failureCount: overrides.failureCount ?? 0,
    lastError: overrides.lastError ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
};
