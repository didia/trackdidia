import { act, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { defaultAppSettings } from "../domain/daily-entry";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import type { AiProvider } from "../lib/ai/provider";
import { buildIsoFromLocalDateAndTime } from "../lib/date";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { AppContext, type AppContextValue } from "./app-context";
import { useGtdWorkspace } from "./use-gtd";
import { useLocalDayReconciliation } from "./use-local-day-reconciliation";

class FakeProvider implements AiProvider {
  async generateStructured() {
    return {
      text: "{}",
      model: "test",
      usage: { tokensPrompt: 0, tokensCompletion: 0, latencyMs: 0 },
    };
  }
}

const idlePomodoro = {
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
};

const NextActionTitles = () => {
  const { tasks, loading } = useGtdWorkspace();
  if (loading) {
    return <p>Chargement</p>;
  }

  return (
    <ul>
      {tasks
        .filter((task) => task.bucket === "next_action")
        .map((task) => (
          <li key={task.id}>{task.title}</li>
        ))}
    </ul>
  );
};

const MountedGtdView = ({ repository }: { repository: MemoryRepository }) => {
  const calendarDay = useLocalDayReconciliation(repository);
  const value = useMemo<AppContextValue>(
    () => ({
      repository,
      settings: defaultAppSettings(),
      saveSettings: async () => undefined,
      coachService: new CoachPulseService(new FakeProvider()),
      browserPreview: true,
      debugEnabled: false,
      setDebugEnabled: () => undefined,
      pomodoro: idlePomodoro,
      pulseRevision: 0,
      calendarDay,
    }),
    [calendarDay, repository],
  );

  return (
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <AppContext.Provider value={value}>
        <NextActionTitles />
      </AppContext.Provider>
    </MemoryRouter>
  );
};

const flushEffects = async () => {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  });
};

describe("useLocalDayReconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const seedDueTomorrow = async (repository: MemoryRepository, title: string) => {
    await repository.createTask({
      title,
      bucket: "scheduled",
      scheduledFor: buildIsoFromLocalDateAndTime("2026-09-08", "09:00"),
    });
  };

  it("promotes due Scheduled tasks and republishes them after local midnight in a mounted view", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 23, 59, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    await seedDueTomorrow(repository, "Appelee a minuit");

    render(<MountedGtdView repository={repository} />);
    await flushEffects();
    expect(screen.queryByText("Appelee a minuit")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    await flushEffects();

    expect(screen.getByText("Appelee a minuit")).toBeInTheDocument();
  });

  it("promotes due Scheduled tasks when the window becomes visible after the local day changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    await seedDueTomorrow(repository, "Appelee au reveil");

    render(<MountedGtdView repository={repository} />);
    await flushEffects();
    expect(screen.queryByText("Appelee au reveil")).not.toBeInTheDocument();

    vi.setSystemTime(new Date(2026, 8, 8, 9, 0, 0, 0));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushEffects();

    expect(screen.getByText("Appelee au reveil")).toBeInTheDocument();
  });
});
