import { invoke } from "@tauri-apps/api/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../domain/types";
// SAFETY: in-memory SQLite and an in-memory fake host; `VACUUM INTO` is intercepted.
import { createNodeSqliteDatabase } from "../test/mocks/node-sqlite-database";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { TauriSqliteRepository } from "../lib/storage/tauri-sqlite-repository";
import { createFakeFolderHost } from "../lib/sync/test-support/fake-folder-host";
import { harnessDeviceId } from "../lib/sync/test-support/two-device-harness";
import { buildSyncEngine, enableSync, type SyncServiceDeps } from "../lib/sync/sync-service";
import { useMultiDeviceSync } from "./use-multi-device-sync";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const PERSONAL = "/Drive/Perso";
const GTD = "/Drive/Shared/GTD";

const setup = async () => {
  const host = createFakeFolderHost();
  host.mount(PERSONAL);
  host.mount(GTD);
  const raw = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "execute") {
        return (query: string, ...rest: unknown[]) =>
          query.startsWith("VACUUM INTO")
            ? Promise.resolve({ rowsAffected: 0 })
            : (target.execute as (...args: unknown[]) => Promise<unknown>)(query, ...rest);
      }
      return (target as never as Record<string | symbol, unknown>)[property];
    },
  });
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  await repository.updateSettings((current) => ({
    ...current,
    backupDestinationDir: PERSONAL,
    syncGtdFolderDir: GTD,
    syncDeviceName: "Portable test",
  }));
  const deps: SyncServiceDeps = {
    api: host.api,
    getDeviceId: async () => harnessDeviceId(0),
    getAppVersion: async () => "0.2.0-test",
    now: Date.now,
  };
  const published: AppSettings[] = [];
  /** Calls whose updater returns the settings unchanged: the republish after a merge. */
  const counts = { republishes: 0 };
  const hook = renderHook(() =>
    useMultiDeviceSync(repository, {
      browserPreview: false,
      getSettings: () => current,
      updateSettings: async (updater) => {
        const probe = {} as AppSettings;
        if (updater(probe) === probe) counts.republishes += 1;
        const next = await repository.updateSettings(updater);
        current = next;
        published.push(next);
        return next;
      },
      deps,
    }),
  );
  let current = await repository.getSettings();
  return { host, repository, raw, hook, deps, published, counts, settings: () => current };
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "resolve_storage_paths") {
      return { databasePath: "/x", connectionString: "sqlite:x", environment: "production" };
    }
    if (command === "ensure_backup_dir") return `${PERSONAL}/backups`;
    if (command === "prune_backups") return { deletedPaths: [], failed: [], keptCount: 1 };
    throw new Error(`unexpected command ${command}`);
  });
});

describe("useMultiDeviceSync", () => {
  it("starts idle and does nothing by itself", async () => {
    const { host, hook } = await setup();
    expect(hook.result.current).toMatchObject({
      supported: true,
      phase: "idle",
      status: null,
      run: null,
      setupError: null,
    });
    expect(host.calls).toEqual([]);
  });

  it("enables, then reads the status, then runs Sync now and keeps the report", async () => {
    const { host, hook, settings, repository } = await setup();
    await repository.createTask({ id: "t1", title: "A task", bucket: "inbox" });

    await act(async () => {
      await hook.result.current.enable();
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.setupError).toBeNull();
    expect(hook.result.current.enableResult).toMatchObject({
      identity: { created: true, repaired: false },
      capture: { installed: true },
    });
    expect(settings().multiDeviceSyncEnabled).toBe(true);
    expect(hook.result.current.status).toMatchObject({ ready: true, peers: [] });

    await act(async () => {
      await hook.result.current.syncNow();
    });
    const run = hook.result.current.run;
    expect(run?.error).toBeNull();
    expect(run?.report?.publish.domains.map((domain) => [domain.domain, domain.outcome])).toEqual([
      ["gtd", "published"],
      ["personal", "published"],
      ["finance", "published"],
    ]);
    expect(hook.result.current.status?.pendingChanges).toBe(0);
    expect(host.filesOf(GTD).some((file) => file.endsWith("gtd-1.bundle"))).toBe(true);
  });

  it("shows an interrupted backfill after a restart and resumes it, then turns sync on", async () => {
    const { hook, settings, repository, raw } = await setup();
    // More rows than one default chunk (1,000 rows): the enable needs several writer slots.
    await raw.execute("BEGIN");
    for (let i = 0; i < 2300; i += 1) {
      await raw.execute(
        "INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, created_at, updated_at) VALUES ($1, 'T', '', 'open', 'inbox', '[]', 'manual', 'x', 'x')",
        [`bulk-${i}`],
      );
    }
    await raw.execute("COMMIT");

    // The enable dies after the first chunks (a crash, or the app is quit).
    const original = repository.continueSyncCaptureBackfill.bind(repository);
    let calls = 0;
    repository.continueSyncCaptureBackfill = async (options) => {
      calls += 1;
      if (calls > 1) throw new Error("the app quit");
      return original(options);
    };
    await act(async () => {
      await hook.result.current.enable();
    });
    expect(hook.result.current.setupError?.code).toBe("capture_failed");
    expect(settings().multiDeviceSyncEnabled).toBe(false);
    expect(hook.result.current.backfill).not.toBeNull();
    expect(hook.result.current.backfill?.percent).toBeGreaterThan(0);
    expect(hook.result.current.backfill?.percent).toBeLessThan(100);

    // A later session: the page reads the unfinished pass, and resuming finishes the enable.
    repository.continueSyncCaptureBackfill = original;
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.backfill).not.toBeNull();
    await act(async () => {
      await hook.result.current.resumeBackfill();
    });
    expect(hook.result.current.setupError).toBeNull();
    expect(hook.result.current.backfill).toBeNull();
    expect(settings().multiDeviceSyncEnabled).toBe(true);
    expect(await repository.getSyncStatus()).toMatchObject({ backfillComplete: true });
  });

  it("resumes only the chunks when sync is already on", async () => {
    const { hook, settings, repository } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });
    expect(settings().multiDeviceSyncEnabled).toBe(true);
    // A new verifying pass was started elsewhere and left unfinished.
    await repository.enableSyncCapture({ limits: { rowsPerChunk: 1 } });
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.status?.backfill.complete).toBe(false);
    expect(hook.result.current.status?.ready).toBe(false);
    await act(async () => {
      await hook.result.current.resumeBackfill();
    });
    expect(hook.result.current.backfill).toBeNull();
    expect(hook.result.current.status?.backfill.complete).toBe(true);
    expect(hook.result.current.status?.ready).toBe(true);
  });

  it("ignores another action while one is running", async () => {
    const { hook, settings, host, deps } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });
    expect(settings().multiDeviceSyncEnabled).toBe(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = deps.api.publishSyncBundle;
    deps.api.publishSyncBundle = async (input) => {
      await gate;
      return publish(input);
    };
    host.calls.length = 0;

    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = hook.result.current.syncNow();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("syncing"));
    await act(async () => {
      await hook.result.current.enable();
      await hook.result.current.disable();
      await hook.result.current.recheckFolders();
    });
    // None of them ran: no folder was prepared, and the setting is untouched.
    expect(host.calls.filter((call) => call.command === "prepare")).toEqual([]);
    expect(settings().multiDeviceSyncEnabled).toBe(true);
    expect(hook.result.current.phase).toBe("syncing");

    release();
    await act(async () => {
      await running;
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.run?.report).not.toBeNull();
  });

  it("republishes the merged settings after a run that applied rows, and only then", async () => {
    const { hook, host, counts } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });

    // A second laptop publishes a task into the shared folders.
    const peerDb = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
    const peer = new TauriSqliteRepository("sqlite::memory:", async () => peerDb);
    await peer.initialize();
    const peerSettings = {
      ...(await peer.getSettings()),
      backupDestinationDir: PERSONAL,
      syncGtdFolderDir: GTD,
      syncDeviceName: "Pair",
    };
    await peer.updateSettings(() => peerSettings);
    const peerDeps: SyncServiceDeps = {
      api: host.api,
      getDeviceId: async () => harnessDeviceId(1),
      getAppVersion: async () => "0.2.0-test",
      now: Date.now,
    };
    await peer.createTask({ id: "from-peer", title: "From the peer", bucket: "inbox" });
    await enableSync({
      repository: peer,
      settings: peerSettings,
      updateSettings: (updater) => peer.updateSettings(updater),
      deps: peerDeps,
    });
    const peerEngine = await buildSyncEngine({
      repository: peer,
      settings: peerSettings,
      getSettings: () => peerSettings,
      deps: peerDeps,
    });
    await peerEngine.engine.publish();

    const before = counts.republishes;
    await act(async () => {
      await hook.result.current.syncNow();
    });
    const totals = hook.result.current.run?.report?.pull.totals;
    expect(totals?.applied).toBeGreaterThan(0);
    expect(counts.republishes).toBe(before + 1);

    // Nothing new to merge: no republish.
    await act(async () => {
      await hook.result.current.syncNow();
    });
    expect(hook.result.current.run?.report?.pull.totals.applied).toBe(0);
    expect(counts.republishes).toBe(before + 1);
  });

  it("surfaces an enabling failure and leaves sync disabled", async () => {
    const { hook, host, settings } = await setup();
    host.failNext("prepare", "role_mismatch", "that is a personal folder");
    await act(async () => {
      await hook.result.current.enable();
    });
    expect(hook.result.current.setupError).toMatchObject({
      code: "folder_rejected",
      role: "gtd",
    });
    expect(hook.result.current.phase).toBe("idle");
    expect(settings().multiDeviceSyncEnabled).toBe(false);
    expect(hook.result.current.enableStep).toBeNull();
  });

  it("surfaces a configuration error of a later run as an issue, and keeps going", async () => {
    const { hook, host } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });
    host.failNext("list", "role_mismatch", "that folder is a backup folder");
    await act(async () => {
      await hook.result.current.syncNow();
    });
    const issues = hook.result.current.status?.issues ?? [];
    expect(issues).toContainEqual(
      expect.objectContaining({ code: "transport_failed", detail: "configuration" }),
    );
  });

  it("becomes unsupported when the repository cannot sync (startup fallback)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const hook = renderHook(() =>
      useMultiDeviceSync(repository, {
        browserPreview: false,
        getSettings: () => ({}) as AppSettings,
        updateSettings: async () => ({}) as AppSettings,
      }),
    );
    await act(async () => {
      await hook.result.current.enable();
    });
    expect(hook.result.current.supported).toBe(false);
    expect(hook.result.current.setupError?.code).toBe("unsupported_preview");
  });

  it("is unsupported from the start in browser preview", () => {
    const hook = renderHook(() =>
      useMultiDeviceSync(null, {
        browserPreview: true,
        getSettings: () => ({}) as AppSettings,
        updateSettings: async () => ({}) as AppSettings,
      }),
    );
    expect(hook.result.current.supported).toBe(false);
  });

  it("disables by flipping only the setting", async () => {
    const { hook, settings, repository } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });
    await act(async () => {
      await hook.result.current.disable();
    });
    expect(settings().multiDeviceSyncEnabled).toBe(false);
    expect(hook.result.current.status).toBeNull();
    expect(await repository.getSyncStatus()).toMatchObject({
      identity: { deviceName: "Portable test" },
      captureEnabled: true,
    });
  });

  it("re-checks the folders and rebuilds the engine", async () => {
    const { hook, host } = await setup();
    await act(async () => {
      await hook.result.current.enable();
    });
    host.calls.length = 0;
    await act(async () => {
      await hook.result.current.recheckFolders();
    });
    expect(
      host.calls.filter((call) => call.command === "prepare").map((call) => call.role),
    ).toEqual(["gtd", "personal"]);
    await waitFor(() => expect(hook.result.current.phase).toBe("idle"));
  });
});
