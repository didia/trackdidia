import { act, renderHook } from "@testing-library/react";
import { defaultAppSettings } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import { AUTO_BACKUP_CHECK_INTERVAL_MS } from "../lib/backup";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { useAutoBackupScheduler } from "./use-auto-backup-scheduler";

const dueSettings = (): AppSettings => ({
  ...defaultAppSettings(),
  autoBackupEnabled: true,
  backupDestinationDir: "/tmp/backups",
  autoBackupIntervalHours: 24,
  lastBackupAt: "",
});

const createRepository = async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  vi.spyOn(repository, "getStorageInfo").mockResolvedValue({
    databasePath: "/tmp/db.sqlite",
  } as never);
  return repository;
};

describe("useAutoBackupScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a backup at startup when due and publishes the updated settings", async () => {
    const repository = await createRepository();
    const createBackup = vi.spyOn(repository, "createBackup").mockResolvedValue({
      createdAt: "2026-10-03T12:00:00.000Z",
      backupPath: "/tmp/backups/a.sqlite",
    } as never);
    const onSettingsUpdated = vi.fn();

    renderHook(() => useAutoBackupScheduler(repository, dueSettingsGetter, onSettingsUpdated));
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(onSettingsUpdated).toHaveBeenCalledTimes(1));

    expect(createBackup).toHaveBeenCalledWith("auto");
    expect(onSettingsUpdated.mock.calls[0][0]).toMatchObject({
      lastBackupAt: "2026-10-03T12:00:00.000Z",
      lastBackupPath: "/tmp/backups/a.sqlite",
    });
  });

  it("does not restart (or re-check) when only the settings getter identity changes", async () => {
    const repository = await createRepository();
    const createBackup = vi.spyOn(repository, "createBackup").mockResolvedValue({
      createdAt: "2026-10-03T12:00:00.000Z",
      backupPath: "/tmp/backups/a.sqlite",
    } as never);
    let settings: AppSettings = { ...dueSettings(), autoBackupEnabled: false };

    const { rerender } = renderHook(() =>
      useAutoBackupScheduler(
        repository,
        () => settings,
        () => undefined,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    settings = dueSettings();
    rerender();
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(createBackup).not.toHaveBeenCalled();
  });

  it("never runs two checks concurrently", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const repository = await createRepository();
    let release: (() => void) | null = null;
    const createBackup = vi.spyOn(repository, "createBackup").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              createdAt: "2026-10-03T12:00:00.000Z",
              backupPath: "/tmp/backups/a.sqlite",
            } as never);
        }),
    );

    renderHook(() => useAutoBackupScheduler(repository, dueSettingsGetter, () => undefined));
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(createBackup).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(AUTO_BACKUP_CHECK_INTERVAL_MS * 3);
      await Promise.resolve();
    });
    expect(createBackup).toHaveBeenCalledTimes(1);

    await act(async () => {
      (release as (() => void) | null)?.();
    });
  });
});

const dueSettingsGetter = () => dueSettings();
