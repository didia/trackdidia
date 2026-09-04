import { act, renderHook } from "@testing-library/react";
import { createPomodoroSession } from "../lib/pomodoro/engine";
import { usePomodoroTiming } from "./use-pomodoro-timing";

describe("usePomodoroTiming", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks a valid running session locally and stops for paused or invalid data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T09:00:00.000Z"));
    const running = {
      ...createPomodoroSession("focus", "2026-04-01T09:00:00.000Z", 1),
      segments: [],
      activeTaskId: null,
      activeLabel: null,
      taskIds: [],
    };
    const { result, rerender } = renderHook(({ session }) => usePomodoroTiming(session), {
      initialProps: { session: running },
    });

    expect(result.current.remainingMs).toBe(25 * 60 * 1000);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remainingMs).toBe(25 * 60 * 1000 - 1000);

    rerender({ session: { ...running, status: "paused" as const, pausedRemainingMs: 42_000 } });
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toMatchObject({ remainingMs: 42_000, valid: true });

    rerender({ session: { ...running, endsAt: "invalid" } });
    expect(result.current).toMatchObject({ remainingMs: 0, valid: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
