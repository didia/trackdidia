import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { BOOTSTRAP_TIMEOUT_MS, useBootstrap } from "./use-bootstrap";

const factory = vi.hoisted(() => ({
  createRepository: vi.fn<() => Promise<unknown>>(),
}));

const startup = vi.hoisted(() => ({
  startStartupSyncPull: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("../lib/sync/startup-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sync/startup-sync")>()),
  startStartupSyncPull: (input: Record<string, unknown>) => startup.startStartupSyncPull(input),
}));

vi.mock("../lib/storage/factory", () => ({
  isTauriRuntime: () => false,
  createRepository: () => factory.createRepository(),
}));

describe("useBootstrap", () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof import("../lib/sync/startup-sync")>(
      "../lib/sync/startup-sync",
    );
    startup.startStartupSyncPull.mockReset();
    startup.startStartupSyncPull.mockImplementation((input) =>
      real.startStartupSyncPull(input as never),
    );
  });

  afterEach(() => {
    factory.createRepository.mockReset();
    vi.useRealTimers();
  });

  it("exposes the bootstrapped repository without a warning on success", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    factory.createRepository.mockResolvedValue(repository);

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBe(repository);
    expect(result.current.startupError).toBeNull();
    expect(result.current.settings.gtdReferencesMigrationDoneAt).not.toBe("");
  });

  it("activates the in-memory fallback with a warning when startup throws", async () => {
    factory.createRepository.mockRejectedValue(new Error("sqlite exploded"));

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.startupError).toBe("sqlite exploded");
    expect(result.current.settings.syncProfile).toBe("work");
  });

  it("activates the fallback when a step of bootstrapApplication throws", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "reconcileDay").mockRejectedValue(new Error("step failed"));
    factory.createRepository.mockResolvedValue(repository);

    const { result } = renderHook(() => useBootstrap());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.repository).not.toBe(repository);
    expect(result.current.startupError).toBe("step failed");
    expect(result.current.settings.syncProfile).toBe("personal");
    expect((await result.current.repository!.getSettings()).syncProfile).toBe("personal");
  });

  it("activates the fallback after the eight-second timeout and names the stage", async () => {
    vi.useFakeTimers();
    factory.createRepository.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useBootstrap());
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS - 1);
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.repository).toBeInstanceOf(MemoryRepository);
    expect(result.current.startupError).toContain("Création du repository");
  });

  it("replaces the timeout fallback when repository startup later succeeds", async () => {
    vi.useFakeTimers();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.updateSettings((current) => ({ ...current, syncProfile: "personal" }));
    let resolveRepository!: (repository: MemoryRepository) => void;
    factory.createRepository.mockReturnValue(
      new Promise((resolve) => {
        resolveRepository = resolve;
      }),
    );

    const { result } = renderHook(() => useBootstrap());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS + 1);
    });
    expect(result.current.repository).not.toBe(repository);
    expect(result.current.settings.syncProfile).toBe("work");
    expect(result.current.startupError).not.toBeNull();

    await act(async () => {
      resolveRepository(repository);
    });
    expect(result.current.repository).toBe(repository);
    expect(result.current.settings.syncProfile).toBe("personal");
    expect(result.current.settings.gtdReferencesMigrationDoneAt).not.toBe("");
    expect(result.current.startupError).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not let a slow fallback overwrite a recovered repository", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    let resolveRepository!: (repository: MemoryRepository) => void;
    factory.createRepository.mockReturnValue(
      new Promise((resolve) => {
        resolveRepository = resolve;
      }),
    );
    let releaseFallback!: () => void;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    const original = MemoryRepository.prototype.initialize;
    const fallbackInit = vi
      .spyOn(MemoryRepository.prototype, "initialize")
      .mockImplementation(async function (this: MemoryRepository) {
        await fallbackGate;
        await original.call(this);
      });
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useBootstrap());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS);
      });
      expect(fallbackInit).toHaveBeenCalled();
      await act(async () => {
        resolveRepository(repository);
      });
      expect(result.current.repository).toBe(repository);
      expect(result.current.startupError).toBeNull();
      await act(async () => {
        releaseFallback();
      });
      expect(result.current.repository).toBe(repository);
      expect(result.current.startupError).toBeNull();
    } finally {
      fallbackInit.mockRestore();
    }
  });

  describe("first-run profile", () => {
    const fresh = async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      vi.spyOn(repository, "inspectSyncProfileData").mockResolvedValue({
        counts: { gtd: 0, personal: 0, finance: 0 },
        exact: false,
        sources: [],
      });
      factory.createRepository.mockResolvedValue(repository);
      return repository;
    };

    it("waits before generators, persists a personal choice, and completes", async () => {
      const repository = await fresh();
      const draw = vi.spyOn(repository, "generateDailyRelationshipTasks");
      const reconcile = vi.spyOn(repository, "reconcileDay");
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await waitFor(() => expect(result.current.profileChoice).not.toBeNull());
      expect(draw).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.profileChoice!.choose("personal");
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect((await repository.getSettings()).profileDecisionMadeAt).not.toBe("");
      expect(draw).toHaveBeenCalled();
    });

    it("does not spend the startup timeout while waiting for a choice", async () => {
      await fresh();
      vi.useFakeTimers();
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.profileChoice).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS * 2);
      });
      expect(result.current.startupError).toBeNull();
      expect(result.current.profileChoice).not.toBeNull();
      await act(async () => {
        await result.current.profileChoice!.choose("personal");
      });
      expect(result.current.loading).toBe(false);
    });

    it("recovers after a late repository and still asks before creating data", async () => {
      const repository = await fresh();
      let release!: (repository: MemoryRepository) => void;
      factory.createRepository.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      vi.useFakeTimers();
      const draw = vi.spyOn(repository, "generateDailyRelationshipTasks");
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS);
      });
      expect(result.current.startupError).not.toBeNull();
      expect(result.current.settings.syncProfile).toBe("work");
      await act(async () => {
        release(repository);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.profileChoice).not.toBeNull();
      expect(draw).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.profileChoice!.choose("personal");
      });
      expect(result.current.repository).toBe(repository);
      expect(result.current.startupError).toBeNull();
    });

    it("ignores the cancelled StrictMode effect when its inspection finishes last", async () => {
      const stale = await fresh();
      const active = await fresh();
      let finishStale!: (repository: MemoryRepository) => void;
      factory.createRepository
        .mockReset()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finishStale = resolve;
          }),
        )
        .mockResolvedValueOnce(active);
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }), {
        wrapper: StrictMode,
      });
      await waitFor(() => expect(result.current.profileChoice).not.toBeNull());
      await act(async () => {
        finishStale(stale);
      });
      await act(async () => {
        expect(await result.current.profileChoice!.choose("personal")).toBe(true);
      });
      await waitFor(() => expect(result.current.repository).toBe(active));
    });

    it.each(["hang", "reject"] as const)(
      "keeps fallback or retry available when a late chooser save %s",
      async (failure) => {
        const repository = await fresh();
        let release!: (repository: MemoryRepository) => void;
        factory.createRepository.mockReturnValue(
          new Promise((resolve) => {
            release = resolve;
          }),
        );
        const original = repository.updateSettings.bind(repository);
        vi.spyOn(repository, "updateSettings")
          .mockImplementationOnce(() =>
            failure === "hang"
              ? new Promise(() => undefined)
              : Promise.reject(new Error("disk error")),
          )
          .mockImplementation(original);
        vi.useFakeTimers();
        const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS);
        });
        await act(async () => {
          release(repository);
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.profileChoice).not.toBeNull();
        if (failure === "hang") {
          act(() => {
            void result.current.profileChoice!.choose("personal");
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS);
          });
          expect(result.current.profileChoice).toBeNull();
          expect(result.current.startupError).not.toBeNull();
        } else {
          await act(async () => {
            expect(await result.current.profileChoice!.choose("personal")).toBe(false);
          });
          expect(result.current.profileChoice?.error).toBe("disk error");
          expect(result.current.profileChoice?.busy).toBe(false);
          await act(async () => {
            expect(await result.current.profileChoice!.choose("personal")).toBe(true);
          });
          expect(result.current.repository).toBe(repository);
        }
      },
    );

    it("permits work through the test seam and skips personal jobs", async () => {
      const repository = await fresh();
      const draw = vi.spyOn(repository, "generateDailyRelationshipTasks");
      const relocate = vi.spyOn(repository, "relocateDimancheNotesOnce");
      const { result } = renderHook(() =>
        useBootstrap({ inspectFirstRun: true, workProfileSelectable: true }),
      );
      await waitFor(() => expect(result.current.profileChoice).not.toBeNull());
      await act(async () => {
        await result.current.profileChoice!.choose("work");
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.settings.syncProfile).toBe("work");
      expect(draw).not.toHaveBeenCalled();
      expect(relocate).not.toHaveBeenCalled();
    });

    it("does not prompt an initialized legacy user", async () => {
      const repository = await fresh();
      await repository.updateSettings((current) => ({
        ...current,
        gtdReferencesMigrationDoneAt: "legacy",
      }));
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.profileChoice).toBeNull();
      expect(repository.inspectSyncProfileData).not.toHaveBeenCalled();
    });

    it("does not prompt when inspection finds data on an unmarked installation", async () => {
      const repository = await fresh();
      vi.mocked(repository.inspectSyncProfileData).mockResolvedValue({
        counts: { gtd: 1, personal: 0, finance: 0 },
        exact: false,
        sources: [],
      });
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.profileChoice).toBeNull();
    });

    it("accepts the work profile on a fresh installation without the test seam", async () => {
      const repository = await fresh();
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await waitFor(() => expect(result.current.profileChoice).not.toBeNull());
      let selected = true;
      await act(async () => {
        selected = await result.current.profileChoice!.choose("work");
      });
      expect(selected).toBe(true);
      const settings = await repository.getSettings();
      expect(settings.syncProfile).toBe("work");
      expect(settings.profileDecisionMadeAt).not.toBe("");
      expect(result.current.profileChoice).toBeNull();
    });

    it("reports a failed choice and allows retry", async () => {
      const repository = await fresh();
      const original = repository.updateSettings.bind(repository);
      vi.spyOn(repository, "updateSettings")
        .mockRejectedValueOnce(new Error("disk error"))
        .mockImplementation(original);
      const { result } = renderHook(() => useBootstrap({ inspectFirstRun: true }));
      await waitFor(() => expect(result.current.profileChoice).not.toBeNull());
      await act(async () => {
        await result.current.profileChoice!.choose("personal");
      });
      expect(result.current.profileChoice?.error).toBe("disk error");
      await act(async () => {
        await result.current.profileChoice!.choose("personal");
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.startupError).toBeNull();
    });
  });

  describe("multi-device sync at startup", () => {
    const repositoryWithSync = async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
      factory.createRepository.mockResolvedValue(repository);
      return repository;
    };

    it("starts no sync and exposes none when the setting is off", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      factory.createRepository.mockResolvedValue(repository);
      const sync = vi.spyOn(repository, "getSyncStatus");

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.startupSync).toBeNull();
      expect(sync).not.toHaveBeenCalled();
      expect(result.current.startupError).toBeNull();
    });

    it("is not an error to have sync on in the browser preview: nothing to sync, no fallback", async () => {
      const repository = await repositoryWithSync();

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.repository).toBe(repository);
      expect(result.current.startupError).toBeNull();
      expect(result.current.startupSync).toBeNull();
    });

    it("hands the pull to bootstrap with the app's lane and the debug flag, before generators", async () => {
      const repository = await repositoryWithSync();
      const reconcileDay = repository.reconcileDay.bind(repository);
      const order: string[] = [];
      vi.spyOn(repository, "reconcileDay").mockImplementation(async (...args) => {
        order.push("reconcileDay");
        return reconcileDay(...args);
      });
      const lane = <T,>(work: () => Promise<T>): Promise<T> => work();
      const fake = { key: "k", startedAtMs: 1, finished: { ok: true, report: {} } };
      let bootstrapSettled: Promise<void> = Promise.resolve();
      startup.startStartupSyncPull.mockImplementation(async (input) => {
        order.push("sync");
        expect(input.runExclusive).toBe(lane);
        expect(input.debugEnabled).toBe(true);
        // The 8-second rule's deadline and "bootstrap is over" are handed on, so the pull's wait is
        // bounded by what bootstrap has left and its writes can be held back until bootstrap ends.
        const deadline = input.bootstrapDeadlineAtMs as number;
        expect(deadline - Date.now()).toBeGreaterThan(BOOTSTRAP_TIMEOUT_MS - 2_000);
        expect(deadline - Date.now()).toBeLessThanOrEqual(BOOTSTRAP_TIMEOUT_MS);
        bootstrapSettled = input.bootstrapSettled as Promise<void>;
        let released = false;
        void bootstrapSettled.then(() => {
          released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        return fake;
      });

      const { result } = renderHook(() => useBootstrap({ runExclusive: lane }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(order).toEqual(["sync", "reconcileDay"]);
      expect(result.current.startupSync).toBe(fake);
      // Bootstrap is over: whatever was held back for it may go on.
      await expect(bootstrapSettled).resolves.toBeUndefined();
    });

    it("shows no sync stage and starts nothing when the setting is off", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      factory.createRepository.mockResolvedValue(repository);
      const stages: string[] = [];
      const log = await import("../lib/debug");
      const spy = vi.spyOn(log, "logDebug").mockImplementation((_level, scope, message) => {
        if (scope === "app.bootstrap") stages.push(String(message));
        return undefined as never;
      });

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      spy.mockRestore();
      expect(stages).not.toContain("Synchronisation avec les autres ordinateurs");
      expect(startup.startStartupSyncPull).not.toHaveBeenCalled();
    });

    it("shows the sync stage when the gate is open", async () => {
      await repositoryWithSync();
      startup.startStartupSyncPull.mockResolvedValue(null);
      const stages: string[] = [];
      const log = await import("../lib/debug");
      const spy = vi.spyOn(log, "logDebug").mockImplementation((_level, scope, message) => {
        if (scope === "app.bootstrap") stages.push(String(message));
        return undefined as never;
      });

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      spy.mockRestore();
      expect(stages).toContain("Synchronisation avec les autres ordinateurs");
    });

    it("carries on at once when the pull is still running in the background", async () => {
      await repositoryWithSync();
      const fake = {
        key: "k",
        startedAtMs: 1,
        finished: null,
        settled: new Promise(() => undefined),
      };
      startup.startStartupSyncPull.mockResolvedValue(fake);

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.startupError).toBeNull();
      expect(result.current.startupSync).toBe(fake);
    });

    it("a sync that throws never activates the in-memory fallback", async () => {
      const repository = await repositoryWithSync();
      startup.startStartupSyncPull.mockRejectedValue(new Error("folder exploded"));

      const { result } = renderHook(() => useBootstrap({ runExclusive: (work) => work() }));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.repository).toBe(repository);
      expect(result.current.startupError).toBeNull();
      expect(result.current.startupSync).toBeNull();
    });
  });
});
