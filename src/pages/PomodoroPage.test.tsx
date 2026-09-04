import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PomodoroControllerValue } from "../app/use-pomodoro-controller";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { renderWithApp } from "../test/test-utils";
import { PomodoroPage } from "./PomodoroPage";

const buildPomodoro = (
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
  pauseCurrent: async () => undefined,
  resumeCurrent: async () => undefined,
  skipBreak: async () => undefined,
  completeCurrentTask: async () => undefined,
  completeNow: async () => undefined,
  cancelCurrent: async () => undefined,
  switchTask: async () => undefined,
  ...overrides,
});

describe("PomodoroPage", () => {
  it("reloads task lists on mount and when the refresh button is clicked", async () => {
    const reload = vi.fn(async () => undefined);
    const user = userEvent.setup();

    await renderWithApp(<PomodoroPage />, {
      contextOverrides: { pomodoro: buildPomodoro({ reload }) },
    });

    const refreshButton = await screen.findByRole("button", { name: /rafraîchir les tâches/i });
    expect(reload).toHaveBeenCalled();

    reload.mockClear();
    await user.click(refreshButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while lists are loading", async () => {
    await renderWithApp(<PomodoroPage />, {
      contextOverrides: { pomodoro: buildPomodoro({ loading: true }) },
    });

    expect(await screen.findByRole("button", { name: /rafraîchir les tâches/i })).toBeDisabled();
  });

  it("does not reload on mount when the controller is already loading", async () => {
    const reload = vi.fn(async () => undefined);

    await renderWithApp(<PomodoroPage />, {
      contextOverrides: { pomodoro: buildPomodoro({ loading: true, reload }) },
    });

    await screen.findByRole("button", { name: /rafraîchir les tâches/i });
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows a manual refresh failure from the controller", async () => {
    await renderWithApp(<PomodoroPage />, {
      contextOverrides: {
        pomodoro: buildPomodoro({ reloadError: "Impossible de rafraichir les taches." }),
      },
    });

    expect(await screen.findByText("Impossible de rafraichir les taches.")).toBeInTheDocument();
  });
});
