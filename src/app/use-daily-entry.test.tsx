import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { createEmptyDailyEntry, defaultAppSettings, updateNote } from "../domain/daily-entry";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import type { AiProvider } from "../lib/ai/provider";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/date";
import { buildPomodoroSessionDetails, buildPomodoroState } from "../lib/pomodoro/engine";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { AppContext, type AppContextValue } from "./app-context";
import { useDailyEntry } from "./use-daily-entry";

class FakeProvider implements AiProvider {
  async generateStructured() {
    return {
      text: "{}",
      model: "test",
      usage: { tokensPrompt: 0, tokensCompletion: 0, latencyMs: 0 },
    };
  }
}

const wrapRepository = (repository: MemoryRepository) => {
  const value: AppContextValue = {
    repository,
    settings: defaultAppSettings(),
    updateSettings: (updater) => repository.updateSettings(updater),
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
      focusOnTask: async () => undefined,
      pauseCurrent: async () => undefined,
      resumeCurrent: async () => undefined,
      skipBreak: async () => undefined,
      completeCurrentTask: async () => undefined,
      completeNow: async () => undefined,
      cancelCurrent: async () => undefined,
      switchTask: async () => undefined,
    },
    pulseRevision: 0,
    calendarDay: getTodayDate(),
    reconfigureEmailTriage: async () => undefined,
    llmBridgeStatus: { state: "off" },
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
      wrapper: wrapRepository(repository),
    });

    await waitFor(() => {
      expect(result.current.entry).not.toBeNull();
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      const first = result.current.save((current) =>
        updateNote(current, "morningIntention", "Mon intention"),
      );
      const second = result.current.save((current) =>
        updateNote(current, "nightReflection", "Ma reflexion"),
      );
      await Promise.all([first, second]);
    });

    const saved = await repository.getDailyEntry(today);
    expect(saved?.morningIntention).toBe("Mon intention");
    expect(saved?.nightReflection).toBe("Ma reflexion");
    expect(result.current.entry?.morningIntention).toBe("Mon intention");
    expect(result.current.entry?.nightReflection).toBe("Ma reflexion");
  });

  it("keeps queued saves attached to their date when navigating to another entry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const oldDate = addDays(getTodayDate(), -2);
    const newDate = addDays(oldDate, 1);
    const originalSave = repository.saveDailyEntry.bind(repository);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const saveSpy = vi.spyOn(repository, "saveDailyEntry").mockImplementationOnce(async (entry) => {
      await gate;
      return originalSave(entry);
    });
    const { result, rerender } = renderHook(({ date }) => useDailyEntry(date), {
      initialProps: { date: oldDate },
      wrapper: wrapRepository(repository),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let first!: Promise<void>;
    act(() => {
      first = result.current.save((current) =>
        updateNote(current, "morningIntention", "old first"),
      );
    });
    await waitFor(() => expect(saveSpy).toHaveBeenCalledOnce());
    let second!: Promise<void>;
    act(() => {
      second = result.current.save((current) =>
        updateNote(current, "nightReflection", "old latest"),
      );
    });
    rerender({ date: newDate });
    await waitFor(() => expect(result.current.entry?.date).toBe(newDate));
    await act(async () => {
      await result.current.save((current) => updateNote(current, "morningIntention", "new date"));
      releaseFirst();
      await Promise.all([first, second]);
    });
    expect(await repository.getDailyEntry(oldDate)).toMatchObject({
      morningIntention: "old first",
      nightReflection: "old latest",
    });
    expect(await repository.getDailyEntry(newDate)).toMatchObject({
      morningIntention: "new date",
      nightReflection: "",
    });
    expect(result.current.entry?.date).toBe(newDate);
    expect(result.current.entry?.morningIntention).toBe("new date");
  });

  it.each([
    "before returning",
    "while loading",
  ])("restores a dirty date when its save rejects %s and allows retry", async (failureTiming) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const oldDate = addDays(getTodayDate(), -2);
    const newDate = addDays(oldDate, 1);
    await repository.saveDailyEntry(
      updateNote(createEmptyDailyEntry(oldDate), "morningIntention", "Stored intention"),
    );
    let rejectSave!: (error: Error) => void;
    const gate = new Promise<void>((_, reject) => {
      rejectSave = reject;
    });
    const saveSpy = vi.spyOn(repository, "saveDailyEntry").mockImplementationOnce(async () => {
      await gate;
    });
    const { result, rerender } = renderHook(({ date }) => useDailyEntry(date), {
      initialProps: { date: oldDate },
      wrapper: wrapRepository(repository),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let failedSave!: Promise<void>;
    act(() => {
      failedSave = result.current.save((current) =>
        updateNote(current, "morningIntention", "Unsaved intention"),
      );
    });
    const rejection = expect(failedSave).rejects.toThrow("disk full");
    await waitFor(() => expect(saveSpy).toHaveBeenCalledOnce());
    rerender({ date: newDate });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.entry?.date).toBe(newDate);
    });
    if (failureTiming === "before returning") {
      await act(async () => {
        rejectSave(new Error("disk full"));
        await rejection;
      });
    }
    rerender({ date: oldDate });
    if (failureTiming === "while loading") {
      expect(result.current.loading).toBe(true);
      await act(async () => {
        rejectSave(new Error("disk full"));
        await rejection;
      });
    }
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.entry?.date).toBe(oldDate);
      expect(result.current.entry?.morningIntention).toBe("Unsaved intention");
    });
    expect((await repository.getDailyEntry(oldDate))?.morningIntention).toBe("Stored intention");
    await act(async () => {
      await result.current.save((current) => updateNote(current, "nightReflection", "Retry"));
      await result.current.reload();
    });
    expect(await repository.getDailyEntry(oldDate)).toMatchObject({
      morningIntention: "Unsaved intention",
      nightReflection: "Retry",
    });
    expect(result.current.entry?.nightReflection).toBe("Retry");
  });

  it("prefills today's empty intention from yesterday's focus without persisting", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    await repository.saveDailyEntry(
      updateNote(
        createEmptyDailyEntry(addDays(today, -1)),
        "tomorrowFocus",
        "Tenir le premier bloc",
      ),
    );
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");

    const { result } = renderHook(() => useDailyEntry(today), {
      wrapper: wrapRepository(repository),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entry?.morningIntention).toBe("Tenir le premier bloc");
    expect(saveDailyEntry).not.toHaveBeenCalled();
    expect(await repository.getDailyEntry(today)).toBeNull();
  });

  it("does not overwrite a saved morning intention with yesterday's focus", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    await repository.saveDailyEntry(
      updateNote(createEmptyDailyEntry(addDays(today, -1)), "tomorrowFocus", "Focus d'hier"),
    );
    await repository.saveDailyEntry(
      updateNote(createEmptyDailyEntry(today), "morningIntention", "Déjà choisi"),
    );

    const { result } = renderHook(() => useDailyEntry(today), {
      wrapper: wrapRepository(repository),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entry?.morningIntention).toBe("Déjà choisi");
  });

  it("does not prefill a historical day from the previous day's focus", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const historical = addDays(today, -1);
    await repository.saveDailyEntry(
      updateNote(
        createEmptyDailyEntry(addDays(historical, -1)),
        "tomorrowFocus",
        "Focus de dimanche",
      ),
    );
    await repository.saveDailyEntry(createEmptyDailyEntry(historical));

    const { result } = renderHook(() => useDailyEntry(historical), {
      wrapper: wrapRepository(repository),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entry?.morningIntention).toBe("");
  });
});

it.each([
  "nightReflection",
  "morningIntention",
] as const)("preserves a later %s edit while accepting a daily draft", async (field) => {
  const repository = new MemoryRepository();
  const date = getTodayDate();
  const proposal = {
    id: "proposal:queued",
    messageId: "message",
    type: "intention_draft" as const,
    payloadJson: JSON.stringify({ text: "Focus" }),
    status: "pending" as const,
    appliedEntityId: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  await repository.saveAiProposal(proposal);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalAccept = repository.acceptAiProposal.bind(repository);
  const accept = vi.spyOn(repository, "acceptAiProposal").mockImplementation(async (...args) => {
    await gate;
    return originalAccept(...args);
  });
  const { result } = renderHook(() => useDailyEntry(date), { wrapper: wrapRepository(repository) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let acceptance!: ReturnType<typeof result.current.applyProposal>;
  await act(async () => {
    acceptance = result.current.applyProposal(proposal);
  });
  await waitFor(() => expect(accept).toHaveBeenCalled());
  let saving!: ReturnType<typeof result.current.save>;
  await act(async () => {
    saving = result.current.save((current) => updateNote(current, field, "My later edit"));
  });
  await act(async () => {
    release();
    await Promise.all([acceptance, saving]);
  });
  const stored = await repository.getDailyEntry(date);
  expect(stored?.[field]).toBe("My later edit");
  if (field === "nightReflection") expect(stored?.morningIntention).toBe("Focus");
  expect(result.current.entry?.[field]).toBe("My later edit");
  expect((await repository.listAiProposals(proposal.messageId))[0].status).toBe("accepted");
});

it.each([
  "morningIntention",
  "tomorrowFocus",
] as const)("keeps a manual %s edit through queued repeat acceptance and a later save", async (field) => {
  const repository = new MemoryRepository();
  const date = getTodayDate();
  const proposal = {
    id: "proposal:repeat",
    messageId: "message",
    type:
      field === "morningIntention"
        ? ("intention_draft" as const)
        : ("tomorrow_focus_draft" as const),
    payloadJson: JSON.stringify({ text: "Coach draft" }),
    status: "pending" as const,
    appliedEntityId: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  await repository.saveAiProposal(proposal);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalAccept = repository.acceptAiProposal.bind(repository);
  const accept = vi.spyOn(repository, "acceptAiProposal").mockImplementation(async (...args) => {
    await gate;
    return originalAccept(...args);
  });
  const { result } = renderHook(() => useDailyEntry(date), { wrapper: wrapRepository(repository) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  let first!: ReturnType<typeof result.current.applyProposal>;
  await act(async () => {
    first = result.current.applyProposal(proposal);
  });
  await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
  let saving!: ReturnType<typeof result.current.save>;
  let repeat!: ReturnType<typeof result.current.applyProposal>;
  await act(async () => {
    saving = result.current.save((current) => updateNote(current, field, "Manual edit"));
    repeat = result.current.applyProposal(proposal);
  });
  await act(async () => {
    release();
    await Promise.all([first, saving, repeat]);
  });
  expect((await repeat).dailyNote).toBeUndefined();
  expect(result.current.entry?.[field]).toBe("Manual edit");
  expect((await repository.getDailyEntry(date))?.[field]).toBe("Manual edit");
  await act(async () => {
    await result.current.save((current) => updateNote(current, "nightReflection", "Another field"));
  });
  expect((await repository.getDailyEntry(date))?.[field]).toBe("Manual edit");
});
