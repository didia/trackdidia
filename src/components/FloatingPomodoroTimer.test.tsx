import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../domain/types";
import {
  buildPomodoroSessionDetails,
  buildPomodoroState,
  createPomodoroSession,
} from "../lib/pomodoro/engine";
import { renderWithApp } from "../test/test-utils";
import { FloatingPomodoroTimer } from "./FloatingPomodoroTimer";

const taskFixture = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Rédiger le plan",
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
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-01T10:00:00.000Z",
  ...overrides,
});

const completedFocusAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const completedFocusStartedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const completedFocus = {
  ...createPomodoroSession("focus", completedFocusStartedAt, 1),
  status: "completed" as const,
  completedAt: completedFocusAt,
  endsAt: completedFocusAt,
};

const idleAfterFocusState = buildPomodoroState([completedFocus], []);
const idleAfterFocusSessions = buildPomodoroSessionDetails([completedFocus], []);

describe("FloatingPomodoroTimer", () => {
  it("stays hidden on a cold start with no sessions", async () => {
    await renderWithApp(<FloatingPomodoroTimer />);

    expect(screen.queryByLabelText("Cycle Pomodoro")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pomodoro actif")).not.toBeInTheDocument();
  });

  it("shows the idle overlay after a completed focus within the cycle window", async () => {
    await renderWithApp(<FloatingPomodoroTimer />, {
      contextOverrides: {
        pomodoro: {
          state: idleAfterFocusState,
          sessions: idleAfterFocusSessions,
          taskSummaries: [],
          taskOptions: [taskFixture()],
          currentTask: null,
          currentActivityLabel: null,
          preferredTask: taskFixture(),
          preferredActivityLabel: null,
          loading: false,
          reloadError: null,
          reload: async () => undefined,
          startPomodoro: async () => undefined,
          pauseCurrent: async () => undefined,
          resumeCurrent: async () => undefined,
          skipBreak: async () => undefined,
          completeCurrentTask: async () => undefined,
          completeNow: async () => undefined,
          cancelCurrent: async () => undefined,
          switchTask: async () => undefined,
        },
      },
    });

    expect(screen.getByLabelText("Cycle Pomodoro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Démarrer la pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Démarrer un focus" })).toBeInTheDocument();
  });

  it("starts break and focus with the expected controller arguments", async () => {
    const startPomodoro = vi.fn(async () => undefined);
    const user = userEvent.setup();

    await renderWithApp(<FloatingPomodoroTimer />, {
      contextOverrides: {
        pomodoro: {
          state: idleAfterFocusState,
          sessions: idleAfterFocusSessions,
          taskSummaries: [],
          taskOptions: [taskFixture()],
          currentTask: null,
          currentActivityLabel: null,
          preferredTask: taskFixture(),
          preferredActivityLabel: null,
          loading: false,
          reloadError: null,
          reload: async () => undefined,
          startPomodoro,
          pauseCurrent: async () => undefined,
          resumeCurrent: async () => undefined,
          skipBreak: async () => undefined,
          completeCurrentTask: async () => undefined,
          completeNow: async () => undefined,
          cancelCurrent: async () => undefined,
          switchTask: async () => undefined,
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Démarrer la pause" }));
    expect(startPomodoro).toHaveBeenCalledWith();

    await user.click(screen.getByRole("button", { name: "Démarrer un focus" }));
    expect(startPomodoro).toHaveBeenLastCalledWith({
      kind: "focus",
      taskId: "task-1",
      title: null,
    });
  });

  it("stays hidden on the Pomodoro page", async () => {
    await renderWithApp(<FloatingPomodoroTimer />, {
      route: "/pomodoro",
      contextOverrides: {
        pomodoro: {
          state: idleAfterFocusState,
          sessions: idleAfterFocusSessions,
          taskSummaries: [],
          taskOptions: [taskFixture()],
          currentTask: null,
          currentActivityLabel: null,
          preferredTask: taskFixture(),
          preferredActivityLabel: null,
          loading: false,
          reloadError: null,
          reload: async () => undefined,
          startPomodoro: async () => undefined,
          pauseCurrent: async () => undefined,
          resumeCurrent: async () => undefined,
          skipBreak: async () => undefined,
          completeCurrentTask: async () => undefined,
          completeNow: async () => undefined,
          cancelCurrent: async () => undefined,
          switchTask: async () => undefined,
        },
      },
    });

    expect(screen.queryByLabelText("Cycle Pomodoro")).not.toBeInTheDocument();
  });
});
