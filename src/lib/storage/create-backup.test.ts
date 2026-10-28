// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
// SAFETY: the repository runs on an isolated `:memory:` database, and `VACUUM INTO` is intercepted
// below: no backup file is ever written by this test.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { BackupDestinationError } from "../backup";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const DEVICE = "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const OTHER = "dev:7f3c1a2e-9d4b-4c5e-8a1f-2b3c4d5e6f70";
const BACKUP_DIR = "/Drive/Perso/backups-dev";

/** What the native `sync_device_id` command answers in this test (an Error rejects). */
let nativeDeviceId: string | Error = new Error("no device id file");

const open = async () => {
  const raw = createNodeSqliteDatabase();
  const vacuums: string[] = [];
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "execute") {
        return (query: string, ...rest: unknown[]) => {
          if (query.startsWith("VACUUM INTO")) {
            vacuums.push(query);
            return Promise.resolve({ rowsAffected: 0 });
          }
          return (target.execute as (...args: unknown[]) => Promise<unknown>)(query, ...rest);
        };
      }
      return (target as never as Record<string | symbol, unknown>)[property];
    },
  });
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  await repository.updateSettings((current) => ({
    ...current,
    backupDestinationDir: "/Drive/Perso",
  }));
  return { repository, vacuums };
};

const pruneCall = () => {
  const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "prune_backups");
  return call?.[1] as Record<string, unknown> | undefined;
};

describe("createBackup names and prunes per device", () => {
  beforeEach(() => {
    nativeDeviceId = new Error("no device id file");
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "resolve_storage_paths") {
        return { databasePath: "/x", connectionString: "sqlite:x", environment: "development" };
      }
      if (command === "ensure_backup_dir") return BACKUP_DIR;
      if (command === "prune_backups") return { deletedPaths: [], failed: [], keptCount: 1 };
      if (command === "sync_device_id") {
        if (nativeDeviceId instanceof Error) throw nativeDeviceId;
        return nativeDeviceId;
      }
      throw new Error(`unexpected command ${command}`);
    });
  });

  it("keeps the legacy name and an unlabeled prune when no device id applies", async () => {
    const { repository, vacuums } = await open();
    const backup = await repository.createBackup("auto");
    expect(backup.backupPath).toMatch(/\/trackdidia-auto-backup-\d{4}-/);
    expect(vacuums).toHaveLength(1);
    expect(pruneCall()).toEqual({ destinationDir: "/Drive/Perso", environment: "development" });
  });

  it("tags the file and passes the same device id to prune_backups when one is given", async () => {
    const { repository, vacuums } = await open();
    const backup = await repository.createBackup("auto", { deviceId: DEVICE });
    expect(backup.backupPath).toMatch(/\/trackdidia-auto-backup-3f1c0b9c-\d{4}-/);
    expect(vacuums[0]).toContain("trackdidia-auto-backup-3f1c0b9c-");
    expect(pruneCall()).toEqual({
      destinationDir: "/Drive/Perso",
      environment: "development",
      deviceId: DEVICE,
    });
  });

  it("uses this device's own id for every backup while sync is enabled", async () => {
    const { repository } = await open();
    nativeDeviceId = OTHER;
    await repository.ensureSyncIdentity({ deviceId: OTHER, deviceName: "Portable" });
    // Sync not enabled: nothing is tagged.
    expect((await repository.createBackup("manual")).backupPath).not.toContain("7f3c1a2e");
    await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    vi.mocked(invoke).mockClear();
    const backup = await repository.createBackup("manual");
    expect(backup.backupPath).toMatch(/\/trackdidia-manual-backup-7f3c1a2e-/);
    expect(pruneCall()).toMatchObject({ deviceId: OTHER });
  });

  it("takes the tag from the native device-id file, not from a copied database's identity", async () => {
    const { repository } = await open();
    // This database was copied from the laptop whose id is DEVICE; this laptop is OTHER.
    await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop A" });
    await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    nativeDeviceId = OTHER;
    const backup = await repository.createBackup("auto");
    expect(backup.backupPath).toContain("-7f3c1a2e-");
    expect(backup.backupPath).not.toContain("3f1c0b9c");
    expect(pruneCall()).toMatchObject({ deviceId: OTHER });
  });

  it("falls back to the legacy name when the native id cannot be read or is not an id", async () => {
    const { repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop A" });
    await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    nativeDeviceId = new Error("corrupt device id file");
    const unreadable = await repository.createBackup("auto");
    expect(unreadable.backupPath).toMatch(/\/trackdidia-auto-backup-\d{4}-/);
    expect(pruneCall()).toEqual({ destinationDir: "/Drive/Perso", environment: "development" });
    vi.mocked(invoke).mockClear();
    nativeDeviceId = "../../etc/passwd";
    const invalid = await repository.createBackup("auto");
    expect(invalid.backupPath).toMatch(/\/trackdidia-auto-backup-\d{4}-/);
  });

  it("an explicit id wins over the stored identity", async () => {
    const { repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: OTHER, deviceName: "Portable" });
    await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    const backup = await repository.createBackup("auto", { deviceId: DEVICE });
    expect(backup.backupPath).toContain("-3f1c0b9c-");
    expect(pruneCall()).toMatchObject({ deviceId: DEVICE });
  });

  it("an invalid device id never blocks a backup: legacy name, unlabeled prune", async () => {
    const { repository, vacuums } = await open();
    const backup = await repository.createBackup("auto", { deviceId: "../../etc/passwd" });
    expect(backup.backupPath).toMatch(/\/trackdidia-auto-backup-\d{4}-/);
    expect(vacuums).toHaveLength(1);
    expect(pruneCall()).toEqual({ destinationDir: "/Drive/Perso", environment: "development" });
  });

  it("sync enabled but no device id file is a legacy backup", async () => {
    const { repository } = await open();
    await repository.updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
    const backup = await repository.createBackup("auto");
    expect(backup.backupPath).toMatch(/\/trackdidia-auto-backup-\d{4}-/);
  });

  it("still refuses without a destination", async () => {
    const { repository } = await open();
    await repository.updateSettings((current) => ({ ...current, backupDestinationDir: "" }));
    await expect(repository.createBackup("auto", { deviceId: DEVICE })).rejects.toThrow();
  });

  describe("a destination that overlaps the shared GTD sync folder", () => {
    const openWithGtd = async (backupDir: string, gtdDir: string) => {
      const opened = await open();
      await opened.repository.updateSettings((current) => ({
        ...current,
        backupDestinationDir: backupDir,
        syncGtdFolderDir: gtdDir,
      }));
      return opened;
    };

    it.each([
      ["the same folder", "/Drive/Shared/GTD", "/Drive/Shared/GTD"],
      ["the same folder under another spelling", "/drive/shared/gtd/", "/Drive/Shared/GTD"],
      ["a folder inside it", "/Drive/Shared/GTD/archive", "/Drive/Shared/GTD"],
      ["a folder around it", "/Drive/Shared", "/Drive/Shared/GTD"],
    ])(
      "refuses %s before anything is written, for every kind of backup",
      async (_label, backupDir, gtdDir) => {
        const { repository, vacuums } = await openWithGtd(backupDir, gtdDir);
        for (const kind of ["manual", "auto"] as const) {
          const error = await repository.createBackup(kind).catch((caught) => caught);
          expect(error).toBeInstanceOf(BackupDestinationError);
          expect(error.code).toBe("overlaps_sync_folder");
          expect(error.message).toMatch(/dossier GTD partagé/);
        }
        await expect(repository.createBackup("auto", { deviceId: DEVICE })).rejects.toBeInstanceOf(
          BackupDestinationError,
        );
        expect(vacuums).toEqual([]);
        expect(
          vi.mocked(invoke).mock.calls.filter(([command]) => command === "ensure_backup_dir"),
        ).toEqual([]);
      },
    );

    it("changes nothing when no GTD folder is set, or the folders are apart", async () => {
      const apart = await openWithGtd("/Drive/Perso", "/Drive/Shared/GTD");
      await apart.repository.createBackup("manual");
      expect(apart.vacuums).toHaveLength(1);
      const none = await openWithGtd("/Drive/Perso", "");
      await none.repository.createBackup("manual");
      expect(none.vacuums).toHaveLength(1);
    });
  });

  describe("a refusal from the native host", () => {
    const rejectEnsure = (message: unknown) =>
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === "resolve_storage_paths") {
          return { databasePath: "/x", connectionString: "sqlite:x", environment: "development" };
        }
        if (command === "ensure_backup_dir") throw message;
        throw new Error(`unexpected command ${command}`);
      });

    it("surfaces a backups[-dev] link to the shared folder as a typed error and writes nothing", async () => {
      const { repository, vacuums } = await open();
      rejectEnsure(
        "overlaps_sync_folder: Le dossier de backups /Drive/Perso/backups-dev est un lien symbolique",
      );
      for (const kind of ["manual", "auto"] as const) {
        const error = await repository.createBackup(kind).catch((caught) => caught);
        expect(error).toBeInstanceOf(BackupDestinationError);
        expect(error.code).toBe("overlaps_sync_folder");
        expect(error.message).toContain("lien symbolique");
        expect(error.message).not.toContain("overlaps_sync_folder:");
      }
      expect(vacuums).toEqual([]);
      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "prune_backups"),
      ).toEqual([]);
    });

    it("keeps any other native message visible instead of a generic fallback", async () => {
      const { repository, vacuums } = await open();
      rejectEnsure("Le dossier de backup /Drive/Perso est introuvable.");
      const error = await repository.createBackup("manual").catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BackupDestinationError);
      expect(error.message).toBe("Le dossier de backup /Drive/Perso est introuvable.");
      expect(vacuums).toEqual([]);
    });
  });
});
