export const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BACKUP_RETENTION_COUNT = 30;

export const isAutoBackupDue = (
  lastBackupAt: string,
  intervalHours: number,
  nowMs = Date.now()
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

export const buildBackupFileName = (createdAt: string, kind: "manual" | "auto"): string => {
  const safeTimestamp = createdAt.replace(/[:.]/g, "-");
  return `trackdidia-${kind}-backup-${safeTimestamp}.db`;
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
  environment: "development" | "production"
): string => {
  const trimmed = destinationDir.replace(/[/\\]+$/, "");
  const subdir = environment === "development" ? "backups-dev" : "backups";
  return `${trimmed}/${subdir}`;
};
