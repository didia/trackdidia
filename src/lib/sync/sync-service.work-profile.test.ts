// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapApplication } from "../../app/bootstrap";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { AppSettings } from "../../domain/types";
import { startStartupSyncPull } from "./startup-sync";
import {
  assertProfileFitsDatabase,
  buildSyncEngine,
  changeSyncProfile,
  enableSync,
  SyncSetupError,
  type SyncServiceDeps,
} from "./sync-service";
import { WORK_PROFILE_SELECTABLE } from "./profile";
import { createFakeFolderHost, type FakeFolderHost } from "./test-support/fake-folder-host";
import {
  enableFakeLaptop,
  type FakeLaptop,
  GTD_FOLDER,
  openFakeLaptop,
  PERSONAL_FOLDER,
  publishFromFakeLaptop,
} from "./test-support/fake-laptop";
import { annualGoal } from "./test-support/personal-fixtures";
import { harnessDeviceId } from "./test-support/two-device-harness";

// SAFETY: every laptop is an isolated `:memory:` database; `VACUUM INTO` is intercepted and the
// folders are the in-memory fake host (see test-support/fake-laptop.ts).

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const WORK_BACKUPS = "/Local/WorkBackups";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "resolve_storage_paths") {
      return { databasePath: "/x", connectionString: "sqlite:x", environment: "production" };
    }
    if (command === "ensure_backup_dir") return `${WORK_BACKUPS}/backups`;
    if (command === "prune_backups") return { deletedPaths: [], failed: [], keptCount: 1 };
    throw new Error(`unexpected command ${command}`);
  });
});

const host = (): FakeFolderHost => {
  const fake = createFakeFolderHost();
  fake.mount(PERSONAL_FOLDER);
  fake.mount(GTD_FOLDER);
  return fake;
};

/** The deps a test passes to switch the unreleased `work` profile on. */
const withWork = (laptop: FakeLaptop): SyncServiceDeps => ({
  ...laptop.deps,
  workProfileSelectable: true,
});

const setProfile = (laptop: FakeLaptop, syncProfile: AppSettings["syncProfile"]) =>
  laptop.repository.updateSettings((current) => ({ ...current, syncProfile }));

/** A work laptop: own backup destination (never the personal folder), the shared GTD folder only. */
const openWorkLaptop = async (fake: FakeFolderHost, index: number): Promise<FakeLaptop> => {
  const laptop = await openFakeLaptop(fake, index);
  await laptop.repository.updateSettings((current) => ({
    ...current,
    syncProfile: "work",
    backupDestinationDir: WORK_BACKUPS,
  }));
  return laptop;
};

const setupCode = async (promise: Promise<unknown>): Promise<SyncSetupError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncSetupError);
    return error as SyncSetupError;
  }
  throw new Error("expected a SyncSetupError");
};

const hasTask = async (laptop: FakeLaptop, id: string) =>
  (await laptop.repository.listTasks({ includeCompleted: true })).some((task) => task.id === id);

describe("the work profile is not selectable in this release", () => {
  it("is off by default", () => {
    expect(WORK_PROFILE_SELECTABLE).toBe(false);
  });

  it("enabling, building and changing to it are refused as unsupported without the test seam", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    const settings = await laptop.settings();
    expect(
      (
        await setupCode(
          enableSync({
            repository: laptop.repository,
            settings,
            updateSettings: (u) => laptop.repository.updateSettings(u),
            deps: laptop.deps,
          }),
        )
      ).code,
    ).toBe("unsupported_profile");
    expect(
      (
        await setupCode(
          buildSyncEngine({
            repository: laptop.repository,
            settings,
            getSettings: () => settings,
            deps: laptop.deps,
          }),
        )
      ).code,
    ).toBe("unsupported_profile");
    const personal = await openFakeLaptop(fake, 1);
    expect(
      (
        await setupCode(
          changeSyncProfile({
            repository: personal.repository,
            settings: await personal.settings(),
            to: "work",
            updateSettings: (u) => personal.repository.updateSettings(u),
            deps: personal.deps,
          }),
        )
      ).code,
    ).toBe("unsupported_profile");
    expect((await personal.settings()).syncProfile).toBe("personal");
    expect(fake.calls).toEqual([]);
  });

  it("changing to personal never needs the seam, and nothing is written for the same profile", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    const update = vi.fn((u: (s: AppSettings) => AppSettings) =>
      laptop.repository.updateSettings(u),
    );
    const back = await changeSyncProfile({
      repository: laptop.repository,
      settings: await laptop.settings(),
      to: "personal",
      updateSettings: update,
      deps: laptop.deps,
    });
    expect(back).toEqual({
      outcome: "changed",
      steps: ["choose_personal_folder", "import_other_domains"],
    });
    expect((await laptop.settings()).syncProfile).toBe("personal");
    update.mockClear();
    const same = await changeSyncProfile({
      repository: laptop.repository,
      settings: await laptop.settings(),
      to: "personal",
      updateSettings: update,
      deps: laptop.deps,
    });
    expect(same).toEqual({ outcome: "noop", steps: [] });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("changing the profile (service path, test seam on)", () => {
  const change = async (laptop: FakeLaptop, to: "personal" | "work") =>
    changeSyncProfile({
      repository: laptop.repository,
      settings: await laptop.settings(),
      to,
      updateSettings: (u) => laptop.repository.updateSettings(u),
      deps: withWork(laptop),
    });

  it("personal -> work on a database with no personal or finance row is allowed", async () => {
    const laptop = await openFakeLaptop(host(), 0);
    await laptop.repository.createTask({ id: "t1", title: "Work item", bucket: "inbox" });
    expect(await change(laptop, "work")).toEqual({
      outcome: "changed",
      steps: ["use_gtd_folder_only"],
    });
    expect((await laptop.settings()).syncProfile).toBe("work");
  });

  it("personal -> work is refused with the counts when personal or finance rows exist, saving nothing", async () => {
    const laptop = await openFakeLaptop(host(), 0);
    await laptop.repository.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await laptop.repository.saveAnnualGoal(annualGoal({ id: "goal-1" }));
    const error = await setupCode(change(laptop, "work"));
    expect(error.code).toBe("work_profile_data_present");
    expect(error.counts?.personal).toBe(2);
    expect(error.counts?.finance).toBe(0);
    expect(error.message).toContain("personal: 2");
    expect((await laptop.settings()).syncProfile).toBe("personal");
  });

  it("is refused for rows that only survive as sidecars (the tombstone of a deleted goal)", async () => {
    const laptop = await openFakeLaptop(host(), 0);
    await enableFakeLaptop(laptop);
    await laptop.repository.saveAnnualGoal(annualGoal({ id: "goal-1" }));
    await laptop.repository.deleteAnnualGoal("goal-1");
    const error = await setupCode(change(laptop, "work"));
    expect(error.code).toBe("work_profile_data_present");
    expect(error.counts?.personal).toBeGreaterThan(0);
  });

  it("is refused for a changed personal setting, and not for the app's own markers", async () => {
    const laptop = await openFakeLaptop(host(), 0);
    await bootstrapApplication(laptop.repository);
    expect((await change(laptop, "work")).outcome).toBe("changed");
    await setProfile(laptop, "personal");
    await laptop.repository.updateSettings((current) => ({ ...current, aiPastorEnabled: true }));
    expect((await setupCode(change(laptop, "work"))).code).toBe("work_profile_data_present");
  });

  it("work -> personal is allowed whatever the database holds, with the steps still to do", async () => {
    const laptop = await openWorkLaptop(host(), 0);
    await laptop.repository.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    expect(await change(laptop, "personal")).toEqual({
      outcome: "changed",
      steps: ["choose_personal_folder", "import_other_domains"],
    });
  });

  it("a no-op does not even read the database", async () => {
    const laptop = await openFakeLaptop(host(), 0);
    const inspect = vi.spyOn(laptop.repository, "inspectSyncProfileData");
    expect(await change(laptop, "personal")).toEqual({ outcome: "noop", steps: [] });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("browser preview cannot be inspected: the guard reports sync as unavailable", async () => {
    const { MemoryRepository } = await import("../storage/memory-repository");
    const memory = new MemoryRepository();
    await memory.initialize();
    await expect(assertProfileFitsDatabase(memory, "work")).rejects.toThrow();
    await expect(assertProfileFitsDatabase(memory, "personal")).resolves.toBeUndefined();
  });
});

describe("joining as work (enable)", () => {
  it("is refused on a non-empty personal database before any folder, identity or setting is touched", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    await laptop.repository.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    const error = await setupCode(
      enableSync({
        repository: laptop.repository,
        settings: await laptop.settings(),
        updateSettings: (u) => laptop.repository.updateSettings(u),
        deps: withWork(laptop),
      }),
    );
    expect(error.code).toBe("work_profile_data_present");
    expect(error.counts).toEqual({ personal: 1, finance: 0 });
    expect(fake.calls).toEqual([]);
    expect(await laptop.repository.getSyncStatus()).toMatchObject({ identity: null });
    expect((await laptop.settings()).multiDeviceSyncEnabled).toBe(false);
  });

  it("on a database with GTD rows only prepares the shared folder alone, never the personal one", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    await laptop.repository.createTask({ id: "t1", title: "Work item", bucket: "inbox" });
    const result = await enableSync({
      repository: laptop.repository,
      settings: await laptop.settings(),
      updateSettings: (u) => laptop.repository.updateSettings(u),
      deps: withWork(laptop),
    });
    expect(result.folders).toEqual({ gtd: GTD_FOLDER, personal: null });
    expect(fake.calls.map((call) => [call.command, call.role, call.folderDir])).toEqual([
      ["prepare", "gtd", GTD_FOLDER],
    ]);
    expect((await laptop.settings()).multiDeviceSyncEnabled).toBe(true);
  });

  it("builds an engine whose only transport is the shared GTD folder, though a backup folder is set", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    await enableSync({
      repository: laptop.repository,
      settings: await laptop.settings(),
      updateSettings: (u) => laptop.repository.updateSettings(u),
      deps: withWork(laptop),
    });
    const settings = await laptop.settings();
    const built = await buildSyncEngine({
      repository: laptop.repository,
      settings,
      getSettings: () => settings,
      deps: withWork(laptop),
    });
    expect(built.transports.map((transport) => [transport.id, [...transport.domains]])).toEqual([
      ["folder:gtd", ["gtd"]],
    ]);
    expect((await built.engine.getStatus()).profile).toBe("work");
  });

  it("a work profile with no shared GTD folder cannot be built", async () => {
    const fake = host();
    const laptop = await openWorkLaptop(fake, 0);
    await enableSync({
      repository: laptop.repository,
      settings: await laptop.settings(),
      updateSettings: (u) => laptop.repository.updateSettings(u),
      deps: withWork(laptop),
    });
    await laptop.repository.updateSettings((current) => ({ ...current, syncGtdFolderDir: "" }));
    const settings = await laptop.settings();
    expect(
      (
        await setupCode(
          buildSyncEngine({
            repository: laptop.repository,
            settings,
            getSettings: () => settings,
            deps: withWork(laptop),
          }),
        )
      ).code,
    ).toBe("no_folders");
  });
});

describe("the startup path of a work laptop (slice 15 flow)", () => {
  const worldWithWork = async () => {
    const fake = host();
    const a = await openFakeLaptop(fake, 0);
    await enableFakeLaptop(a);
    await a.repository.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await publishFromFakeLaptop(a);
    const w = await openWorkLaptop(fake, 1);
    await enableSync({
      repository: w.repository,
      settings: await w.settings(),
      updateSettings: (u) => w.repository.updateSettings(u),
      deps: withWork(w),
    });
    return { fake, a, w };
  };
  const lane = <T>(work: () => Promise<T>): Promise<T> => work();

  it("a clean work database pulls the GTD list at startup, from the shared folder only", async () => {
    const { fake, w } = await worldWithWork();
    fake.calls.length = 0;
    const startup = await startStartupSyncPull({
      repository: w.repository,
      settings: await w.settings(),
      debugEnabled: true,
      runExclusive: lane,
      deps: withWork(w),
    });
    expect(startup?.finished?.ok).toBe(true);
    expect(await hasTask(w, "from-a")).toBe(true);
    expect(new Set(fake.calls.map((call) => call.role))).toEqual(new Set(["gtd"]));
    expect(fake.calls.every((call) => call.folderDir === GTD_FOLDER)).toBe(true);
  });

  it("PAUSES at startup when personal rows exist: error in the report, no folder call, nothing applied", async () => {
    const { fake, w } = await worldWithWork();
    await w.repository.saveFinanceAccount({
      id: "account-1",
      name: "Copied in by hand",
      institution: null,
      type: "checking",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 0,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: "",
      updatedAt: "",
    });
    fake.calls.length = 0;
    const startup = await startStartupSyncPull({
      repository: w.repository,
      settings: await w.settings(),
      debugEnabled: true,
      runExclusive: lane,
      deps: withWork(w),
    });
    const outcome = startup?.finished;
    expect(outcome?.ok).toBe(true);
    const report = outcome?.ok ? outcome.report : null;
    expect(report?.issues.map((issue) => [issue.code, issue.severity])).toEqual([
      ["work_profile_data_present", "error"],
    ]);
    expect(report?.complete).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(false);
    // The page can say so too.
    expect((await startup?.built.engine.getStatus())?.profileViolation).toMatchObject({
      finance: expect.any(Number),
    });
  });

  it("never holds up bootstrap: a database that never answers the look, or a lane that never frees, does not block it or cause a fallback", async () => {
    for (const stall of ["inspect", "lane"] as const) {
      const { w } = await worldWithWork();
      if (stall === "inspect") {
        vi.spyOn(w.repository, "inspectSyncProfileData").mockImplementation(
          () => new Promise(() => undefined),
        );
      }
      const startedAt = Date.now();
      let pulled = false;
      const settings = await bootstrapApplication(w.repository, {
        pullBeforeGenerators: async (current) => {
          const startup = await startStartupSyncPull({
            repository: w.repository,
            settings: current,
            debugEnabled: true,
            runExclusive: stall === "lane" ? () => new Promise<never>(() => undefined) : lane,
            deps: withWork(w),
            waitBudgetMs: 40,
          });
          pulled = true;
          expect(startup?.finished ?? null).toBeNull();
          return startup !== null;
        },
        isSyncPullEnabled: () => true,
      });
      expect(pulled).toBe(true);
      // Bootstrap went on to its own work (it resolved with settings, it did not reject).
      expect(settings.gtdScheduledNormalizationDoneAt).not.toBe("");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    }
  });
});

describe("a cloned device identity is repaired when the engine is built, i.e. at every startup", () => {
  it("two machines with the same stored identity become two peers and converge", async () => {
    const fake = host();
    const a = await openFakeLaptop(fake, 0);
    await enableFakeLaptop(a);
    await a.repository.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await publishFromFakeLaptop(a);
    const manifestsBefore = fake
      .filesOf(GTD_FOLDER)
      .filter((path) => path.endsWith("manifest.json"));

    // B holds a copy of A's database: A's sync identity, but its own device-id file (index 1).
    const b = await openFakeLaptop(fake, 1);
    await b.repository.ensureSyncIdentity({ deviceId: harnessDeviceId(0), deviceName: "Laptop 1" });
    await b.repository.enableSyncCapture();
    await b.repository.createTask({ id: "from-clone", title: "From the copy", bucket: "inbox" });
    await b.repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    expect(await b.repository.getSyncStatus()).toMatchObject({
      identity: { deviceId: harnessDeviceId(0) },
    });

    // The startup path: the engine is built, the identity is rewritten to this machine's id.
    const startup = await startStartupSyncPull({
      repository: b.repository,
      settings: await b.settings(),
      debugEnabled: true,
      runExclusive: (work) => work(),
      deps: b.deps,
    });
    expect(startup?.built.identity).toMatchObject({ deviceId: harnessDeviceId(1), repaired: true });
    expect(await b.repository.getSyncStatus()).toMatchObject({
      identity: { deviceId: harnessDeviceId(1) },
    });
    expect(startup?.finished?.ok).toBe(true);
    expect(await hasTask(b, "from-a")).toBe(true);

    // B publishes under ITS id; A's files are untouched and A now sees the copy's task.
    await startup?.built.engine.publish();
    const manifestsAfter = fake
      .filesOf(GTD_FOLDER)
      .filter((path) => path.endsWith("manifest.json"));
    expect(manifestsBefore).toHaveLength(1);
    expect(manifestsAfter).toHaveLength(2);
    expect(manifestsAfter).toEqual(expect.arrayContaining(manifestsBefore));
    const settingsA = await a.settings();
    const aEngine = (
      await buildSyncEngine({
        repository: a.repository,
        settings: settingsA,
        getSettings: () => settingsA,
        deps: a.deps,
      })
    ).engine;
    await aEngine.pull();
    expect(await hasTask(a, "from-clone")).toBe(true);

    // Nothing to repair the second time.
    const again = await buildSyncEngine({
      repository: b.repository,
      settings: await b.settings(),
      getSettings: () => ({}) as AppSettings,
      deps: b.deps,
    });
    expect(again.identity.repaired).toBe(false);
  });
});
