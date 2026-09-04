import type { PomodoroSessionDetails, Task } from "../types";
import { computeWindowMovement } from "./movement";

const sinceIso = "2026-02-01T08:00:00.000Z";
const nowIso = "2026-02-01T12:00:00.000Z";

const buildSession = (overrides: Partial<PomodoroSessionDetails>): PomodoroSessionDetails => ({
  id: overrides.id ?? "session:default",
  kind: "focus",
  status: "completed",
  startedAt: sinceIso,
  endsAt: nowIso,
  pausedRemainingMs: null,
  completedAt: nowIso,
  cancelledAt: null,
  cycleIndex: 0,
  date: "2026-02-01",
  segments: [],
  activeTaskId: null,
  activeLabel: null,
  taskIds: [],
  ...overrides,
});

const buildTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "task:default",
  title: "Task",
  notes: "",
  status: "active",
  bucket: "next_action",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  source: "manual",
  sourceExternalId: null,
  createdAt: sinceIso,
  updatedAt: sinceIso,
  ...overrides,
});

describe("movement insight module", () => {
  it("classifies a window as moved when a focus session completed inside it", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [buildSession({ completedAt: "2026-02-01T10:00:00.000Z" })],
      tasks: [],
      appOpenIntervals: [],
    });

    expect(movement.completedFocusSessionCount).toBe(1);
    expect(movement.completedTaskCount).toBe(0);
    expect(movement.moved).toBe(true);
  });

  it("classifies a window as moved when a task completed inside it", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [],
      tasks: [buildTask({ status: "completed", completedAt: "2026-02-01T09:00:00.000Z" })],
      appOpenIntervals: [],
    });

    expect(movement.completedTaskCount).toBe(1);
    expect(movement.moved).toBe(true);
  });

  it("classifies a window with no movement", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [buildSession({ status: "cancelled", completedAt: null })],
      tasks: [buildTask({ status: "active" })],
      appOpenIntervals: [],
    });

    expect(movement.moved).toBe(false);
  });

  it("ignores completions outside the window", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [buildSession({ completedAt: "2026-02-01T07:00:00.000Z" })],
      tasks: [buildTask({ status: "completed", completedAt: "2026-02-01T13:00:00.000Z" })],
      appOpenIntervals: [],
    });

    expect(movement.moved).toBe(false);
  });

  it("ignores non-focus session kinds", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [
        buildSession({ kind: "short_break", completedAt: "2026-02-01T10:00:00.000Z" }),
      ],
      tasks: [],
      appOpenIntervals: [],
    });

    expect(movement.completedFocusSessionCount).toBe(0);
  });

  it("merges overlapping app-open intervals and clamps them to the window", () => {
    const movement = computeWindowMovement({
      sinceIso,
      nowIso,
      focusSessions: [],
      tasks: [],
      appOpenIntervals: [
        { startedAt: "2026-02-01T07:30:00.000Z", endedAt: "2026-02-01T09:00:00.000Z" },
        { startedAt: "2026-02-01T08:30:00.000Z", endedAt: "2026-02-01T10:00:00.000Z" },
        { startedAt: "2026-02-01T11:00:00.000Z", endedAt: "2026-02-01T13:00:00.000Z" },
      ],
    });

    // Merged, clamped overlap: [08:00-10:00] (2h) + [11:00-12:00] (1h) = 3h out of a 4h window.
    expect(movement.windowMs).toBe(4 * 60 * 60 * 1000);
    expect(movement.appOpenMs).toBe(3 * 60 * 60 * 1000);
    expect(movement.appOpenRatio).toBeCloseTo(0.75);
  });
});
