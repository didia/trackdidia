import { act, renderHook, waitFor } from "@testing-library/react";
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
