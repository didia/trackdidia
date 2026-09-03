export const AUTO_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BACKUP_RETENTION_COUNT = 30;
export const BACKUP_FILE_NAME_PATTERN = /^trackdidia-(manual|auto)-backup-.+\.db$/;
export const MISSING_BACKUP_DESTINATION_ERROR =
  "Choisis un dossier de backup dans Paramètres avant d'exporter un snapshot.";

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

export const resolveBackupDir = (
  destinationDir: string,
  environment: "development" | "production"
): string => {
  const trimmed = destinationDir.replace(/[/\\]+$/, "");
  const subdir = environment === "development" ? "backups-dev" : "backups";
  return `${trimmed}/${subdir}`;
};

const backupSortKey = (name: string): string =>
  name.replace(/^trackdidia-(?:manual|auto)-backup-/, "").replace(/\.db$/, "");

export const selectBackupsToPrune = (
  names: string[],
  keep = BACKUP_RETENTION_COUNT
): string[] => {
  const matching = names
    .filter((name) => BACKUP_FILE_NAME_PATTERN.test(name))
    .sort((left, right) => backupSortKey(right).localeCompare(backupSortKey(left)));

  return matching.slice(keep).sort((left, right) => backupSortKey(left).localeCompare(backupSortKey(right)));
};
