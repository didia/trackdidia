// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../domain/types";
// SAFETY: every repository here is backed by an isolated `:memory:` database, `VACUUM INTO` is
// intercepted (no backup file is written) and the folders are an in-memory fake host.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "../storage/memory-repository";
import { TauriSqliteRepository } from "../storage/tauri-sqlite-repository";
import { SyncFolderError } from "./folder-api";
import {
  buildSyncEngine,
  disableSync,
  enableSync,
  prepareFolders,
  SyncSetupError,
  type SyncServiceDeps,
  type EnableStep,
} from "./sync-service";
import { createFakeFolderHost, type FakeFolderHost } from "./test-support/fake-folder-host";
import { createFakeClock, harnessDeviceId } from "./test-support/two-device-harness";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const PERSONAL = "/Drive/Perso";
const GTD = "/Drive/Shared/GTD";

interface Laptop {
  name: string;
  deviceId: string;
  repository: TauriSqliteRepository;
  deps: SyncServiceDeps;
  /** "backup" and "apply" in the order they happened. */
  events: string[];
  settings: () => Promise<AppSettings>;
  update: (updater: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  clockAdvance: (ms?: number) => void;
}

const openLaptop = async (host: FakeFolderHost, index: number, name: string): Promise<Laptop> => {
  const raw = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
  const events: string[] = [];
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "execute") {
        return (query: string, ...rest: unknown[]) => {
          if (query.startsWith("VACUUM INTO")) {
            events.push("backup");
            return Promise.resolve({ rowsAffected: 0 });
          }
          return (target.execute as (...args: unknown[]) => Promise<unknown>)(query, ...rest);
        };
      }
      return (target as never as Record<string | symbol, unknown>)[property];
    },
  });
  const clock = createFakeClock();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db, clock.read);
  await repository.initialize();
  const original = repository.applySyncBundle.bind(repository);
  repository.applySyncBundle = async (...args) => {
    events.push("apply");
    return original(...args);
  };
  const deviceId = harnessDeviceId(index);
  await repository.updateSettings((current) => ({
    ...current,
    backupDestinationDir: PERSONAL,
    syncGtdFolderDir: GTD,
    syncDeviceName: name,
  }));
  return {
    name,
    deviceId,
    repository,
    events,
    deps: {
      api: host.api,
      getDeviceId: async () => deviceId,
      getAppVersion: async () => "0.2.0-test",
      now: clock.read,
    },
    settings: () => repository.getSettings(),
    update: (updater) => repository.updateSettings(updater),
    clockAdvance: (ms) => clock.advance(ms),
  };
};

const world = async (count = 1) => {
  const host = createFakeFolderHost();
  host.mount(PERSONAL);
  host.mount(GTD);
  const laptops: Laptop[] = [];
  for (let index = 0; index < count; index += 1) {
    laptops.push(await openLaptop(host, index, `Laptop ${index + 1}`));
  }
  return { host, laptops };
};

const enable = async (laptop: Laptop, onStep?: (step: EnableStep) => void) =>
  enableSync({
    repository: laptop.repository,
    settings: await laptop.settings(),
    updateSettings: laptop.update,
    deps: laptop.deps,
    ...(onStep ? { onStep } : {}),
  });

const setupCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "no error";
  } catch (error) {
    expect(error).toBeInstanceOf(SyncSetupError);
    return (error as SyncSetupError).code;
  }
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

describe("prepareFolders", () => {
  it("prepares the shared folder as gtd and the backup folder as personal, each given the other", async () => {
    const { host } = await world();
    const deps = { api: host.api } as SyncServiceDeps;
    await prepareFolders(
      deps,
      { backupDestinationDir: `${PERSONAL}/`, syncGtdFolderDir: ` ${GTD} ` },
      "production",
    );
    expect(
      host.calls.map(({ command, folderDir, role, detail }) => [command, folderDir, role, detail]),
    ).toEqual([
      // Paths are passed as chosen (only surrounding spaces are trimmed); the host normalizes.
      ["prepare", GTD, "gtd", { otherFolderDir: `${PERSONAL}/` }],
      ["prepare", `${PERSONAL}/`, "personal", { otherFolderDir: GTD }],
    ]);
  });

  it("asks for the missing folders before touching any", async () => {
    const { host } = await world();
    const deps = { api: host.api } as SyncServiceDeps;
    expect(
      await setupCode(
        prepareFolders(deps, { backupDestinationDir: "", syncGtdFolderDir: GTD }, "production"),
      ),
    ).toBe("no_backup_destination");
    expect(
      await setupCode(
        prepareFolders(
          deps,
          { backupDestinationDir: PERSONAL, syncGtdFolderDir: " " },
          "production",
        ),
      ),
    ).toBe("no_gtd_folder");
    expect(host.calls).toEqual([]);
  });

  it("refuses the same folder, or one inside or around the other, without asking the host", async () => {
    const { host } = await world();
    const deps = { api: host.api } as SyncServiceDeps;
    for (const gtd of [
      PERSONAL,
      `${PERSONAL}/`,
      PERSONAL.toUpperCase(),
      `${PERSONAL}/GTD`,
      "/Drive",
    ]) {
      expect(
        await setupCode(
          prepareFolders(
            deps,
            { backupDestinationDir: PERSONAL, syncGtdFolderDir: gtd },
            "production",
          ),
        ),
        gtd,
      ).toBe("folders_overlap");
    }
    expect(host.calls).toEqual([]);
  });

  it("reports which folder the host rejected, and that an absent one is unavailable", async () => {
    const { host } = await world();
    const deps = { api: host.api } as SyncServiceDeps;
    const settings = { backupDestinationDir: PERSONAL, syncGtdFolderDir: GTD };
    host.failNext("prepare", "role_mismatch", "that folder is a personal folder");
    const rejected = await prepareFolders(deps, settings, "production").catch((error) => error);
    expect(rejected).toMatchObject({ code: "folder_rejected", role: "gtd" });
    expect((rejected as SyncSetupError).cause).toBeInstanceOf(SyncFolderError);

    host.unmount(PERSONAL);
    const missing = await prepareFolders(deps, settings, "production").catch((error) => error);
    expect(missing).toMatchObject({ code: "folder_unavailable", role: "personal" });
  });

  it("the host refuses a shared folder that already carries the backup folder's marker", async () => {
    const { host } = await world();
    const deps = { api: host.api } as SyncServiceDeps;
    // The backup folder was prepared as `personal`; pointing the GTD setting at it again overlaps.
    await prepareFolders(
      deps,
      { backupDestinationDir: PERSONAL, syncGtdFolderDir: GTD },
      "production",
    );
    const elsewhere = "/Drive/Other";
    host.mount(elsewhere, { "backups/trackdidia-auto-backup-x.db": "db" });
    expect(
      await setupCode(
        prepareFolders(
          deps,
          { backupDestinationDir: PERSONAL, syncGtdFolderDir: elsewhere },
          "production",
        ),
      ),
    ).toBe("folder_rejected");
  });
});

describe("enableSync", () => {
  it("prepares the folders, identifies the device, captures, then saves the setting", async () => {
    const { host, laptops } = await world();
    const [a] = laptops as [Laptop];
    await a.repository.createTask({ id: "t1", title: "Existing", bucket: "inbox" });
    const steps: EnableStep[] = [];
    const result = await enable(a, (step) => steps.push(step));

    expect(steps).toEqual(["folders", "identity", "capture", "saving"]);
    expect(result.identity).toEqual({
      deviceId: a.deviceId,
      deviceName: "Laptop 1",
      created: true,
      repaired: false,
    });
    expect(result.capture.installed).toBe(true);
    expect(result.capture.backfilled).toBeGreaterThan(0);
    expect(result.capture.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.folders).toEqual({ gtd: GTD, personal: PERSONAL });
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(true);
    expect(host.calls.map((call) => call.role)).toEqual(["gtd", "personal"]);
    expect(await a.repository.getSyncStatus()).toMatchObject({
      supported: true,
      identity: { deviceId: a.deviceId },
      captureEnabled: true,
    });
  });

  it("does not save the setting when a step fails, and can be run again", async () => {
    const { host, laptops } = await world();
    const [a] = laptops as [Laptop];
    host.failNext("prepare", "nested_folder");
    expect(await setupCode(enable(a))).toBe("folder_rejected");
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(false);
    expect(await a.repository.getSyncStatus()).toMatchObject({ identity: null });

    const original = a.repository.enableSyncCapture.bind(a.repository);
    a.repository.enableSyncCapture = async () => {
      throw new Error("disk full");
    };
    expect(await setupCode(enable(a))).toBe("capture_failed");
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(false);

    a.repository.enableSyncCapture = original;
    await enable(a);
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(true);
    // And once more: idempotent.
    const again = await enable(a);
    expect(again.identity.created).toBe(false);
  });

  it("writes nothing anywhere without a backup destination, a name, or on an unsupported setup", async () => {
    const { host, laptops } = await world();
    const [a] = laptops as [Laptop];
    await a.update((current) => ({ ...current, backupDestinationDir: "" }));
    expect(await setupCode(enable(a))).toBe("no_backup_destination");
    await a.update((current) => ({ ...current, backupDestinationDir: PERSONAL }));
    await a.update((current) => ({ ...current, syncProfile: "work" }));
    expect(await setupCode(enable(a))).toBe("unsupported_profile");
    await a.update((current) => ({ ...current, syncProfile: "personal" }));
    expect(
      await setupCode(
        enableSync({
          repository: a.repository,
          settings: { ...(await a.settings()), syncDeviceName: "x".repeat(101) },
          updateSettings: a.update,
          deps: a.deps,
        }),
      ),
    ).toBe("device_name_invalid");
    expect(host.calls).toEqual([]);
    expect(await a.repository.getSyncStatus()).toMatchObject({ identity: null });
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(false);
  });

  it("is unsupported in browser preview and persists nothing", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const update = vi.fn();
    const deps = {
      api: createFakeFolderHost().api,
      getDeviceId: vi.fn(),
    } as never as SyncServiceDeps;
    expect(
      await setupCode(
        enableSync({
          repository,
          settings: await repository.getSettings(),
          updateSettings: update,
          deps,
        }),
      ),
    ).toBe("unsupported_preview");
    expect(update).not.toHaveBeenCalled();
    expect(deps.getDeviceId).not.toHaveBeenCalled();
  });

  it("surfaces a cloned database as a repaired identity", async () => {
    const { laptops } = await world();
    const [a] = laptops as [Laptop];
    await a.repository.ensureSyncIdentity({
      deviceId: harnessDeviceId(9),
      deviceName: "The original laptop",
    });
    const result = await enable(a);
    expect(result.identity).toMatchObject({ deviceId: a.deviceId, repaired: true });
  });
});

describe("disableSync", () => {
  it("only flips the setting: identity, capture and the published files stay", async () => {
    const { host, laptops } = await world();
    const [a] = laptops as [Laptop];
    await a.repository.createTask({ id: "t1", title: "Kept", bucket: "inbox" });
    await enable(a);
    const built = await buildSyncEngine({
      repository: a.repository,
      settings: await a.settings(),
      getSettings: () => ({}) as AppSettings,
      deps: a.deps,
    });
    await built.engine.publish();
    const files = host.filesOf(GTD);
    expect(files.length).toBeGreaterThan(0);

    await disableSync(a.update);
    expect((await a.settings()).multiDeviceSyncEnabled).toBe(false);
    expect(host.filesOf(GTD)).toEqual(files);
    expect(await a.repository.getSyncStatus()).toMatchObject({
      identity: { deviceId: a.deviceId },
      captureEnabled: true,
    });
    // Edits are still captured while sync is off, so enabling again catches up.
    await a.repository.createTask({ id: "t2", title: "Edited while off", bucket: "inbox" });
    const status = await a.repository.getSyncStatus();
    expect(status.supported && status.pendingChanges).toBeGreaterThan(0);
  });
});

describe("buildSyncEngine", () => {
  const build = async (laptop: Laptop) =>
    buildSyncEngine({
      repository: laptop.repository,
      settings: await laptop.settings(),
      getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
      deps: laptop.deps,
    });

  it("builds one transport per configured folder, each carrying its role's domains", async () => {
    const { laptops } = await world();
    const [a] = laptops as [Laptop];
    await enable(a);
    const built = await build(a);
    expect(built.transports.map((transport) => [transport.id, [...transport.domains]])).toEqual([
      ["folder:gtd", ["gtd"]],
      ["folder:personal", ["personal", "finance"]],
    ]);
    expect(built.deviceId).toBe(a.deviceId);

    await a.update((current) => ({ ...current, syncGtdFolderDir: "" }));
    const personalOnly = await build(a);
    expect(personalOnly.transports.map((transport) => transport.id)).toEqual(["folder:personal"]);

    await a.update((current) => ({ ...current, backupDestinationDir: "" }));
    expect(await setupCode(build(a))).toBe("no_folders");
  });

  it("refuses to build while the backup folder overlaps the shared GTD folder", async () => {
    const { laptops } = await world();
    const [a] = laptops as [Laptop];
    await enable(a);
    for (const backup of [GTD, `${GTD}/backups`, "/Drive/Shared"]) {
      await a.update((current) => ({ ...current, backupDestinationDir: backup }));
      expect(await setupCode(build(a)), backup).toBe("folders_overlap");
    }
  });

  it("refuses the work profile and browser preview", async () => {
    const { laptops } = await world();
    const [a] = laptops as [Laptop];
    await enable(a);
    await a.update((current) => ({ ...current, syncProfile: "work" }));
    expect(await setupCode(build(a))).toBe("unsupported_profile");
    const memory = new MemoryRepository();
    await memory.initialize();
    expect(
      await setupCode(
        buildSyncEngine({
          repository: memory,
          settings: await memory.getSettings(),
          getSettings: () => ({}) as AppSettings,
          deps: a.deps,
        }),
      ),
    ).toBe("unsupported_preview");
  });

  it("re-identifies a database restored from another laptop and applies a rename", async () => {
    const { laptops } = await world();
    const [a] = laptops as [Laptop];
    await enable(a);
    await a.update((current) => ({ ...current, syncDeviceName: "Renamed" }));
    const renamed = await build(a);
    expect(renamed.identity).toMatchObject({ deviceName: "Renamed", repaired: false });
    expect(await a.repository.getSyncStatus()).toMatchObject({
      identity: { deviceName: "Renamed" },
    });

    const other: SyncServiceDeps = { ...a.deps, getDeviceId: async () => harnessDeviceId(7) };
    const restored = await buildSyncEngine({
      repository: a.repository,
      settings: await a.settings(),
      getSettings: () => ({}) as AppSettings,
      deps: other,
    });
    expect(restored.identity).toMatchObject({ deviceId: harnessDeviceId(7), repaired: true });
  });
});

describe("Sync now between two laptops, built from the settings", () => {
  const twoLaptops = async () => {
    const { host, laptops } = await world(2);
    const [a, b] = laptops as [Laptop, Laptop];
    const engines = new Map<string, Awaited<ReturnType<typeof buildSyncEngine>>>();
    for (const laptop of laptops) {
      await enable(laptop);
      engines.set(
        laptop.name,
        await buildSyncEngine({
          repository: laptop.repository,
          settings: await laptop.settings(),
          getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
          deps: laptop.deps,
        }),
      );
    }
    return { host, a, b, engine: (laptop: Laptop) => engines.get(laptop.name)!.engine };
  };

  it("takes the safety backup, this device's own, before the first merge, and records its path", async () => {
    const { a, b, engine } = await twoLaptops();
    await a.repository.createTask({ id: "t1", title: "From A", bucket: "inbox" });
    a.clockAdvance();
    await engine(a).syncNow();
    // A had nothing to merge from B yet: no backup was needed.
    expect(a.events).toEqual([]);

    b.clockAdvance();
    const { pull } = await engine(b).syncNow();
    expect(pull.safetyBackup.status).toBe("taken");
    expect(pull.safetyBackup.reasons).toEqual(["first_merge"]);
    expect(pull.safetyBackup.path).toMatch(
      /\/backups\/trackdidia-auto-backup-00000000-\d{4}-\d{2}-\d{2}T/,
    );
    // The backup (VACUUM INTO) precedes the first apply, and a second pull needs none.
    expect(b.events.slice(0, 2)).toEqual(["backup", "apply"]);
    expect(b.events.filter((event) => event === "backup")).toHaveLength(1);
    expect((await b.repository.listTasks({ includeCompleted: true })).map((t) => t.id)).toEqual([
      "t1",
    ]);

    b.events.length = 0;
    await engine(b).syncNow();
    expect(b.events.filter((event) => event === "backup")).toEqual([]);
  });

  it("names the safety backup after this device even when the setting is off at that moment", async () => {
    const { laptops } = await world(2);
    const [a, b] = laptops as [Laptop, Laptop];
    for (const laptop of laptops) await enable(laptop);
    await a.repository.createTask({ id: "t1", title: "x", bucket: "inbox" });
    const built = async (laptop: Laptop) =>
      buildSyncEngine({
        repository: laptop.repository,
        settings: await laptop.settings(),
        getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
        deps: laptop.deps,
      });
    await (await built(a)).engine.syncNow();
    await disableSync(b.update);
    expect((await b.settings()).multiDeviceSyncEnabled).toBe(false);
    vi.mocked(invoke).mockClear();
    const { pull } = await (await built(b)).engine.syncNow();
    expect(pull.safetyBackup.path).toContain("trackdidia-auto-backup-00000000-");
    const prune = vi.mocked(invoke).mock.calls.find(([command]) => command === "prune_backups");
    expect(prune?.[1]).toMatchObject({ deviceId: b.deviceId });
  });

  it("merges nothing and surfaces the native refusal when backups[-dev] leads to the shared folder", async () => {
    const { laptops } = await world(2);
    const [a, b] = laptops as [Laptop, Laptop];
    for (const laptop of laptops) await enable(laptop);
    await a.repository.createTask({ id: "t1", title: "x", bucket: "inbox" });
    const built = async (laptop: Laptop) =>
      buildSyncEngine({
        repository: laptop.repository,
        settings: await laptop.settings(),
        getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
        deps: laptop.deps,
      });
    await (await built(a)).engine.syncNow();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "resolve_storage_paths") {
        return { databasePath: "/x", connectionString: "sqlite:x", environment: "production" };
      }
      if (command === "ensure_backup_dir") {
        throw "overlaps_sync_folder: Le dossier de backups est un lien symbolique vers le dossier GTD partage";
      }
      throw new Error(`unexpected command ${command}`);
    });
    const { pull } = await (await built(b)).engine.syncNow();
    expect(pull.safetyBackup.status).toBe("failed");
    expect(pull.issues).toContainEqual(
      expect.objectContaining({
        code: "safety_backup_required",
        severity: "error",
        detail: expect.stringContaining("lien symbolique"),
      }),
    );
    expect(b.events).not.toContain("backup");
    expect(b.events).not.toContain("apply");
  });

  it("merges nothing when the backup folder is gone, and says why", async () => {
    const host = createFakeFolderHost();
    host.mount(PERSONAL);
    host.mount(GTD);
    const a = await openLaptop(host, 0, "A");
    const b = await openLaptop(host, 1, "B");
    for (const laptop of [a, b]) await enable(laptop);
    const built = async (laptop: Laptop, currentSettings: () => AppSettings) =>
      buildSyncEngine({
        repository: laptop.repository,
        settings: await laptop.settings(),
        getSettings: currentSettings,
        deps: laptop.deps,
      });
    await a.repository.createTask({ id: "t1", title: "From A", bucket: "inbox" });
    await (
      await built(a, () => ({ backupDestinationDir: PERSONAL }) as AppSettings)
    ).engine.syncNow();

    // B's destination setting is emptied after its engine was built: the hook refuses.
    const engine = (await built(b, () => ({ backupDestinationDir: "" }) as AppSettings)).engine;
    const { pull } = await engine.syncNow();
    expect(pull.safetyBackup.status).toBe("failed");
    expect(pull.issues).toContainEqual(
      expect.objectContaining({ code: "safety_backup_required", severity: "error" }),
    );
    expect(b.events).not.toContain("apply");
    expect(b.events).not.toContain("backup");
    expect(await b.repository.listTasks({ includeCompleted: true })).toEqual([]);
  });

  it("records the safety backup through the callback", async () => {
    const { host, laptops } = await world(2);
    const [a, b] = laptops as [Laptop, Laptop];
    for (const laptop of laptops) await enable(laptop);
    await a.repository.createTask({ id: "t1", title: "x", bucket: "inbox" });
    const engineA = await buildSyncEngine({
      repository: a.repository,
      settings: await a.settings(),
      getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
      deps: a.deps,
    });
    await engineA.engine.syncNow();
    const noted: string[] = [];
    const engineB = await buildSyncEngine({
      repository: b.repository,
      settings: await b.settings(),
      getSettings: () => ({ backupDestinationDir: PERSONAL }) as AppSettings,
      deps: b.deps,
      onBackup: (backup) => {
        noted.push(backup.backupPath);
      },
    });
    const { pull } = await engineB.engine.syncNow();
    expect(noted).toEqual([pull.safetyBackup.path]);
    expect(host.calls.length).toBeGreaterThan(0);
  });
});
