import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import type { AiProvider } from "../lib/ai/provider";
import { defaultAppSettings, updateNote } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { AppContext, type AppContextValue } from "./app-context";
import { useDailyEntry } from "./use-daily-entry";

class FakeProvider implements AiProvider {
  async generateStructured() {
    return {
      text: "{}",
      model: "test",
      usage: { tokensPrompt: 0, tokensCompletion: 0, latencyMs: 0 }
    };
  }
}

const wrapRepository = (repository: MemoryRepository) => {
  const value: AppContextValue = {
    repository,
    settings: defaultAppSettings(),
    saveSettings: async () => undefined,
    coachService: new CoachPulseService(new FakeProvider()),
    browserPreview: true,
    debugEnabled: false,
    setDebugEnabled: () => undefined,
    pomodoro: {
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
      switchTask: async () => undefined
    },
    pulseRevision: 0
  };

  return ({ children }: PropsWithChildren) => (
    <AppContext.Provider value={value}>{children}</AppContext.Provider>
  );
};

describe("useDailyEntry", () => {
  it("composes overlapping note updates so the first field is not overwritten", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const originalSave = repository.saveDailyEntry.bind(repository);
    vi.spyOn(repository, "saveDailyEntry").mockImplementation(async (entry) => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 80);
      });
      return originalSave(entry);
    });

    const { result } = renderHook(() => useDailyEntry(today), {
      wrapper: wrapRepository(repository)
    });

    await waitFor(() => {
      expect(result.current.entry).not.toBeNull();
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      const first = result.current.save((current) => updateNote(current, "morningIntention", "Mon intention"));
      const second = result.current.save((current) => updateNote(current, "nightReflection", "Ma reflexion"));
      await Promise.all([first, second]);
    });

    const saved = await repository.getDailyEntry(today);
    expect(saved?.morningIntention).toBe("Mon intention");
    expect(saved?.nightReflection).toBe("Ma reflexion");
    expect(result.current.entry?.morningIntention).toBe("Mon intention");
    expect(result.current.entry?.nightReflection).toBe("Ma reflexion");
  });
});
