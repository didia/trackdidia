import type { Task } from "../../domain/types";
import {
  buildPomodoroSessionDetails,
  buildPomodoroState,
  buildPomodoroTaskSummaries,
  computeDailyPomodoroStats,
  createPomodoroSegment,
  createPomodoroSession,
  getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset,
  getPomodoroTiming,
} from "./engine";

describe("pomodoro engine", () => {
  it("calculates running and paused timing at the focus completion boundary", () => {
    const running = createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 1);
    const halfway = new Date("2026-04-01T09:12:30.000Z").getTime();

    expect(getPomodoroTiming(running, halfway)).toEqual({
      remainingMs: 12 * 60 * 1000 + 30 * 1000,
      canCompleteNow: true,
      valid: true,
    });
    expect(
      getPomodoroTiming(
        { ...running, status: "paused", pausedRemainingMs: 30 * 60 * 1000 },
        halfway + 999_999,
      ),
    ).toEqual({
      remainingMs: 25 * 60 * 1000,
      canCompleteNow: false,
      valid: true,
    });
  });

  it("rejects corrupt timing data and never permits break completion", () => {
    const breakSession = createPomodoroSession("short_break", "2026-04-01T09:00:00.000Z", 1);

    expect(getPomodoroTiming({ ...breakSession, endsAt: "not-a-date" }, Date.now())).toEqual({
      remainingMs: 0,
      canCompleteNow: false,
      valid: false,
    });
    expect(
      getPomodoroTiming({ ...breakSession, status: "paused", pausedRemainingMs: -1 }, Date.now()),
    ).toEqual({
      remainingMs: 0,
      canCompleteNow: false,
      valid: false,
    });
    expect(getPomodoroTiming(breakSession, new Date(breakSession.endsAt).getTime())).toEqual({
      remainingMs: 0,
      canCompleteNow: false,
      valid: true,
    });
  });

  it("keeps a running session with a malformed deadline active for recovery", () => {
    const corruptRunning = {
      ...createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 1),
      endsAt: "not-a-date",
    };

    const state = buildPomodoroState([corruptRunning], [], "2026-04-01T10:00:00.000Z");

    expect(state.activeSession).toMatchObject({
      id: corruptRunning.id,
      status: "running",
      endsAt: "not-a-date",
    });
  });

  it("chains focus sessions toward a long break after the fourth focus", () => {
    const sessions = [
      {
        ...createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 1),
        status: "completed" as const,
        completedAt: "2026-04-01T09:25:00.000Z",
        endsAt: "2026-04-01T09:25:00.000Z",
      },
      {
        ...createPomodoroSession("short_break", "2026-04-01T09:25:00.000Z", 1),
        status: "completed" as const,
        completedAt: "2026-04-01T09:30:00.000Z",
        endsAt: "2026-04-01T09:30:00.000Z",
      },
      {
        ...createPomodoroSession("focus", "2026-04-01T09:30:00.000Z", 2),
        status: "completed" as const,
        completedAt: "2026-04-01T09:55:00.000Z",
        endsAt: "2026-04-01T09:55:00.000Z",
      },
      {
        ...createPomodoroSession("short_break", "2026-04-01T09:55:00.000Z", 2),
        status: "completed" as const,
        completedAt: "2026-04-01T10:00:00.000Z",
        endsAt: "2026-04-01T10:00:00.000Z",
      },
      {
        ...createPomodoroSession("focus", "2026-04-01T10:00:00.000Z", 3),
        status: "completed" as const,
        completedAt: "2026-04-01T10:25:00.000Z",
        endsAt: "2026-04-01T10:25:00.000Z",
      },
      {
        ...createPomodoroSession("short_break", "2026-04-01T10:25:00.000Z", 3),
        status: "completed" as const,
        completedAt: "2026-04-01T10:30:00.000Z",
        endsAt: "2026-04-01T10:30:00.000Z",
      },
      {
        ...createPomodoroSession("focus", "2026-04-01T10:30:00.000Z", 4),
        status: "completed" as const,
        completedAt: "2026-04-01T10:55:00.000Z",
        endsAt: "2026-04-01T10:55:00.000Z",
      },
    ];

    const state = buildPomodoroState(sessions, [], "2026-04-01T10:56:00.000Z");

    expect(state.activeSession).toBeNull();
    expect(state.nextSessionKind).toBe("long_break");
    expect(state.completedFocusCountInCycle).toBe(4);
  });

  it("tracks active task inside a running focus session", () => {
    const session = createPomodoroSession("focus", "2026-04-01T11:00:00.000Z", 2);
    const firstSegment = {
      ...createPomodoroSegment(session.id, "2026-04-01T11:00:00.000Z", "task-1"),
      endedAt: "2026-04-01T11:10:00.000Z",
    };
    const secondSegment = createPomodoroSegment(session.id, "2026-04-01T11:10:00.000Z", "task-2");

    const details = buildPomodoroSessionDetails([session], [firstSegment, secondSegment]);

    expect(details[0].activeTaskId).toBe("task-2");
    expect(details[0].activeLabel).toBeNull();
    expect(details[0].taskIds).toEqual(["task-1", "task-2"]);
  });

  it("keeps a paused focus session active with its last task", () => {
    const session = {
      ...createPomodoroSession("focus", "2026-04-01T11:00:00.000Z", 2),
      status: "paused" as const,
      pausedRemainingMs: 8 * 60 * 1000,
    };
    const segment = {
      ...createPomodoroSegment(session.id, "2026-04-01T11:00:00.000Z", "task-2"),
      endedAt: "2026-04-01T11:17:00.000Z",
    };

    const details = buildPomodoroSessionDetails([session], [segment]);
    const state = buildPomodoroState([session], [segment], "2026-04-01T12:00:00.000Z");

    expect(details[0].activeTaskId).toBe("task-2");
    expect(state.activeSession?.status).toBe("paused");
    expect(state.nextSessionKind).toBe("short_break");
  });

  it("resets the cycle after more than 25 minutes of inactivity", () => {
    const sessions = [
      {
        ...createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 2),
        status: "completed" as const,
        completedAt: "2026-04-01T09:25:00.000Z",
        endsAt: "2026-04-01T09:25:00.000Z",
      },
    ];

    const state = buildPomodoroState(sessions, [], "2026-04-01T09:51:00.000Z");

    expect(state.activeSession).toBeNull();
    expect(state.nextSessionKind).toBe("focus");
    expect(state.currentCycleIndex).toBe(1);
    expect(state.nextFocusCycleIndex).toBe(1);
    expect(state.completedFocusCountInCycle).toBe(0);
  });

  it("treats an expired running session as finished for cycle reset (stale DB row)", () => {
    const staleRunning = createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 2);
    expect(staleRunning.status).toBe("running");

    const state = buildPomodoroState([staleRunning], [], "2026-04-01T10:00:00.000Z");

    expect(state.activeSession).toBeNull();
    expect(state.currentCycleIndex).toBe(1);
  });

  it("resets during an in-progress break when idle already exceeded before that break", () => {
    const focusDone = {
      ...createPomodoroSession("focus", "2026-04-01T06:00:00.000Z", 2),
      status: "completed" as const,
      completedAt: "2026-04-01T06:25:00.000Z",
      endsAt: "2026-04-01T06:25:00.000Z",
    };
    const liveBreak = createPomodoroSession("short_break", "2026-04-01T08:50:00.000Z", 2);
    const sessions = [focusDone, liveBreak];
    const now = "2026-04-01T08:52:00.000Z";

    const state = buildPomodoroState(sessions, [], now);
    expect(state.activeSession).toBeNull();
    expect(state.currentCycleIndex).toBe(1);
    expect(state.nextSessionKind).toBe("focus");

    expect(getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset(sessions, now)).toEqual([
      liveBreak.id,
    ]);
  });

  it("tracks a free-form title inside a running focus session", () => {
    const session = createPomodoroSession("focus", "2026-04-01T11:00:00.000Z", 1);
    const segment = createPomodoroSegment(
      session.id,
      "2026-04-01T11:00:00.000Z",
      null,
      "Inbox zero",
    );

    const details = buildPomodoroSessionDetails([session], [segment]);

    expect(details[0].activeTaskId).toBeNull();
    expect(details[0].activeLabel).toBe("Inbox zero");
  });

  it("builds real-time task summaries from pomodoro segments", () => {
    const session = {
      ...createPomodoroSession("focus", "2026-04-01T11:00:00.000Z", 1),
      status: "completed" as const,
      completedAt: "2026-04-01T11:25:00.000Z",
      endsAt: "2026-04-01T11:25:00.000Z",
    };
    const tasks: Task[] = [
      {
        id: "task-1",
        title: "Project Dash",
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
        createdAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    ];

    const segments = [
      {
        ...createPomodoroSegment(session.id, "2026-04-01T11:00:00.000Z", "task-1"),
        endedAt: "2026-04-01T11:15:00.000Z",
      },
      {
        ...createPomodoroSegment(session.id, "2026-04-01T11:15:00.000Z", null, "Inbox zero"),
        endedAt: "2026-04-01T11:25:00.000Z",
      },
    ];

    const summaries = buildPomodoroTaskSummaries(
      [session],
      segments,
      tasks,
      "2026-04-01",
      "2026-04-01T12:00:00.000Z",
    );

    expect(summaries).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        totalSeconds: 900,
      }),
      expect.objectContaining({
        taskId: null,
        taskTitle: "Inbox zero",
        totalSeconds: 600,
      }),
    ]);
    expect(computeDailyPomodoroStats([session], "2026-04-01").completedFocusSessions).toBe(1);
  });
});
