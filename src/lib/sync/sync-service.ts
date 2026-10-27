import type { AppSettings } from "../../domain/types";
import { backupDestinationOverlap, isBackupDestinationConfigured } from "../backup";
import { logDebug } from "../debug";
import type { AppRepository, BackupResult } from "../storage/repository";
import { type FolderOverlap, folderOverlap } from "./folder-paths";
import type { SyncFolderEnvironment, SyncFolderRole } from "./folder-api";
import { SyncFolderError } from "./folder-api";
import { getDeviceId } from "./device-id";
import { createSyncEngine, type SyncEngine } from "./sync-engine";
import type { EnsureSafetyBackup } from "./engine-support";
import { normalizeDeviceName, type SyncIdentityResult } from "./status";
import {
  createFolderTransport,
  type FolderApi,
  type FolderTransport,
  realFolderApi,
} from "./transport-folder";

/**
 * Everything between the settings and a running engine, without React: validating and preparing the
 * two folders, enabling or disabling sync on this device, and building the engine (its transports,
 * the safety backup and the calendar flag). The hook `use-multi-device-sync.ts` only holds state
 * around these functions; they take their collaborators as arguments so tests can run them against
 * an in-memory database and a fake host.
 *
 * Folders. The PERSONAL folder is the backup destination (`backupDestinationDir`); the GTD folder is
 * `syncGtdFolderDir`. Whenever one is prepared the OTHER is passed as `otherFolderDir`, so the host's
 * nesting check always has both, and each is prepared under the role of the setting that holds it
 * (the host cannot tell which role a shared folder was meant for).
 *
 * Disabling only flips `multiDeviceSyncEnabled`. The identity, change capture and the files in the
 * folders stay: nothing is deleted from a user's Drive, and enabling again is a cheap catch-up.
 */

export type SyncSetupErrorCode =
  /** Browser preview (or the startup fallback): there is no persistent storage to sync. */
  | "unsupported_preview"
  /** `syncProfile` is not `personal`: the work profile ships in a later release. */
  | "unsupported_profile"
  /** No backup destination: it is the personal folder and where the safety backup is written. */
  | "no_backup_destination"
  | "no_gtd_folder"
  /** The two folders are the same or one lies inside the other (refused before the host is asked). */
  | "folders_overlap"
  /** The host refused a folder: wrong role marker, looks like the backup folder, or nesting. */
  | "folder_rejected"
  /** A folder does not exist (an unmounted Drive) or could not be prepared. */
  | "folder_unavailable"
  | "device_name_invalid"
  | "no_device_id"
  | "capture_failed"
  | "no_folders";

export class SyncSetupError extends Error {
  readonly code: SyncSetupErrorCode;
  /** Which folder the problem is about, when one is. */
  readonly role: SyncFolderRole | undefined;

  constructor(
    code: SyncSetupErrorCode,
    message: string,
    options?: { cause?: unknown; role?: SyncFolderRole },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncSetupError";
    this.code = code;
    this.role = options?.role;
  }
}

export interface SyncServiceDeps {
  api: FolderApi;
  getDeviceId: () => Promise<string>;
  getAppVersion: () => Promise<string>;
  /** Epoch milliseconds. */
  now: () => number;
}

const appVersionOrUnknown = async (): Promise<string> => {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
};

export const defaultSyncServiceDeps: SyncServiceDeps = {
  api: realFolderApi,
  getDeviceId,
  getAppVersion: appVersionOrUnknown,
  now: Date.now,
};

/** What the Settings picker says about a candidate GTD folder; `null` when it is acceptable. */
export const gtdFolderProblem = (candidate: string, backupDir: string): FolderOverlap | null =>
  folderOverlap(candidate, backupDir);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The environment the host builds `sync/` or `sync-dev/` with; `null` outside the desktop app. */
export const syncEnvironmentOf = async (
  repository: AppRepository,
): Promise<SyncFolderEnvironment | null> => {
  const info = await repository.getStorageInfo();
  return info === null ? null : info.environment;
};

export interface PreparedFolders {
  gtd: string;
  personal: string;
}

/**
 * Validates and prepares both folders. Throws a {@link SyncSetupError}; nothing is written to a
 * folder whose settings are incomplete or overlapping.
 */
export const prepareFolders = async (
  deps: SyncServiceDeps,
  settings: Pick<AppSettings, "backupDestinationDir" | "syncGtdFolderDir">,
  environment: SyncFolderEnvironment,
): Promise<PreparedFolders> => {
  if (!isBackupDestinationConfigured(settings.backupDestinationDir)) {
    throw new SyncSetupError(
      "no_backup_destination",
      "Choose the backup folder first: it is the personal sync folder and where the safety backup is written",
      { role: "personal" },
    );
  }
  if (!isBackupDestinationConfigured(settings.syncGtdFolderDir)) {
    throw new SyncSetupError("no_gtd_folder", "Choose the shared GTD folder first", {
      role: "gtd",
    });
  }
  const personalDir = settings.backupDestinationDir.trim();
  const gtdDir = settings.syncGtdFolderDir.trim();
  const overlap = folderOverlap(gtdDir, personalDir);
  if (overlap !== null) {
    throw new SyncSetupError(
      "folders_overlap",
      "The shared GTD folder must be a different folder from the backup folder, and not inside it or around it",
      { role: "gtd" },
    );
  }

  const prepare = async (role: SyncFolderRole, folderDir: string, otherFolderDir: string) => {
    try {
      await deps.api.prepareSyncFolder({ folderDir, role, environment }, otherFolderDir);
    } catch (error) {
      const code = error instanceof SyncFolderError ? error.code : "unknown";
      throw new SyncSetupError(
        code === "role_mismatch" || code === "nested_folder"
          ? "folder_rejected"
          : "folder_unavailable",
        messageOf(error),
        { cause: error, role },
      );
    }
  };
  // The shared folder first: it is the one that can leak the most if it is the wrong folder.
  await prepare("gtd", gtdDir, personalDir);
  await prepare("personal", personalDir, gtdDir);
  return { gtd: gtdDir, personal: personalDir };
};

export type EnableStep = "folders" | "identity" | "capture" | "saving";

export interface EnableSyncResult {
  identity: SyncIdentityResult;
  /** `repaired`: the database came from another laptop (a clone or a restore) and was re-identified. */
  capture: { installed: boolean; backfilled: number; durationMs: number };
  folders: PreparedFolders;
}

export interface EnableSyncInput {
  repository: AppRepository;
  settings: AppSettings;
  updateSettings: (updater: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  deps?: SyncServiceDeps;
  onStep?: (step: EnableStep) => void;
}

/** Throws unless sync can run on this device with these settings (profile and storage). */
export const assertSyncSupported = async (
  repository: AppRepository,
  settings: Pick<AppSettings, "syncProfile">,
): Promise<SyncFolderEnvironment> => {
  const status = await repository.getSyncStatus();
  const environment = status.supported ? await syncEnvironmentOf(repository) : null;
  if (!status.supported || environment === null) {
    throw new SyncSetupError(
      "unsupported_preview",
      "Multi-device sync is unavailable in browser preview",
    );
  }
  if (settings.syncProfile !== "personal") {
    throw new SyncSetupError(
      "unsupported_profile",
      `The "${String(settings.syncProfile)}" sync profile is not supported yet`,
    );
  }
  return environment;
};

/**
 * Turns sync on for this device: folders, identity, change capture, then the setting. Safe to run
 * again after a failure at any step. The backfill is one write transaction over every synced row; it
 * is timed and the duration is returned (see `docs/multi-device-sync.md` for what that means on a
 * large database).
 */
export const enableSync = async (input: EnableSyncInput): Promise<EnableSyncResult> => {
  const { repository, settings, updateSettings } = input;
  const deps = input.deps ?? defaultSyncServiceDeps;
  const environment = await assertSyncSupported(repository, settings);

  let deviceName: string;
  try {
    deviceName = normalizeDeviceName(settings.syncDeviceName);
  } catch (error) {
    throw new SyncSetupError("device_name_invalid", messageOf(error), { cause: error });
  }
  if (deviceName.length === 0) {
    throw new SyncSetupError("device_name_invalid", "Give this laptop a name");
  }

  input.onStep?.("folders");
  const folders = await prepareFolders(deps, settings, environment);

  input.onStep?.("identity");
  let deviceId: string;
  try {
    deviceId = await deps.getDeviceId();
  } catch (error) {
    throw new SyncSetupError("no_device_id", messageOf(error), { cause: error });
  }
  const identity = await repository.ensureSyncIdentity({ deviceId, deviceName });
  if (identity.repaired) {
    logDebug(
      "warn",
      "sync.setup",
      "L'identite de sync de cette base venait d'un autre ordinateur: reecrite",
    );
  }

  input.onStep?.("capture");
  const startedAt = deps.now();
  let capture: { installed: boolean; backfilled: number };
  try {
    capture = await repository.enableSyncCapture();
  } catch (error) {
    throw new SyncSetupError("capture_failed", messageOf(error), { cause: error });
  }
  const durationMs = deps.now() - startedAt;
  logDebug("info", "sync.setup", "Capture des changements activee", {
    backfilled: capture.backfilled,
    durationMs,
  });

  input.onStep?.("saving");
  await updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: true }));
  return { identity, capture: { ...capture, durationMs }, folders };
};

/** Only turns the setting off: identity, capture and folder files stay. */
export const disableSync = async (
  updateSettings: EnableSyncInput["updateSettings"],
): Promise<void> => {
  await updateSettings((current) => ({ ...current, multiDeviceSyncEnabled: false }));
};

export interface BuildEngineInput {
  repository: AppRepository;
  settings: AppSettings;
  /** The settings as they are when the engine asks (the safety backup reads the destination then). */
  getSettings: () => AppSettings;
  deps?: SyncServiceDeps;
  /** Called with each safety backup, so the caller can record it as the latest backup. */
  onBackup?: (backup: BackupResult) => void | Promise<void>;
}

export interface BuiltSyncEngine {
  engine: SyncEngine;
  transports: FolderTransport[];
  deviceId: string;
  /** What `ensureSyncIdentity` did just now: a rename, or `repaired` for a cloned database. */
  identity: SyncIdentityResult;
}

/** The pre-merge backup: this laptop's backup destination, named and pruned per device. */
export const createSafetyBackup =
  (
    repository: AppRepository,
    deviceId: string,
    getSettings: () => AppSettings,
    onBackup?: (backup: BackupResult) => void | Promise<void>,
  ): EnsureSafetyBackup =>
  async () => {
    if (!isBackupDestinationConfigured(getSettings().backupDestinationDir)) {
      throw new SyncSetupError(
        "no_backup_destination",
        "No backup folder is configured, so the safety backup cannot be made",
        { role: "personal" },
      );
    }
    const backup = await repository.createBackup("auto", { deviceId });
    logDebug("info", "sync.backup", "Backup de securite avant la premiere fusion", {
      path: backup.backupPath,
    });
    try {
      await onBackup?.(backup);
    } catch (error) {
      // The backup exists; failing to note it must not stop the merge it protects.
      logDebug("warn", "sync.backup", "Backup de securite cree mais non enregistre", error);
    }
    return { path: backup.backupPath };
  };

/** Builds the engine for the current settings. Throws {@link SyncSetupError}. */
export const buildSyncEngine = async (input: BuildEngineInput): Promise<BuiltSyncEngine> => {
  const { repository, settings } = input;
  const deps = input.deps ?? defaultSyncServiceDeps;
  const environment = await assertSyncSupported(repository, settings);

  let deviceId: string;
  try {
    deviceId = await deps.getDeviceId();
  } catch (error) {
    throw new SyncSetupError("no_device_id", messageOf(error), { cause: error });
  }

  // The device-id file is the authority for the identity: a database restored or cloned from
  // another laptop is re-identified here (clocks and counters are kept), and a rename in Settings
  // reaches the identity the manifest is written from. Idempotent.
  let deviceName: string;
  try {
    deviceName = normalizeDeviceName(settings.syncDeviceName);
  } catch (error) {
    throw new SyncSetupError("device_name_invalid", messageOf(error), { cause: error });
  }
  const identity = await repository.ensureSyncIdentity({ deviceId, deviceName });

  // Backing up writes the whole database into the backup folder: if that is (or holds, or is in)
  // the shared GTD folder, nothing runs until the user fixes it.
  if (backupDestinationOverlap(settings) !== null) {
    throw new SyncSetupError(
      "folders_overlap",
      "The backup folder overlaps the shared GTD folder",
      { role: "gtd" },
    );
  }

  const transports: FolderTransport[] = [];
  if (isBackupDestinationConfigured(settings.syncGtdFolderDir)) {
    transports.push(
      createFolderTransport({
        role: "gtd",
        folderDir: settings.syncGtdFolderDir.trim(),
        environment,
        deviceId,
        api: deps.api,
      }),
    );
  }
  if (isBackupDestinationConfigured(settings.backupDestinationDir)) {
    transports.push(
      createFolderTransport({
        role: "personal",
        folderDir: settings.backupDestinationDir.trim(),
        environment,
        deviceId,
        api: deps.api,
      }),
    );
  }
  if (transports.length === 0) {
    throw new SyncSetupError("no_folders", "No sync folder is configured");
  }

  const engine = createSyncEngine({
    repo: repository,
    transports,
    profile: "personal",
    now: deps.now,
    appVersion: await deps.getAppVersion(),
    calendarSyncEnabled: async () => (await repository.getCalendarSyncSettings()).enabled,
    beforeFirstMerge: createSafetyBackup(repository, deviceId, input.getSettings, input.onBackup),
  });
  return { engine, transports, deviceId, identity };
};
