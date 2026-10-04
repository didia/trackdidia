import { useEffect, useRef } from "react";
import type { AppSettings } from "../domain/types";
import {
  AUTO_BACKUP_CHECK_INTERVAL_MS,
  isAutoBackupDue,
  isBackupDestinationConfigured,
} from "../lib/backup";
import { logDebug } from "../lib/debug";
import type { AppRepository } from "../lib/storage/repository";

export interface AutoBackupSchedulerOptions {
  /** Serializes the startup check with other startup work. */
  enqueueStartupWork?: (work: () => Promise<void>) => Promise<void>;
}

/**
 * Checks once at startup and then hourly whether an automatic backup is due. Settings are
 * read through `getSettings` at check time, so the effect only restarts when the repository
 * changes. A single in-flight guard keeps checks from running concurrently. After a backup,
 * `lastBackupAt`/`lastBackupPath` are persisted and published through `onSettingsUpdated`.
 */
export const useAutoBackupScheduler = (
  repository: AppRepository | null,
  getSettings: () => AppSettings,
  onSettingsUpdated: (settings: AppSettings) => void,
  options: AutoBackupSchedulerOptions = {},
): void => {
  const runningRef = useRef(false);
  const getSettingsRef = useRef(getSettings);
  getSettingsRef.current = getSettings;
  const onSettingsUpdatedRef = useRef(onSettingsUpdated);
  onSettingsUpdatedRef.current = onSettingsUpdated;
  const enqueueRef = useRef(options.enqueueStartupWork);
  enqueueRef.current = options.enqueueStartupWork;

  useEffect(() => {
    if (!repository) {
      return;
    }

    const runAutoBackupIfDue = async (trigger: "startup" | "interval") => {
      const settings = getSettingsRef.current();
      if (runningRef.current || !settings.autoBackupEnabled) {
        return;
      }

      if (!isBackupDestinationConfigured(settings.backupDestinationDir)) {
        logDebug("info", "storage.backup", "Backup automatique ignore: dossier non configure", {
          trigger,
        });
        return;
      }

      if (!isAutoBackupDue(settings.lastBackupAt, settings.autoBackupIntervalHours)) {
        return;
      }

      runningRef.current = true;
      logDebug("info", "storage.backup", "Verification backup automatique", {
        trigger,
        lastBackupAt: settings.lastBackupAt,
        intervalHours: settings.autoBackupIntervalHours,
      });

      try {
        const storageInfo = await repository.getStorageInfo();
        if (!storageInfo) {
          return;
        }

        const backup = await repository.createBackup("auto");
        const nextSettings = await repository.updateSettings((current) => ({
          ...current,
          lastBackupAt: backup.createdAt,
          lastBackupPath: backup.backupPath,
        }));
        onSettingsUpdatedRef.current(nextSettings);

        logDebug("info", "storage.backup", "Backup automatique termine", backup);
      } catch (error) {
        logDebug("error", "storage.backup", "Echec du backup automatique", error);
      } finally {
        runningRef.current = false;
      }
    };

    const startup = () => runAutoBackupIfDue("startup");
    const enqueue = enqueueRef.current;
    void (enqueue ? enqueue(startup) : startup()).catch((error) => {
      logDebug("error", "app.bootstrap", "Echec tache de demarrage en file", error);
    });

    const intervalId = window.setInterval(() => {
      runAutoBackupIfDue("interval").catch((error) => {
        logDebug("error", "storage.backup", "Echec inattendu backup automatique (interval)", error);
      });
    }, AUTO_BACKUP_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [repository]);
};
