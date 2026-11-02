// Test-only: nothing in the app imports this file.
//
// SAFETY: every laptop is an isolated `:memory:` database; `VACUUM INTO` is intercepted (no backup
// file is written) and the folders are the in-memory fake host.
import { vi } from "vitest";
import type { AppSettings } from "../../../domain/types";
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { TauriSqliteRepository } from "../../storage/tauri-sqlite-repository";
import { buildSyncEngine, enableSync, type SyncServiceDeps } from "../sync-service";
import type { FakeFolderHost } from "./fake-folder-host";
import { createFakeClock, harnessDeviceId } from "./two-device-harness";

export const PERSONAL_FOLDER = "/Drive/Perso";
export const GTD_FOLDER = "/Drive/Shared/GTD";

export interface FakeLaptop {
  repository: TauriSqliteRepository;
  deps: SyncServiceDeps;
  /** `VACUUM INTO` statements seen (the safety and automatic backups). */
  backups: () => number;
  settings: () => Promise<AppSettings>;
  clock: ReturnType<typeof createFakeClock>;
}

/** A desktop-like laptop: sqlite in memory, its own device id, both folders configured. */
export const openFakeLaptop = async (host: FakeFolderHost, index: number): Promise<FakeLaptop> => {
  const raw = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
  let backups = 0;
  const db = new Proxy(raw, {
    get(target, property) {
      if (property === "execute") {
        return (query: string, ...rest: unknown[]) => {
          if (query.startsWith("VACUUM INTO")) {
            backups += 1;
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
  await repository.updateSettings((current) => ({
    ...current,
    backupDestinationDir: PERSONAL_FOLDER,
    syncGtdFolderDir: GTD_FOLDER,
    syncDeviceName: `Laptop ${index + 1}`,
  }));
  return {
    repository,
    backups: () => backups,
    settings: () => repository.getSettings(),
    clock,
    deps: {
      api: host.api,
      getDeviceId: vi.fn(async () => harnessDeviceId(index)),
      getAppVersion: async () => "0.2.0-test",
      now: clock.read,
    },
  };
};

/** Turns sync on for the laptop (folders, identity, capture) and returns its settings. */
export const enableFakeLaptop = async (laptop: FakeLaptop): Promise<AppSettings> => {
  await enableSync({
    repository: laptop.repository,
    settings: await laptop.settings(),
    updateSettings: (updater) => laptop.repository.updateSettings(updater),
    deps: laptop.deps,
  });
  return laptop.settings();
};

/** Publishes everything the laptop holds, as its engine would. */
export const publishFromFakeLaptop = async (laptop: FakeLaptop): Promise<void> => {
  const settings = await laptop.settings();
  const built = await buildSyncEngine({
    repository: laptop.repository,
    settings,
    getSettings: () => settings,
    deps: laptop.deps,
  });
  await built.engine.publish();
};
