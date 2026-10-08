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

const { notifyCompletion, requestCalendarSyncMock } = vi.hoisted(() => ({
  notifyCompletion: vi.fn(async () => true),
  requestCalendarSyncMock: vi.fn(),
}));

vi.mock("./use-calendar-sync", () => ({
  requestCalendarSync: () => requestCalendarSyncMock(),
}));

vi.mock("../lib/pomodoro/sound", () => ({
  unlockPomodoroSound: vi.fn(async () => undefined),
  playPomodoroChime: vi.fn(async () => undefined),
  notifyPomodoroCompletion: notifyCompletion,
  resolvePomodoroChimeVariant: vi.fn(() => "focus"),
}));

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
  focusOnTask: async () => undefined,
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

const MountedGtdView = ({
  repository,
  financeEnabled = false,
  financeNotifyRunout = false,
}: {
  repository: MemoryRepository;
  financeEnabled?: boolean;
  financeNotifyRunout?: boolean;
}) => {
  const calendarDay = useLocalDayReconciliation(repository, financeEnabled, financeNotifyRunout);
  const value = useMemo<AppContextValue>(
    () => ({
      repository,
      settings: defaultAppSettings(),
      updateSettings: (updater) => repository.updateSettings(updater),
      coachService: new CoachPulseService(new FakeProvider()),
      browserPreview: true,
      debugEnabled: false,
      setDebugEnabled: () => undefined,
      pomodoro: idlePomodoro,
      pulseRevision: 0,
      calendarDay,
      reconfigureEmailTriage: async () => undefined,
      llmBridgeStatus: { state: "off" },
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

  it("snapshots account balances today when financeEnabled, and not otherwise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveFinanceAccount({
      id: "",
      name: "Compte cheques",
      institution: null,
      type: "checking",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 100_00,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    });

    render(<MountedGtdView repository={repository} financeEnabled={false} />);
    await flushEffects();
    expect(await repository.listFinanceAccountBalanceSnapshots(account.id)).toEqual([]);

    render(<MountedGtdView repository={repository} financeEnabled />);
    await flushEffects();
    const snapshots = await repository.listFinanceAccountBalanceSnapshots(account.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ asOfDate: "2026-09-07", balanceMinor: 100_00 });
  });

  it("notifies at most once per day for an exhausted envelope when financeNotifyRunout is on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0, 0));
    notifyCompletion.mockClear();

    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveFinanceAccount({
      id: "",
      name: "Compte cheques",
      institution: null,
      type: "checking",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 100_00,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    });
    await repository.seedFinanceDefaultCategories();
    await repository.setFinanceBudgetAssignment("2026-09", "fincat:alimentation.epicerie", 5_000);
    await repository.saveFinanceTransaction({
      id: "",
      accountId: account.id,
      postedDate: "2026-09-07",
      amountMinor: -5_000,
      currency: "CAD",
      descriptionRaw: "IGA",
      descriptionOriginal: null,
      merchantKey: "IGA",
      merchantDisplay: null,
      categoryId: "fincat:alimentation.epicerie",
      categorySource: "default",
      categoryConfidence: null,
      categorizedAt: null,
      personId: null,
      notes: null,
      labelsJson: null,
      pending: false,
      isTransfer: false,
      transferGroupId: null,
      excludedFromBudget: false,
      excludedFromReports: false,
      hasSplits: false,
      importBatchId: null,
      dedupeHash: "dedupe-1",
      sourceRowJson: null,
      createdAt: "",
      updatedAt: "",
    });

    render(<MountedGtdView repository={repository} financeEnabled financeNotifyRunout />);
    await flushEffects();

    // Both the exhausted envelope and the (low-balance) cash runout fire once each.
    expect(notifyCompletion).toHaveBeenCalledTimes(2);
    const notifiedKeys = await repository.listNotifiedFinanceAlertKeys("2026-09-07");
    expect(notifiedKeys).toHaveLength(2);
    expect(notifiedKeys.some((key) => key.startsWith("envelope_exhausted:"))).toBe(true);

    // A second mount (window focus, visibility) on the same day must not re-notify.
    render(<MountedGtdView repository={repository} financeEnabled financeNotifyRunout />);
    await flushEffects();
    expect(notifyCompletion).toHaveBeenCalledTimes(2);
  });

  describe("finance alert notifications across overlapping and repeated passes", () => {
    const seedAccount = (repository: MemoryRepository) =>
      repository.saveFinanceAccount({
        id: "",
        name: "Compte cheques",
        institution: null,
        type: "checking",
        currency: "CAD",
        ownerPersonId: null,
        ownership: "individual",
        onBudget: true,
        closed: false,
        openingBalanceMinor: 1_000_000,
        currentBalanceMinor: null,
        balanceAsOf: null,
        externalKey: null,
        notes: null,
        sortOrder: 0,
        createdAt: "",
        updatedAt: "",
      });

    const exhaustEnvelope = async (repository: MemoryRepository, accountId: string) => {
      await repository.seedFinanceDefaultCategories();
      await repository.setFinanceBudgetAssignment("2026-09", "fincat:alimentation.epicerie", 5_000);
      await repository.saveFinanceTransaction({
        id: "",
        accountId,
        postedDate: "2026-09-07",
        amountMinor: -5_000,
        currency: "CAD",
        descriptionRaw: "IGA",
        descriptionOriginal: null,
        merchantKey: "IGA",
        merchantDisplay: null,
        categoryId: "fincat:alimentation.epicerie",
        categorySource: "default",
        categoryConfidence: null,
        categorizedAt: null,
        personId: null,
        notes: null,
        labelsJson: null,
        pending: false,
        isTransfer: false,
        transferGroupId: null,
        excludedFromBudget: false,
        excludedFromReports: false,
        hasSplits: false,
        importBatchId: null,
        dedupeHash: "dedupe-1",
        sourceRowJson: null,
        createdAt: "",
        updatedAt: "",
      });
    };

    it("sends a single notification when focus and visibility fire while the first pass is in flight", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0, 0));
      notifyCompletion.mockClear();

      const repository = new MemoryRepository();
      await repository.initialize();
      const account = await seedAccount(repository);
      await exhaustEnvelope(repository, account.id);

      render(<MountedGtdView repository={repository} financeEnabled financeNotifyRunout />);
      // Startup pass has not finished; resume events arrive immediately.
      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await flushEffects();

      expect(notifyCompletion).toHaveBeenCalledTimes(1);
      expect(await repository.listNotifiedFinanceAlertKeys("2026-09-07")).toHaveLength(1);
    });

    it("re-evaluates on a later same-day resume and notifies an alert that appeared meanwhile", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 7, 12, 0, 0, 0));
      notifyCompletion.mockClear();

      const repository = new MemoryRepository();
      await repository.initialize();
      const account = await seedAccount(repository);

      render(<MountedGtdView repository={repository} financeEnabled financeNotifyRunout />);
      await flushEffects();
      expect(notifyCompletion).not.toHaveBeenCalled();

      await exhaustEnvelope(repository, account.id);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await flushEffects();

      expect(notifyCompletion).toHaveBeenCalledTimes(1);
      const keys = await repository.listNotifiedFinanceAlertKeys("2026-09-07");
      expect(keys.some((key) => key.startsWith("envelope_exhausted:"))).toBe(true);

      // The ledger still suppresses a repeat on the next resume.
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await flushEffects();
      expect(notifyCompletion).toHaveBeenCalledTimes(1);
    });
  });

  it("nudges the calendar-sync reconciler once per day after promotion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 23, 59, 0, 0));

    const repository = new MemoryRepository();
    await repository.initialize();
    await seedDueTomorrow(repository, "Appelee a minuit");

    render(<MountedGtdView repository={repository} />);
    await flushEffects();
    requestCalendarSyncMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    });
    await flushEffects();

    expect(requestCalendarSyncMock).toHaveBeenCalled();
  });
});
