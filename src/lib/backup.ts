import { type FolderOverlap, folderOverlap } from "./sync/folder-paths";

export const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BACKUP_RETENTION_COUNT = 30;

export const isAutoBackupDue = (
  lastBackupAt: string,
  intervalHours: number,
  nowMs = Date.now(),
): boolean => {
  if (!lastBackupAt) {
    return true;
  }

  const lastBackupMs = new Date(lastBackupAt).getTime();
  if (!Number.isFinite(lastBackupMs)) {
    return true;
  }

  return nowMs - lastBackupMs >= Math.max(1, intervalHours) * 60 * 60 * 1000;
};

const DEVICE_ID_PATTERN =
  /^dev:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The filename-safe tag of a device id in per-device backup names: the first eight hex digits of
 * its UUID (`dev:3f1c0b9c-...` -> `3f1c0b9c`). Mirrors `device_backup_tag` in `backup.rs`, and is
 * validated against the same device-id rule so a tag can never hold a path separator or `..`.
 */
export const deviceBackupTag = (deviceId: string): string => {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error("invalid_device_id_for_backup_name");
  }
  return deviceId.slice("dev:".length, "dev:".length + 8);
};

/**
 * `trackdidia-<kind>-backup-<timestamp>.db`, or, when a device id is given (sync enabled),
 * `trackdidia-<kind>-backup-<deviceTag>-<timestamp>.db`. Retention counts per tag (see
 * `prune_backups`). Callers that do not pass a device id get exactly the legacy name.
 */
export const buildBackupFileName = (
  createdAt: string,
  kind: "manual" | "auto",
  deviceId?: string,
): string => {
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  const tag = deviceId === undefined ? "" : `${deviceBackupTag(deviceId)}-`;
  return `trackdidia-${kind}-backup-${tag}${safeTimestamp}.db`;
};

export const isBackupDestinationConfigured = (destinationDir: string | undefined): boolean =>
  Boolean(destinationDir?.trim());

export const isBackupDestinationMissing = (settings: {
  autoBackupEnabled: boolean;
  backupDestinationDir: string;
}): boolean =>
  settings.autoBackupEnabled && !isBackupDestinationConfigured(settings.backupDestinationDir);

export const resolveBackupDir = (
  destinationDir: string,
  environment: "development" | "production",
): string => {
  const trimmed = destinationDir.replace(/[/\\]+$/, "");
  const subdir = environment === "development" ? "backups-dev" : "backups";
  return `${trimmed}/${subdir}`;
};

/**
 * The backup destination relates to the shared GTD sync folder (`syncGtdFolderDir`) as the same
 * folder, a folder inside it or a folder around it; `null` when they are apart or no GTD folder is
 * set (users without sync are never affected). A backup is a full copy of the database (finance,
 * journal, AI memory): written there it would be shared with every account the GTD folder is shared
 * with, so backing up is refused while this is not `null`.
 */
export const backupDestinationOverlap = (settings: {
  backupDestinationDir: string;
  syncGtdFolderDir: string;
}): FolderOverlap | null => folderOverlap(settings.backupDestinationDir, settings.syncGtdFolderDir);

/** The prefix `backup.rs` puts on a refusal that protects the shared GTD sync folder. */
export const SYNC_FOLDER_REFUSAL_PREFIX = "overlaps_sync_folder:";

/**
 * What a rejection of the native `ensure_backup_dir` becomes: the native host rejects with a plain
 * string, which a UI catch would otherwise replace by a generic fallback. A refusal that protects the
 * shared GTD folder (the destination, or the `backups[-dev]` folder in it, is or leads there) is a
 * typed {@link BackupDestinationError}; any other message is kept as an `Error` so it stays visible.
 */
export const toBackupDirError = (error: unknown): Error => {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return message.startsWith(SYNC_FOLDER_REFUSAL_PREFIX)
    ? new BackupDestinationError(message.slice(SYNC_FOLDER_REFUSAL_PREFIX.length).trim())
    : error instanceof Error
      ? error
      : new Error(message);
};

/** A backup was refused because its destination overlaps the shared GTD sync folder. */
export class BackupDestinationError extends Error {
  readonly code = "overlaps_sync_folder";

  constructor(message: string) {
    super(message);
    this.name = "BackupDestinationError";
  }
}
