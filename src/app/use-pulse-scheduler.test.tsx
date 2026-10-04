import { act, renderHook } from "@testing-library/react";
import { defaultAppSettings } from "../domain/settings";
import type { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { usePulseScheduler } from "./use-pulse-scheduler";

const engine = vi.hoisted(() => ({
  runPulseEngine: vi.fn(),
}));

vi.mock("../lib/ai/pulse/pulse-engine", () => ({
  runPulseEngine: engine.runPulseEngine,
}));

describe("usePulseScheduler", () => {
  afterEach(() => {
    engine.runPulseEngine.mockReset();
  });

  const coachService = {} as CoachPulseService;

  it("evaluates once at startup, reads live values through refs, and does not restart on rerender", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    engine.runPulseEngine.mockResolvedValue({ result: null, recordedMissed: 0, ranSlot: null });
    const updateSettings = vi.fn();

    let focus = false;
    const { rerender } = renderHook(() =>
      usePulseScheduler(repository, coachService, () => focus, {
        getSettings: () => defaultAppSettings(),
        updateSettings,
        enqueueStartupWork: (work) => work(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(engine.runPulseEngine).toHaveBeenCalledTimes(1));
    expect(engine.runPulseEngine.mock.calls[0][0].focusSessionActive).toBe(false);

    focus = true;
    rerender();
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(engine.runPulseEngine).toHaveBeenCalledTimes(1);
  });

  it("bumps the revision when the engine persisted a result", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    engine.runPulseEngine.mockResolvedValue({
      result: { stance: "open" },
      recordedMissed: 0,
      ranSlot: null,
    });

    const { result } = renderHook(() =>
      usePulseScheduler(repository, coachService, () => false, {
        getSettings: () => defaultAppSettings(),
        updateSettings: vi.fn(),
        enqueueStartupWork: (work) => work(),
      }),
    );

    await act(async () => {
      await vi.waitFor(() => expect(engine.runPulseEngine).toHaveBeenCalledTimes(1));
    });
    await vi.waitFor(() => expect(result.current).toBe(1));
  });
});
