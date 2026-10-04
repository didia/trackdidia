import { describe, expect, it } from "vitest";
import { baseLink, baseSettings } from "../calendar/calendar-sync-test-helpers";
import { buildCalendarSyncSignatureForTask } from "../calendar/eligibility";
import type { Task } from "../../domain/types";
import {
  buildCalendarSyncCaptureLink,
  isCalendarSyncCaptureActive,
  promoteDueScheduledTasks,
} from "./scheduled";

const today = "2026-01-12";
const now = "2026-01-12T14:00:00.000Z";

const baseTask = (overrides: Partial<Task> = {}): Task => ({
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

const promoted = (task: Task): Task | undefined =>
  promoteDueScheduledTasks([task], today, now).find((candidate) => candidate.id === task.id);

describe("promoteDueScheduledTasks", () => {
  it("promotes an active scheduled task whose local date is today", () => {
    const task = baseTask({ id: "today", scheduledFor: "2026-01-12T15:00:00" });
    const result = promoted(task);

    expect(result).toMatchObject({
      id: "today",
      bucket: "next_action",
      scheduledFor: null,
      updatedAt: now,
    });
  });

  it("promotes an overdue scheduled task whose local date is before today", () => {
    const task = baseTask({ id: "past", scheduledFor: "2026-01-05T09:00:00" });
    const result = promoted(task);

    expect(result?.bucket).toBe("next_action");
    expect(result?.scheduledFor).toBeNull();
  });

  it("leaves a future scheduled task unchanged", () => {
    const task = baseTask({ id: "future", scheduledFor: "2026-01-20T09:00:00" });

    expect(promoteDueScheduledTasks([task], today, now)).toEqual([]);
  });

  it("skips a scheduled task with no scheduledFor", () => {
    const task = baseTask({ id: "undated", scheduledFor: null });

    expect(promoteDueScheduledTasks([task], today, now)).toEqual([]);
  });

  it("ignores a planned task that reuses scheduledFor as a display date", () => {
    const task = baseTask({
      id: "planned",
      bucket: "planned",
      projectId: "project:1",
      scheduledFor: "2026-01-12T15:00:00",
    });

    expect(promoteDueScheduledTasks([task], today, now)).toEqual([]);
  });

  it("ignores completed and cancelled scheduled tasks", () => {
    const tasks = [
      baseTask({ id: "done", status: "completed", scheduledFor: "2026-01-12T09:00:00" }),
      baseTask({ id: "cancelled", status: "cancelled", scheduledFor: "2026-01-12T09:00:00" }),
    ];

    expect(promoteDueScheduledTasks(tasks, today, now)).toEqual([]);
  });

  it("promotes a due recurring scheduled instance", () => {
    const task = baseTask({
      id: "recurring-task:template",
      isRecurringInstance: true,
      recurringTemplateId: "template:1",
      recurrenceDueDate: today,
      scheduledFor: "2026-01-12T09:00:00",
    });
    const result = promoted(task);

    expect(result?.bucket).toBe("next_action");
    expect(result?.scheduledFor).toBeNull();
    expect(result?.isRecurringInstance).toBe(true);
    expect(result?.recurrenceDueDate).toBe(today);
  });

  it("does not promote the same tasks twice", () => {
    const task = baseTask({ id: "once", scheduledFor: "2026-01-11T09:00:00" });
    const first = promoteDueScheduledTasks([task], today, now);
    const second = promoteDueScheduledTasks(first, today, now);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("does not treat a deadline as a promotion trigger", () => {
    const task = baseTask({
      id: "deadline-only",
      scheduledFor: "2026-01-20T09:00:00",
      deadline: today,
    });

    expect(promoteDueScheduledTasks([task], today, now)).toEqual([]);
  });
});

describe("isCalendarSyncCaptureActive", () => {
  it("is active when enabled and state is active", () => {
    expect(isCalendarSyncCaptureActive(baseSettings({ enabled: true, state: "active" }))).toBe(
      true,
    );
  });

  it("is active when enabled and state is needs_confirmation", () => {
    expect(
      isCalendarSyncCaptureActive(baseSettings({ enabled: true, state: "needs_confirmation" })),
    ).toBe(true);
  });

  it("is inactive when disabled", () => {
    expect(isCalendarSyncCaptureActive(baseSettings({ enabled: false, state: "active" }))).toBe(
      false,
    );
  });

  it("is inactive when disconnected or reconnect_required", () => {
    expect(
      isCalendarSyncCaptureActive(baseSettings({ enabled: true, state: "disconnected" })),
    ).toBe(false);
    expect(
      isCalendarSyncCaptureActive(baseSettings({ enabled: true, state: "reconnect_required" })),
    ).toBe(false);
  });
});

describe("buildCalendarSyncCaptureLink", () => {
  const settings = baseSettings();

  it("captures a pending link with no existing link", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const link = buildCalendarSyncCaptureLink(task, null, settings, now);
    expect(link).toMatchObject({
      taskId: task.id,
      occurrenceKey: "2026-01-12",
      state: "pending",
      eventId: null,
    });
  });

  it("does nothing when a synced link already matches the captured payload", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const existing = baseLink(task, settings, { state: "synced" });
    expect(buildCalendarSyncCaptureLink(task, existing, settings, now)).toBeNull();
  });

  it("becomes pending and keeps the event_id when a synced link's payload differs", () => {
    const originalTask = baseTask({ scheduledFor: "2026-01-12T09:00:00", title: "Original" });
    const existing = baseLink(originalTask, settings, { state: "synced", eventId: "event:1" });
    const editedTask = baseTask({ scheduledFor: "2026-01-12T09:00:00", title: "Edited" });

    const link = buildCalendarSyncCaptureLink(editedTask, existing, settings, now);
    expect(link).toMatchObject({ state: "pending", eventId: "event:1" });
    const { signature } = buildCalendarSyncSignatureForTask(editedTask, settings);
    expect(link?.payloadSignature).toBe(signature);
  });

  it("returns null for a task with no scheduledFor", () => {
    const task = baseTask({ bucket: "next_action", scheduledFor: null });
    expect(buildCalendarSyncCaptureLink(task, null, settings, now)).toBeNull();
  });

  it("never resets a terminal detached link (completed) back to pending", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const existing = baseLink(task, settings, {
      state: "detached",
      detachReason: "completed",
      eventId: "event:1",
    });
    expect(buildCalendarSyncCaptureLink(task, existing, settings, now)).toBeNull();
  });

  it("never resets a terminal detached link (cancelled) back to pending", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const existing = baseLink(task, settings, {
      state: "detached",
      detachReason: "cancelled",
      eventId: "event:1",
    });
    expect(buildCalendarSyncCaptureLink(task, existing, settings, now)).toBeNull();
  });

  it("still reclaims a detached `promoted` link back to pending", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const existing = baseLink(task, settings, {
      state: "detached",
      detachReason: "promoted",
      eventId: "event:1",
    });
    const link = buildCalendarSyncCaptureLink(task, existing, settings, now);
    expect(link).toMatchObject({ state: "pending", eventId: "event:1" });
  });
});
