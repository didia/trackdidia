import { describe, expect, it } from "vitest";
import { clampCalendarSyncDurationMinutes } from "../../domain/calendar-sync";
import { baseSettings, baseTask } from "./calendar-sync-test-helpers";
import {
  buildCalendarSyncEventPayload,
  calendarOccurrenceKeyFor,
  canonicalCalendarSyncSignature,
  isCalendarEligibleTask,
  isRecurrenceGeneratedTask,
} from "./eligibility";

describe("isCalendarEligibleTask", () => {
  it("is eligible for an active Scheduled task with a scheduledFor", () => {
    expect(isCalendarEligibleTask(baseTask({ bucket: "scheduled" }))).toBe(true);
  });

  it("is eligible for an active Planned task attached to a project", () => {
    expect(isCalendarEligibleTask(baseTask({ bucket: "planned", projectId: "project:1" }))).toBe(
      true,
    );
  });

  it("is not eligible for a Planned task without a project", () => {
    expect(isCalendarEligibleTask(baseTask({ bucket: "planned", projectId: null }))).toBe(false);
  });

  it("is not eligible for a Next Action", () => {
    expect(isCalendarEligibleTask(baseTask({ bucket: "next_action" }))).toBe(false);
  });

  it("is not eligible for Inbox, Waiting For, Someday or References", () => {
    for (const bucket of ["inbox", "waiting_for", "someday_maybe", "reference"] as const) {
      expect(isCalendarEligibleTask(baseTask({ bucket }))).toBe(false);
    }
  });

  it("is not eligible without a scheduledFor (deadline-only)", () => {
    expect(
      isCalendarEligibleTask(
        baseTask({ bucket: "scheduled", scheduledFor: null, deadline: "2026-01-20" }),
      ),
    ).toBe(false);
  });

  it("is not eligible for a completed or cancelled task", () => {
    expect(isCalendarEligibleTask(baseTask({ status: "completed" }))).toBe(false);
    expect(isCalendarEligibleTask(baseTask({ status: "cancelled" }))).toBe(false);
  });
});

describe("calendarOccurrenceKeyFor", () => {
  it("is the local YYYY-MM-DD at 23:50, not a UTC slice", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T23:50:00" });
    expect(calendarOccurrenceKeyFor(task)).toBe("2026-01-12");
  });

  it("is the local YYYY-MM-DD at 00:10", () => {
    const task = baseTask({ scheduledFor: "2026-01-13T00:10:00" });
    expect(calendarOccurrenceKeyFor(task)).toBe("2026-01-13");
  });

  it("is null when the task is not eligible", () => {
    expect(calendarOccurrenceKeyFor(baseTask({ bucket: "next_action" }))).toBeNull();
  });
});

describe("isRecurrenceGeneratedTask", () => {
  it("is true for a recurring instance", () => {
    expect(isRecurrenceGeneratedTask(baseTask({ isRecurringInstance: true }))).toBe(true);
  });

  it("is true for a task with a recurrenceGroupId", () => {
    expect(isRecurrenceGeneratedTask(baseTask({ recurrenceGroupId: "group:1" }))).toBe(true);
  });

  it("is false for a plain manual task", () => {
    expect(isRecurrenceGeneratedTask(baseTask())).toBe(false);
  });
});

describe("buildCalendarSyncEventPayload", () => {
  it("defaults to a 30 minute duration", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const payload = buildCalendarSyncEventPayload(task, baseSettings());
    expect(payload.start.dateTime).toBe("2026-01-12T09:00:00");
    expect(
      new Date(payload.end.dateTime).getTime() - new Date(payload.start.dateTime).getTime(),
    ).toBe(30 * 60_000);
  });

  it("omits notes unless includeNotes is set", () => {
    const task = baseTask({ notes: "private notes" });
    expect(
      buildCalendarSyncEventPayload(task, baseSettings({ includeNotes: false })).description,
    ).toBe("");
    expect(
      buildCalendarSyncEventPayload(task, baseSettings({ includeNotes: true })).description,
    ).toBe("private notes");
  });

  it("sets transparency from markBusy", () => {
    expect(
      buildCalendarSyncEventPayload(baseTask(), baseSettings({ markBusy: false })).transparency,
    ).toBe("transparent");
    expect(
      buildCalendarSyncEventPayload(baseTask(), baseSettings({ markBusy: true })).transparency,
    ).toBe("opaque");
  });

  it("carries the task id and occurrence key as private extended properties", () => {
    const task = baseTask({ id: "task:42", scheduledFor: "2026-01-12T09:00:00" });
    const payload = buildCalendarSyncEventPayload(task, baseSettings());
    expect(payload.extendedProperties.private).toEqual({
      trackdidiaTaskId: "task:42",
      trackdidiaOccurrence: "2026-01-12",
    });
  });
});

describe("canonicalCalendarSyncSignature", () => {
  it("changes when the title changes", () => {
    const settings = baseSettings();
    const a = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ title: "A" }), settings),
    );
    const b = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ title: "B" }), settings),
    );
    expect(a).not.toBe(b);
  });

  it("changes when the time changes", () => {
    const settings = baseSettings();
    const a = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ scheduledFor: "2026-01-12T09:00:00" }), settings),
    );
    const b = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ scheduledFor: "2026-01-12T14:00:00" }), settings),
    );
    expect(a).not.toBe(b);
  });

  it("changes when notes change and includeNotes is set", () => {
    const settings = baseSettings({ includeNotes: true });
    const a = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ notes: "a" }), settings),
    );
    const b = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ notes: "b" }), settings),
    );
    expect(a).not.toBe(b);
  });

  it("is stable across bucket changes that keep the same scheduledFor", () => {
    const settings = baseSettings();
    const scheduled = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(baseTask({ bucket: "scheduled" }), settings),
    );
    const planned = canonicalCalendarSyncSignature(
      buildCalendarSyncEventPayload(
        baseTask({ bucket: "planned", projectId: "project:1" }),
        settings,
      ),
    );
    expect(scheduled).toBe(planned);
  });
});

describe("clampCalendarSyncDurationMinutes", () => {
  it("clamps below the minimum", () => {
    expect(clampCalendarSyncDurationMinutes(0)).toBe(5);
  });

  it("clamps above the maximum", () => {
    expect(clampCalendarSyncDurationMinutes(100_000)).toBe(24 * 60);
  });

  it("falls back for non-finite input", () => {
    expect(clampCalendarSyncDurationMinutes(Number.NaN)).toBe(30);
  });

  it("keeps a valid value", () => {
    expect(clampCalendarSyncDurationMinutes(45)).toBe(45);
  });
});
