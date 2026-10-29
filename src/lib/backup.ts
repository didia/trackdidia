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
