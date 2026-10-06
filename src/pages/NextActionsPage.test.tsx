import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PomodoroControllerValue } from "../app/use-pomodoro-controller";
import type { Task } from "../domain/types";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { NextActionsPage, sortNextActionTasks } from "./NextActionsPage";

const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task:default",
  title: "Action",
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
  sourceUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const older = buildTask({
  id: "task:older",
  title: "Ancienne action",
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-02T10:00:00.000Z",
  deadline: "2026-12-31",
});
const newer = buildTask({
  id: "task:newer",
  title: "Recente action",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-02T10:00:00.000Z",
  deadline: "2026-01-15",
});

describe("sortNextActionTasks", () => {
  it("puts the oldest createdAt first in created mode even when a newer task has an earlier deadline", () => {
    expect(sortNextActionTasks([newer, older], "created").map((task) => task.id)).toEqual([
      "task:older",
      "task:newer",
    ]);
  });

  it("breaks createdAt ties with id", () => {
    const zebra = buildTask({ id: "task:z", createdAt: "2026-01-01T10:00:00.000Z" });
    const alpha = buildTask({ id: "task:a", createdAt: "2026-01-01T10:00:00.000Z" });

    expect(sortNextActionTasks([zebra, alpha], "created").map((task) => task.id)).toEqual([
      "task:a",
      "task:z",
    ]);
  });

  it("still sorts nearest deadline first in deadline_asc mode", () => {
    expect(sortNextActionTasks([older, newer], "deadline_asc").map((task) => task.id)).toEqual([
      "task:newer",
      "task:older",
    ]);
  });

  it("still sorts farthest deadline first in deadline_desc mode", () => {
    expect(sortNextActionTasks([newer, older], "deadline_desc").map((task) => task.id)).toEqual([
      "task:older",
      "task:newer",
    ]);
  });

  it("still sorts last update first in updated mode", () => {
    expect(sortNextActionTasks([older, newer], "updated").map((task) => task.id)).toEqual([
      "task:newer",
      "task:older",
    ]);
  });
});

const visibleTitles = () =>
  [...document.querySelectorAll(".task-card__title")].map((node) => node.textContent);

describe("NextActionsPage default order", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("lists next actions oldest-first by default and reorders when nearest deadline is selected", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await repository.getSettings();
    await repository.saveSettings({ ...settings, relationshipDrawsEnabled: false });
    await repository.createTask({
      title: newer.title,
      bucket: "next_action",
      createdAt: newer.createdAt,
      updatedAt: newer.updatedAt,
      deadline: newer.deadline,
    });
    await repository.createTask({
      title: older.title,
      bucket: "next_action",
      createdAt: older.createdAt,
      updatedAt: older.updatedAt,
      deadline: older.deadline,
    });

    await renderWithApp(<NextActionsPage />, { repository });

    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Ancienne action", "Recente action"]);
    });

    const sortSelect = screen.getByLabelText("Trier par");
    expect(sortSelect).toHaveValue("created");

    fireEvent.change(sortSelect, { target: { value: "deadline_asc" } });

    await waitFor(() => {
      expect(visibleTitles()).toEqual(["Recente action", "Ancienne action"]);
    });
  });

  it("shows calendar days since each task entered next actions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 9, 12, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await repository.getSettings();
    await repository.saveSettings({ ...settings, relationshipDrawsEnabled: false });
    await repository.createTask({
      title: "Action de deux jours",
      bucket: "next_action",
    });

    vi.setSystemTime(new Date(2026, 8, 11, 12, 0, 0));
    await renderWithApp(<NextActionsPage />, {
      repository,
      contextOverrides: { calendarDay: "2026-09-11" },
    });

    await waitFor(() => {
      expect(screen.getByText("Depuis 2 jours")).toBeInTheDocument();
    });
  });

  const idlePomodoroStub = (
    overrides: Partial<PomodoroControllerValue> = {},
  ): PomodoroControllerValue => ({
    state: buildPomodoroState([], []),
    sessions: buildPomodoroSessionDetails([], []),
    taskSummaries: [],
    taskOptions: [],
    currentTask: null,
    currentActivityLabel: null,
    preferredTask: null,
    preferredActivityLabel: null,
    loading: false,
    reloadError: null,
    reload: async () => undefined,
    startPomodoro: async () => undefined,
    focusOnTask: async () => undefined,
    pauseCurrent: async () => undefined,
    resumeCurrent: async () => undefined,
    skipBreak: async () => undefined,
    completeCurrentTask: async () => undefined,
    completeNow: async () => undefined,
    cancelCurrent: async () => undefined,
    switchTask: async () => undefined,
    ...overrides,
  });

  it("calls focusOnTask when the Pomodoro button on a next action is clicked", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await repository.getSettings();
    await repository.saveSettings({ ...settings, relationshipDrawsEnabled: false });
    const task = await repository.createTask({
      title: "Action focus",
      bucket: "next_action",
    });

    const focusOnTask = vi.fn(async () => undefined);
    const user = userEvent.setup();
    await renderWithApp(<NextActionsPage />, {
      repository,
      contextOverrides: { pomodoro: idlePomodoroStub({ focusOnTask }) },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Démarrer un Pomodoro sur Action focus/i }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /Démarrer un Pomodoro sur Action focus/i }),
    );
    expect(focusOnTask).toHaveBeenCalledWith(task.id);
  });

  it("shows En cours for the task already linked to the active focus", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await repository.getSettings();
    await repository.saveSettings({ ...settings, relationshipDrawsEnabled: false });
    const task = await repository.createTask({
      title: "Action focus",
      bucket: "next_action",
    });

    const focusOnTask = vi.fn(async () => undefined);
    const focusStartedAt = "2026-04-01T09:00:00.000Z";
    const activeSession = {
      id: "pomodoro-session:active",
      kind: "focus" as const,
      status: "running" as const,
      startedAt: focusStartedAt,
      endsAt: "2026-04-01T09:25:00.000Z",
      pausedRemainingMs: null,
      completedAt: null,
      cancelledAt: null,
      cycleIndex: 1,
      date: "2026-04-01",
      segments: [
        {
          id: "pomodoro-segment:1",
          sessionId: "pomodoro-session:active",
          taskId: task.id,
          title: null,
          startedAt: focusStartedAt,
          endedAt: null,
        },
      ],
      activeTaskId: task.id,
      activeLabel: null,
      taskIds: [task.id],
    };

    const user = userEvent.setup();
    await renderWithApp(<NextActionsPage />, {
      repository,
      contextOverrides: {
        pomodoro: idlePomodoroStub({
          focusOnTask,
          state: { ...buildPomodoroState([], []), activeSession },
          sessions: [activeSession],
          currentTask: task,
        }),
      },
    });

    const activeButton = await screen.findByRole("button", {
      name: /Pomodoro en cours sur Action focus/i,
    });
    expect(activeButton).toHaveAttribute("aria-pressed", "true");
    expect(activeButton).toHaveTextContent("En cours");

    await user.click(activeButton);
    expect(focusOnTask).not.toHaveBeenCalled();
  });
});
