import { invoke } from "@tauri-apps/api/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../domain/types";
import { startStartupSyncPull } from "../lib/sync/startup-sync";
import { syncEngineKeyOf } from "../lib/sync/sync-service";
import {
  createFakeFolderHost,
  type FakeFolderHost,
} from "../lib/sync/test-support/fake-folder-host";
import {
  enableFakeLaptop,
  type FakeLaptop,
  GTD_FOLDER,
  openFakeLaptop,
  PERSONAL_FOLDER,
  publishFromFakeLaptop,
} from "../lib/sync/test-support/fake-laptop";
import type { QuitWindow } from "../lib/sync/quit-publish";
import { SYNC_RESUME_PULL_DEBOUNCE_MS } from "../lib/sync/lifecycle-policy";
import { type UseMultiDeviceSyncOptions, useMultiDeviceSync } from "./use-multi-device-sync";

// SAFETY: in-memory SQLite (`createNodeSqliteDatabase`) and an in-memory fake host only.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** What the automatic triggers look like from the outside: window events, timers, folder calls. */
const spies = () => {
  const windowAdd = vi.spyOn(window, "addEventListener");
  const windowRemove = vi.spyOn(window, "removeEventListener");
  const documentAdd = vi.spyOn(document, "addEventListener");
  const documentRemove = vi.spyOn(document, "removeEventListener");
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  const syncEvents = ["focus", "blur", "visibilitychange"];
  return {
    listenersAdded: () =>
      [...windowAdd.mock.calls, ...documentAdd.mock.calls].filter(([type]) =>
        syncEvents.includes(String(type)),
      ).length,
    listenersRemoved: () =>
      [...windowRemove.mock.calls, ...documentRemove.mock.calls].filter(([type]) =>
        syncEvents.includes(String(type)),
      ).length,
    intervalDelays: () => setIntervalSpy.mock.calls.map(([, delay]) => delay),
    intervalsCleared: () => clearIntervalSpy.mock.calls.length,
  };
};

interface Session {
  host: FakeFolderHost;
  a: FakeLaptop;
  b: FakeLaptop;
  store: { current: AppSettings };
  changed: { count: number };
  lane: { calls: number };
  close: { current: (() => Promise<void>) | null };
  quitWindow: () => Promise<QuitWindow>;
}

const session = async (): Promise<Session> => {
  const host = createFakeFolderHost();
  host.mount(PERSONAL_FOLDER);
  host.mount(GTD_FOLDER);
  const a = await openFakeLaptop(host, 0);
  const b = await openFakeLaptop(host, 1);
  await enableFakeLaptop(b);
  await enableFakeLaptop(a);
  const close: Session["close"] = { current: null };
  return {
    host,
    a,
    b,
    store: { current: await a.settings() },
    changed: { count: 0 },
    lane: { calls: 0 },
    close,
    quitWindow: async () => ({
      onCloseRequested: async (handler) => {
        close.current = async () => {
          await handler({ preventDefault: () => undefined });
        };
        return () => {
          close.current = null;
        };
      },
    }),
  };
};

interface Props {
  automationKey: string | null;
  startupSync?: UseMultiDeviceSyncOptions["startupSync"];
}

const mount = (s: Session, initial: Props, options: { strict?: boolean } = {}) =>
  renderHook(
    (props: Props) =>
      useMultiDeviceSync(s.a.repository, {
        browserPreview: false,
        getSettings: () => s.store.current,
        updateSettings: async (updater) => {
          s.store.current = await s.a.repository.updateSettings(updater);
          return s.store.current;
        },
        deps: s.a.deps,
        automationKey: props.automationKey,
        startupSync: props.startupSync ?? null,
        runExclusive: (work) => {
          s.lane.calls += 1;
          return work();
        },
        onDataChanged: () => {
          s.changed.count += 1;
        },
        quitWindow: s.quitWindow,
      }),
    { initialProps: initial, ...(options.strict ? { wrapper: StrictMode } : {}) },
  );

const hasTask = async (laptop: FakeLaptop, id: string) =>
  (await laptop.repository.listTasks({ includeCompleted: true })).some((task) => task.id === id);

const focus = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const blur = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const publishCalls = (host: FakeFolderHost) =>
  host.calls.filter((call) => call.command === "publish").length;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "resolve_storage_paths") {
      return { databasePath: "/x", connectionString: "sqlite:x", environment: "production" };
    }
    if (command === "ensure_backup_dir") return `${PERSONAL_FOLDER}/backups`;
    if (command === "prune_backups") return { deletedPaths: [], failed: [], keptCount: 1 };
    throw new Error(`unexpected command ${command}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("with automation off, sync adds no listener, no timer and no pull", () => {
  it("registers nothing and touches no folder while the app is used", async () => {
    const s = await session();
    const watch = spies();
    const hook = mount(s, { automationKey: null });
    await s.b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await publishFromFakeLaptop(s.b);
    await s.a.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    s.host.calls.length = 0;

    await focus();
    await blur();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(watch.listenersAdded()).toBe(0);
    expect(
      watch.intervalDelays().filter((delay) => delay === 15_000 || delay === 3_600_000),
    ).toEqual([]);
    expect(s.host.calls).toEqual([]);
    expect(s.lane.calls).toBe(0);
    expect(s.changed.count).toBe(0);
    expect(await hasTask(s.a, "from-b")).toBe(false);
    expect(hook.result.current.chip.state).toBe("idle");
    hook.unmount();
  });

  it("closing the window is not intercepted", async () => {
    const s = await session();
    const hook = mount(s, { automationKey: null });
    await act(async () => undefined);
    expect(s.close.current).toBeNull();
    hook.unmount();
  });
});

describe("with automation on", () => {
  const key = async (s: Session) => syncEngineKeyOf(await s.a.settings());

  it("listens to focus, blur and visibility, arms the poll and the hourly pull, and removes them all", async () => {
    const s = await session();
    const watch = spies();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(watch.listenersAdded()).toBe(3));
    expect(watch.intervalDelays()).toEqual(expect.arrayContaining([15_000, 3_600_000]));
    await waitFor(() => expect(s.close.current).not.toBeNull());

    hook.unmount();
    expect(watch.listenersRemoved()).toBe(3);
    expect(watch.intervalsCleared()).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(s.close.current).toBeNull());
  });

  it("turning the key to null tears everything down", async () => {
    const s = await session();
    const watch = spies();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(watch.listenersAdded()).toBe(3));
    hook.rerender({ automationKey: null });
    expect(watch.listenersRemoved()).toBe(3);
    s.host.calls.length = 0;
    await focus();
    expect(s.host.calls).toEqual([]);
    hook.unmount();
  });

  it("pulls on focus, merges the other laptop's work and tells the app to reload", async () => {
    const s = await session();
    await s.b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await publishFromFakeLaptop(s.b);
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());

    await focus();
    await waitFor(() => expect(s.changed.count).toBe(1));
    expect(await hasTask(s.a, "from-b")).toBe(true);
    expect(s.lane.calls).toBeGreaterThan(0);
    await waitFor(() => expect(hook.result.current.chip.state).toBe("idle"));
    expect(hook.result.current.chip.lastOkAtMs).not.toBeNull();

    // Another focus right away is debounced: no new pull.
    s.host.calls.length = 0;
    await focus();
    expect(s.host.calls).toEqual([]);
    hook.unmount();
  });

  it("publishes pending changes when the window loses focus", async () => {
    const s = await session();
    await s.a.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    s.host.calls.length = 0;

    await blur();
    await waitFor(() => expect(publishCalls(s.host)).toBeGreaterThan(0));
    await waitFor(async () => {
      const status = await s.a.repository.getSyncStatus();
      expect(status.supported && status.pendingChanges).toBe(0);
    });
    hook.unmount();
  });

  it("publishes pending changes on quit, and the close is never held back by a failure", async () => {
    const s = await session();
    await s.a.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    s.host.calls.length = 0;

    await act(async () => {
      await s.close.current?.();
    });
    expect(publishCalls(s.host)).toBeGreaterThan(0);

    // Folder gone: the close handler still returns.
    await s.a.repository.createTask({ id: "later", title: "Later", bucket: "inbox" });
    s.host.unmount(GTD_FOLDER);
    await act(async () => {
      await s.close.current?.();
    });
    hook.unmount();
  });

  it("an unreachable folder shows an error chip, holds the automatic publish back, and Sync now recovers", async () => {
    const s = await session();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    s.host.unmount(GTD_FOLDER);

    await focus();
    await waitFor(() => expect(hook.result.current.chip.state).toBe("error"));
    expect(hook.result.current.chip.retryAtMs).not.toBeNull();

    // Inside the backoff nothing automatic is attempted, even with a pending change.
    await s.a.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    s.host.calls.length = 0;
    await blur();
    expect(s.host.calls).toEqual([]);

    // The folder is back; Sync now always runs and lifts the backoff.
    s.host.mount(GTD_FOLDER);
    s.host.calls.length = 0;
    await act(async () => {
      await s.a.repository.updateSettings((current) => current);
      await hook.result.current.recheckFolders();
    });
    await act(async () => {
      await hook.result.current.syncNow();
    });
    expect(hook.result.current.run?.error).toBeNull();
    await waitFor(() => expect(hook.result.current.chip.state).toBe("idle"));
    expect(publishCalls(s.host)).toBeGreaterThan(0);
    hook.unmount();
  });

  it("a failing folder never throws into the app and never sets a setup error", async () => {
    const s = await session();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    s.host.unmount(GTD_FOLDER);
    s.host.unmount(PERSONAL_FOLDER);
    await focus();
    await waitFor(() => expect(hook.result.current.chip.state).toBe("error"));
    expect(hook.result.current.setupError).toBeNull();
    hook.unmount();
  });

  it("Sync now waits for an automatic run in flight instead of being refused", async () => {
    const s = await session();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = s.a.deps.api.listSyncPeers;
    s.a.deps.api.listSyncPeers = async (...args) => {
      await gate;
      return list(...args);
    };
    await focus();
    await waitFor(() => expect(hook.result.current.chip.state).toBe("syncing"));

    let manual: Promise<void> = Promise.resolve();
    act(() => {
      manual = hook.result.current.syncNow();
    });
    await act(async () => {
      release();
      await manual;
    });
    expect(hook.result.current.run?.report).not.toBeNull();
    expect(hook.result.current.run?.error).toBeNull();
    hook.unmount();
  });

  it("does not start while a manual action is running", async () => {
    const s = await session();
    const hook = mount(s, { automationKey: await key(s) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = s.a.deps.api.listSyncPeers;
    s.a.deps.api.listSyncPeers = async (...args) => {
      await gate;
      return list(...args);
    };
    let manual: Promise<void> = Promise.resolve();
    act(() => {
      manual = hook.result.current.syncNow();
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("syncing"));
    const before = s.host.calls.length;
    await focus();
    expect(s.host.calls.length).toBe(before);
    await act(async () => {
      release();
      await manual;
    });
    hook.unmount();
  });
});

describe("the engine built during bootstrap", () => {
  const startup = async (s: Session, waitBudgetMs: number) =>
    startStartupSyncPull({
      repository: s.a.repository,
      settings: s.store.current,
      debugEnabled: true,
      runExclusive: (work) => {
        s.lane.calls += 1;
        return work();
      },
      deps: s.a.deps,
      waitBudgetMs,
    });

  it("becomes the hook's engine: one engine per session, and the chip starts idle after a finished pull", async () => {
    const s = await session();
    await s.b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await publishFromFakeLaptop(s.b);
    const started = await startup(s, 5_000);
    expect(started?.finished?.ok).toBe(true);
    const deviceIdReads = vi.mocked(s.a.deps.getDeviceId).mock.calls.length;

    const hook = mount(s, {
      automationKey: syncEngineKeyOf(s.store.current),
      startupSync: started,
    });
    await waitFor(() => expect(hook.result.current.chip.lastOkAtMs).not.toBeNull());
    expect(hook.result.current.chip.state).toBe("idle");
    // It was in place before any screen existed: no reload is announced.
    expect(s.changed.count).toBe(0);

    await act(async () => {
      await hook.result.current.syncNow();
    });
    // The manual run used the adopted engine; building another would have read the device id again.
    expect(vi.mocked(s.a.deps.getDeviceId).mock.calls.length).toBe(deviceIdReads);
    hook.unmount();
  });

  it("a pull still running after the wait budget shows as syncing, then reloads the screens", async () => {
    const s = await session();
    await s.b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await publishFromFakeLaptop(s.b);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = s.a.deps.api.listSyncPeers;
    s.a.deps.api.listSyncPeers = async (...args) => {
      await gate;
      return list(...args);
    };
    const started = await startup(s, 20);
    expect(started?.finished).toBeNull();

    const hook = mount(s, {
      automationKey: syncEngineKeyOf(s.store.current),
      startupSync: started,
    });
    await waitFor(() => expect(hook.result.current.chip.state).toBe("syncing"));
    // A focus event during the background pull does not start a second one.
    await focus();
    expect(s.changed.count).toBe(0);

    release();
    await waitFor(() => expect(s.changed.count).toBe(1));
    expect(await hasTask(s.a, "from-b")).toBe(true);
    await waitFor(() => expect(hook.result.current.chip.state).toBe("idle"));
    hook.unmount();
  });

  it("under React StrictMode (effects built, dropped and rebuilt) the background pull still reloads the screens once", async () => {
    const s = await session();
    await s.b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await publishFromFakeLaptop(s.b);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = s.a.deps.api.listSyncPeers;
    s.a.deps.api.listSyncPeers = async (...args) => {
      await gate;
      return list(...args);
    };
    const started = await startup(s, 20);
    const hook = mount(
      s,
      { automationKey: syncEngineKeyOf(s.store.current), startupSync: started },
      { strict: true },
    );
    await waitFor(() => expect(hook.result.current.chip.state).toBe("syncing"));
    release();
    await waitFor(() => expect(s.changed.count).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(hook.result.current.chip.state).toBe("idle"));
    expect(s.changed.count).toBe(1);
    expect(await hasTask(s.a, "from-b")).toBe(true);
    hook.unmount();
  });

  it("publishes what bootstrap and the pull left pending, once, at startup", async () => {
    const s = await session();
    await s.a.repository.createTask({ id: "generated", title: "Generated", bucket: "inbox" });
    const started = await startup(s, 5_000);
    s.host.calls.length = 0;
    const hook = mount(s, {
      automationKey: syncEngineKeyOf(s.store.current),
      startupSync: started,
    });
    await waitFor(() => expect(publishCalls(s.host)).toBeGreaterThan(0));
    hook.unmount();
  });

  it("turning sync on in a running session does NOT publish at once: the 2-minute debounce applies", async () => {
    const s = await session();
    await s.a.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    s.host.calls.length = 0;
    const hook = mount(s, { automationKey: syncEngineKeyOf(s.store.current) });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publishCalls(s.host)).toBe(0);
    hook.unmount();
  });

  it("an engine built for other settings is not adopted", async () => {
    const s = await session();
    const started = await startup(s, 5_000);
    const hook = mount(s, { automationKey: "another-key", startupSync: started });
    await waitFor(() => expect(s.close.current).not.toBeNull());
    expect(hook.result.current.chip.lastOkAtMs).toBeNull();
    hook.unmount();
  });
});

describe("constants the docs quote", () => {
  it("resumes at most once per minute", () => {
    expect(SYNC_RESUME_PULL_DEBOUNCE_MS).toBe(60_000);
  });
});
