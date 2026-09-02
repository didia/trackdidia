import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import type { PomodoroSession } from "../domain/types";
import { MemoryRepository } from "../lib/storage/memory-repository";

const { announceCompletion } = vi.hoisted(() => ({ announceCompletion: vi.fn(async () => undefined) }));

vi.mock("../lib/pomodoro/sound", () => ({
  unlockPomodoroSound: vi.fn(async () => undefined),
  playPomodoroChime: vi.fn(async () => undefined),
  notifyPomodoroCompletion: announceCompletion,
  resolvePomodoroChimeVariant: vi.fn(() => "focus")
}));

import { usePomodoroController } from "./use-pomodoro-controller";

describe("usePomodoroController", () => {
  afterEach(() => {
    vi.useRealTimers();
    announceCompletion.mockClear();
  });

  const createRunningRepository = async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.startPomodoro();
    return repository;
  };

  const flushControllerQueue = async () => {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });
  };

  it("uses one deadline scheduler and announces an expiry once under StrictMode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const completeExpired = vi.spyOn(repository, "completeExpiredPomodoroSessions");
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => usePomodoroController(repository), { wrapper });

    await flushControllerQueue();
    expect(result.current.state.activeSession?.status).toBe("running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    });
    await flushControllerQueue();
    expect(result.current.state.activeSession).toBeNull();

    expect(completeExpired).toHaveBeenCalled();
    expect(announceCompletion).toHaveBeenCalledTimes(1);
  });

  it("reconciles a missed deadline on visibility and does not publish a one-second controller value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    expect(result.current.state.activeSession?.status).toBe("running");
    const stableControllerValue = result.current;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(stableControllerValue);

    vi.setSystemTime(new Date("2026-04-01T09:25:01.000Z"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await flushControllerQueue();
    expect(result.current.state.activeSession).toBeNull();
    expect(announceCompletion).toHaveBeenCalledTimes(1);
  });

  it("serializes competing timer actions against the session current when each executes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    await act(async () => {
      await Promise.all([result.current.pauseCurrent(), result.current.cancelCurrent()]);
    });

    expect(result.current.state.activeSession).toBeNull();
    expect((await repository.listPomodoroSessions("2026-04-01"))[0]?.status).toBe("cancelled");
  });

  it("keeps malformed running storage visible to the controller so it can be recovered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const sessions = (repository as unknown as { pomodoroSessions: Map<string, PomodoroSession> }).pomodoroSessions;
    const [session] = [...sessions.values()];
    sessions.set(session.id, { ...session, endsAt: "not-a-date" });
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    expect(result.current.state.activeSession).toMatchObject({
      id: session.id,
      status: "running",
      endsAt: "not-a-date"
    });

    await act(async () => {
      await result.current.cancelCurrent();
    });
    expect((await repository.listPomodoroSessions("2026-04-01"))[0]?.status).toBe("cancelled");
  });

  it("completes an expired session before queued actions can pause or switch it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const pause = vi.spyOn(repository, "pausePomodoroSession");
    const switchTask = vi.spyOn(repository, "switchPomodoroTask");
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    pause.mockClear();
    switchTask.mockClear();
    vi.setSystemTime(new Date("2026-04-01T09:25:00.000Z"));
    await act(async () => {
      const paused = result.current.pauseCurrent();
      const switched = result.current.switchTask(null, "Too late");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([paused, switched]);
    });
    await flushControllerQueue();

    expect((await repository.listPomodoroSessions("2026-04-01"))[0]?.status).toBe("completed");
    expect(pause).not.toHaveBeenCalled();
    expect(switchTask).not.toHaveBeenCalled();
    expect(announceCompletion).toHaveBeenCalledTimes(1);
  });

  it("announces a persisted expiry even when its ordinary refresh transiently fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const originalListPomodoroSessions = repository.listPomodoroSessions.bind(repository);
    const listPomodoroSessions = vi.spyOn(repository, "listPomodoroSessions");
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    listPomodoroSessions.mockClear();
    listPomodoroSessions
      .mockImplementationOnce((date) => originalListPomodoroSessions(date))
      .mockRejectedValueOnce(new Error("temporary refresh failure"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    });
    await flushControllerQueue();

    expect(result.current.state.activeSession).toBeNull();
    expect(result.current.sessions[0]?.status).toBe("completed");
    expect((await originalListPomodoroSessions("2026-04-01"))[0]?.status).toBe("completed");
    expect(announceCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps session history aligned after a timer action whose list refresh fails once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const listPomodoroSessions = vi.spyOn(repository, "listPomodoroSessions");
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    expect(result.current.sessions[0]?.status).toBe("running");
    listPomodoroSessions.mockClear();
    listPomodoroSessions.mockRejectedValueOnce(new Error("temporary refresh failure"));

    await act(async () => {
      await result.current.pauseCurrent();
    });

    expect(result.current.state.activeSession?.status).toBe("paused");
    expect(result.current.sessions[0]?.status).toBe("paused");
  });

  it("retries a stale history snapshot after repeated list refresh failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const repository = await createRunningRepository();
    const listPomodoroSessions = vi.spyOn(repository, "listPomodoroSessions");
    const { result } = renderHook(() => usePomodoroController(repository));

    await flushControllerQueue();
    expect(result.current.sessions[0]?.status).toBe("running");
    listPomodoroSessions.mockClear();
    listPomodoroSessions
      .mockRejectedValueOnce(new Error("temporary refresh failure"))
      .mockRejectedValueOnce(new Error("temporary refresh failure"));

    await act(async () => {
      await result.current.pauseCurrent();
    });

    expect(result.current.state.activeSession?.status).toBe("paused");
    expect(result.current.sessions[0]?.status).toBe("running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushControllerQueue();

    expect(result.current.sessions[0]?.status).toBe("paused");
  });

  it("raises loading while a manual reload is in flight", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const { result } = renderHook(() => usePomodoroController(repository));
    await flushControllerQueue();
    expect(result.current.loading).toBe(false);

    const originalListTasks = repository.listTasks.bind(repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(repository, "listTasks").mockImplementation(async (filters) => {
      await gate;
      return originalListTasks(filters);
    });

    let finished = false;
    const pending = result.current.reload().then(() => {
      finished = true;
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });
    expect(finished).toBe(false);

    await act(async () => {
      release();
      await pending;
    });

    expect(result.current.loading).toBe(false);
  });

  it("records a reload error and clears loading when a manual refresh fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const { result } = renderHook(() => usePomodoroController(repository));
    await flushControllerQueue();

    vi.spyOn(repository, "generateDueRecurringTasks").mockRejectedValueOnce(new Error("sqlite busy"));

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.reloadError).toBe("Impossible de rafraichir les taches.");
  });
});
