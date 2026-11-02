// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
// SAFETY: every laptop is an isolated `:memory:` database (see test-support/fake-laptop.ts).
import { startStartupSyncPull } from "./startup-sync";
import { createFakeFolderHost } from "./test-support/fake-folder-host";
import {
  enableFakeLaptop,
  type FakeLaptop,
  GTD_FOLDER,
  openFakeLaptop,
  PERSONAL_FOLDER,
  publishFromFakeLaptop,
} from "./test-support/fake-laptop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const PERSONAL = PERSONAL_FOLDER;
const GTD = GTD_FOLDER;

const world = async () => {
  const host = createFakeFolderHost();
  host.mount(PERSONAL);
  host.mount(GTD);
  const a = await openFakeLaptop(host, 0);
  const b = await openFakeLaptop(host, 1);
  // B has enabled sync and published a task.
  await enableFakeLaptop(b);
  await b.repository.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
  await publishFromFakeLaptop(b);
  const settingsA = await enableFakeLaptop(a);
  return { host, a, b, settingsA };
};

const lane = <T>(work: () => Promise<T>): Promise<T> => work();
const countingLane = () => {
  let calls = 0;
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    calls += 1;
    return work();
  };
  return { run, calls: () => calls };
};
const hasTask = async (laptop: FakeLaptop, id: string) =>
  (await laptop.repository.listTasks({ includeCompleted: true })).some((task) => task.id === id);

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

describe("the startup pull when the gate is closed", () => {
  it("does nothing at all: no engine, no device id read, no folder call, no lane", async () => {
    const { host, a, settingsA } = await world();
    host.calls.length = 0;
    const exclusive = countingLane();
    for (const [debugEnabled, multiDeviceSyncEnabled] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const result = await startStartupSyncPull({
        repository: a.repository,
        settings: { ...settingsA, multiDeviceSyncEnabled },
        debugEnabled,
        runExclusive: exclusive.run,
        deps: a.deps,
      });
      expect(result).toBeNull();
    }
    expect(host.calls).toEqual([]);
    expect(exclusive.calls()).toBe(0);
    expect(a.deps.getDeviceId).toHaveBeenCalledTimes(1); // only the enable above
    expect(await hasTask(a, "from-b")).toBe(false);
  });
});

describe("the startup pull when sync is on", () => {
  it("merges the other laptop's work before returning when the folder answers in time", async () => {
    const { a, settingsA } = await world();
    const exclusive = countingLane();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: exclusive.run,
      deps: a.deps,
    });
    expect(startup?.finished?.ok).toBe(true);
    expect(await hasTask(a, "from-b")).toBe(true);
    expect(exclusive.calls()).toBe(1);
    // The first merge into a database that holds data was backed up once.
    expect(a.backups()).toBe(1);
  });

  it("asks the engine for an UNBUDGETED pull: the wait budget never cuts a merge short", async () => {
    const { a, settingsA } = await world();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: lane,
      deps: a.deps,
    });
    const report = startup?.finished?.ok ? startup.finished.report : null;
    expect(report?.complete).toBe(true);
    expect(report?.remaining).toEqual([]);
    const pull = vi.spyOn(startup!.built.engine, "pull");
    await startup!.built.engine.pull();
    expect(pull).toHaveBeenCalledWith();
  });

  it("carries on when the folder is slow, lets the same pull finish in the background, then merges", async () => {
    const { a, settingsA } = await world();
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listSyncPeers = a.deps.api.listSyncPeers;
    a.deps.api.listSyncPeers = async (...args) => {
      await slow;
      return listSyncPeers(...args);
    };
    const startedAt = Date.now();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: lane,
      deps: a.deps,
      waitBudgetMs: 30,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(startup).not.toBeNull();
    expect(startup?.finished).toBeNull();
    expect(await hasTask(a, "from-b")).toBe(false);

    release();
    const outcome = await startup!.settled;
    expect(outcome.ok).toBe(true);
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("an unreachable folder is a report, never an exception, and merges nothing", async () => {
    const { host, a, settingsA } = await world();
    host.unmount(GTD);
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: lane,
      deps: a.deps,
    });
    expect(startup?.finished?.ok).toBe(true);
    const report = startup?.finished?.ok ? startup.finished.report : null;
    expect(report?.transports.some((transport) => !transport.reachable)).toBe(true);
    expect(await hasTask(a, "from-b")).toBe(false);
  });

  it("a failing lane becomes a failed outcome, not a rejection", async () => {
    const { a, settingsA } = await world();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: () => Promise.reject(new Error("lane broke")),
      deps: a.deps,
    });
    expect(startup?.finished).toMatchObject({ ok: false });
  });

  it("returns null, without throwing, when the engine cannot be built", async () => {
    const { a, settingsA } = await world();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: { ...settingsA, syncGtdFolderDir: "", backupDestinationDir: "" },
      debugEnabled: true,
      runExclusive: lane,
      deps: a.deps,
    });
    expect(startup).toBeNull();
  });

  it("records the safety backup through the binding the hook can replace", async () => {
    const { a, settingsA } = await world();
    const startup = await startStartupSyncPull({
      repository: a.repository,
      settings: settingsA,
      debugEnabled: true,
      runExclusive: lane,
      deps: a.deps,
    });
    const stored = await a.repository.getSettings();
    expect(stored.lastBackupAt).not.toBe("");
    expect(startup?.binding.getSettings()).toBe(settingsA);
  });
});
