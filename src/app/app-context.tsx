import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { applyLegacyAiMaxTokensUpgrade, defaultAppSettings } from "../domain/daily-entry";
import type { AppSettings } from "../domain/types";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { DebugPanel } from "../components/DebugPanel";
import { t } from "../i18n";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import {
  getDebugEnabled,
  installDebugInstrumentation,
  logDebug,
  setDebugEnabled as persistDebugEnabled
} from "../lib/debug";
import { createRepository, isTauriRuntime } from "../lib/storage/factory";
import { MemoryRepository } from "../lib/storage/memory-repository";
import type { AppRepository } from "../lib/storage/repository";
import initialGoogleTasksExport from "../../Tasks.json";
import { buildContextId } from "../lib/gtd/shared";
import {
  AUTO_BACKUP_CHECK_INTERVAL_MS,
  isAutoBackupDue,
  isBackupDestinationConfigured,
  isBackupDestinationMissing
} from "../lib/backup";
import { PULSE_CHECK_INTERVAL_MS } from "../lib/ai/pulse/constants";
import { runPulseEngine } from "../lib/ai/pulse/pulse-engine";
import type { AppOpenInterval } from "../domain/insights/movement";
import { usePomodoroController, type PomodoroControllerValue } from "./use-pomodoro-controller";
import { getTodayDate } from "../lib/date";

export interface AppContextValue {
  repository: AppRepository;
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
  coachService: CoachPulseService;
  browserPreview: boolean;
  debugEnabled: boolean;
  setDebugEnabled: (enabled: boolean) => void;
  pomodoro: PomodoroControllerValue;
  /** Increments when the pulse engine persists a new coach message for today. */
  pulseRevision: number;
}

const AppContext = createContext<AppContextValue | null>(null);

export const useAppContext = (): AppContextValue => {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("useAppContext must be used inside AppProvider");
  }
  return value;
};

export const AppProvider = ({ children }: PropsWithChildren) => {
  const { t: tCommon } = useTranslation("common");
  const { t: tSettings } = useTranslation("settings");
  const [repository, setRepository] = useState<AppRepository | null>(null);
  const [settings, setSettings] = useState(defaultAppSettings());
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState(() => t("startup.bootstrap"));
  const [debugEnabled, setDebugEnabledState] = useState(getDebugEnabled());
  const coachService = useMemo(() => new CoachPulseService(new OpenRouterProvider()), []);
  const startupStageRef = useRef(startupStage);
  const autoBackupRunningRef = useRef(false);
  const pulseRunningRef = useRef(false);
  const startupWorkQueueRef = useRef(Promise.resolve());
  const appOpenStartedAtRef = useRef<string | null>(null);
  const appOpenIntervalsRef = useRef<AppOpenInterval[]>([]);
  const [pulseRevision, setPulseRevision] = useState(0);
  const pomodoro = usePomodoroController(repository);

  const enqueueStartupWork = (work: () => Promise<void>) => {
    startupWorkQueueRef.current = startupWorkQueueRef.current.then(work).catch((error) => {
      logDebug("error", "app.bootstrap", "Echec tache de demarrage en file", error);
    });
    return startupWorkQueueRef.current;
  };

  useEffect(() => {
    installDebugInstrumentation();
    logDebug("info", "app.bootstrap", "Demarrage du bootstrap React", {
      debugEnabled: getDebugEnabled(),
      tauriRuntime: isTauriRuntime()
    });
  }, []);

  useEffect(() => {
    if (!repository) {
      return;
    }

    let cancelled = false;

    const closeOpenInterval = () => {
      const startedAt = appOpenStartedAtRef.current;
      if (!startedAt) {
        return;
      }

      appOpenIntervalsRef.current.push({
        startedAt,
        endedAt: new Date().toISOString()
      });
      appOpenStartedAtRef.current = null;
    };

    const markAppOpen = () => {
      if (document.visibilityState !== "visible" || appOpenStartedAtRef.current) {
        return;
      }

      appOpenStartedAtRef.current = new Date().toISOString();
    };

    const runPulseEvaluation = async (trigger: "startup" | "interval") => {
      if (pulseRunningRef.current || cancelled) {
        return;
      }

      pulseRunningRef.current = true;
      logDebug("info", "ai.pulse", "Evaluation pulse", { trigger });

      try {
        const focusSessionActive =
          pomodoro.state.activeSession?.kind === "focus" &&
          pomodoro.state.activeSession.status === "running";

        const openIntervals = [...appOpenIntervalsRef.current];
        if (appOpenStartedAtRef.current) {
          openIntervals.push({
            startedAt: appOpenStartedAtRef.current,
            endedAt: new Date().toISOString()
          });
        }

        const result = await runPulseEngine({
          repository,
          coachService,
          settings,
          saveSettings: async (nextSettings) => {
            await repository.saveSettings(nextSettings);
            if (!cancelled) {
              setSettings(nextSettings);
            }
          },
          appOpenIntervals: openIntervals,
          focusSessionActive
        });

        if ((result.result || result.recordedMissed > 0) && !cancelled) {
          setPulseRevision((current) => current + 1);
        }

        logDebug("info", "ai.pulse", "Evaluation pulse terminee", {
          ranSlot: result.ranSlot?.scopeKey ?? null,
          recordedMissed: result.recordedMissed
        });
      } catch (error) {
        logDebug("error", "ai.pulse", "Echec evaluation pulse", error);
      } finally {
        pulseRunningRef.current = false;
      }
    };

    markAppOpen();
    void enqueueStartupWork(async () => {
      await runPulseEvaluation("startup");
    });

    const intervalId = window.setInterval(() => {
      runPulseEvaluation("interval").catch((error) => {
        logDebug("error", "ai.pulse", "Echec inattendu evaluation pulse (interval)", error);
      });
    }, PULSE_CHECK_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        closeOpenInterval();
        return;
      }

      markAppOpen();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      closeOpenInterval();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [repository, settings, coachService, pomodoro.state.activeSession]);

  useEffect(() => {
    if (!repository) {
      return;
    }

    let cancelled = false;

    const runAutoBackupIfDue = async (trigger: "startup" | "interval") => {
      if (autoBackupRunningRef.current || !settings.autoBackupEnabled) {
        return;
      }

      if (!isBackupDestinationConfigured(settings.backupDestinationDir)) {
        logDebug("info", "storage.backup", "Backup automatique ignore: dossier non configure", {
          trigger
        });
        return;
      }

      if (!isAutoBackupDue(settings.lastBackupAt, settings.autoBackupIntervalHours)) {
        return;
      }

      autoBackupRunningRef.current = true;
      logDebug("info", "storage.backup", "Verification backup automatique", {
        trigger,
        lastBackupAt: settings.lastBackupAt,
        intervalHours: settings.autoBackupIntervalHours
      });

      try {
        const storageInfo = await repository?.getStorageInfo();
        if (!storageInfo) {
          return;
        }

        const backup = await repository.createBackup("auto");
        const nextSettings = {
          ...settings,
          lastBackupAt: backup.createdAt,
          lastBackupPath: backup.backupPath
        };

        await repository.saveSettings(nextSettings);

        if (!cancelled) {
          setSettings(nextSettings);
        }

        logDebug("info", "storage.backup", "Backup automatique termine", backup);
      } catch (error) {
        logDebug("error", "storage.backup", "Echec du backup automatique", error);
      } finally {
        autoBackupRunningRef.current = false;
      }
    };

    void enqueueStartupWork(() => runAutoBackupIfDue("startup"));
    const intervalId = window.setInterval(() => {
      runAutoBackupIfDue("interval").catch((error) => {
        logDebug("error", "storage.backup", "Echec inattendu backup automatique (interval)", error);
      });
    }, AUTO_BACKUP_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [repository, settings]);

  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const markStage = (stage: string) => {
      startupStageRef.current = stage;
      setStartupStage(stage);
      logDebug("info", "app.bootstrap", stage);
    };

    const activateFallback = async (message: string, error?: unknown) => {
      if (settled || cancelled) {
        return;
      }

      settled = true;
      const fallbackRepository = new MemoryRepository();
      await fallbackRepository.initialize();

      if (!cancelled) {
        setRepository(fallbackRepository);
        setSettings(defaultAppSettings());
        setStartupError(message);
        setLoading(false);
        logDebug("error", "app.bootstrap", "Bootstrap en echec, fallback memoire active", error ?? message);
      }
    };

    const bootstrap = async () => {
      try {
        markStage(t("startup.createRepository"));
        const nextRepository = await createRepository();
        markStage(t("startup.loadSettings"));
        let nextSettings = await nextRepository.getSettings();
        const upgradedAiMaxTokens = applyLegacyAiMaxTokensUpgrade(nextSettings, new Date().toISOString());
        if (upgradedAiMaxTokens) {
          nextSettings = upgradedAiMaxTokens;
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Migration aiMaxTokens terminee", {
            aiMaxTokens: nextSettings.aiMaxTokens
          });
        }
        const gtdOverview = await nextRepository.getGtdOverview();
        const shouldImportGtd =
          !nextSettings.gtdImportDoneAt ||
          (gtdOverview.taskCount === 0 && gtdOverview.projectCount === 0);

        logDebug("info", "app.bootstrap", "Etat GTD au demarrage", {
          gtdImportDoneAt: nextSettings.gtdImportDoneAt,
          gtdOverview,
          shouldImportGtd
        });

        if (shouldImportGtd) {
          markStage(t("startup.importGtd"));
          const summary = await nextRepository.importGoogleTasksExport(initialGoogleTasksExport);
          nextSettings = {
            ...nextSettings,
            gtdImportDoneAt: new Date().toISOString()
          };
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Import Google Tasks termine", summary);
        }

        if (!nextSettings.gtdReferencesMigrationDoneAt) {
          markStage(t("startup.migrateReferences"));
          const movedCount = await nextRepository.moveTasksWithContextToBucket(buildContextId("Reading"), "reference");
          nextSettings = {
            ...nextSettings,
            gtdReferencesMigrationDoneAt: new Date().toISOString()
          };
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Migration Reading -> References terminee", {
            movedCount
          });
        }

        if (!nextSettings.gtdScheduledNormalizationDoneAt) {
          markStage(t("startup.normalizeScheduled"));
          const movedCount = await nextRepository.moveTasksWithScheduledDatesToBucket("scheduled");
          nextSettings = {
            ...nextSettings,
            gtdScheduledNormalizationDoneAt: new Date().toISOString()
          };
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Migration vers Scheduled terminee", {
            movedCount
          });
        }

        if (!nextSettings.gtdRecurringCollapseDoneAt) {
          markStage(t("startup.collapseRecurring"));
          const changedCount = await nextRepository.collapseGoogleRecurringTasks(initialGoogleTasksExport);
          nextSettings = {
            ...nextSettings,
            gtdRecurringCollapseDoneAt: new Date().toISOString()
          };
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Consolidation des recurrentes terminee", {
            changedCount
          });
        }

        markStage(t("startup.generateRecurrences"));
        const generatedCount = await nextRepository.generateDueRecurringTasks(getTodayDate());
        logDebug("info", "app.bootstrap", "Generation des recurrences terminee", {
          generatedCount
        });

        markStage(t("startup.generateRelationship"));
        const generatedRelationshipCount = await nextRepository.generateDailyRelationshipTasks(getTodayDate());
        nextSettings = await nextRepository.getSettings();
        logDebug("info", "app.bootstrap", "Generation des activites relationnelles terminee", {
          generatedRelationshipCount
        });

        markStage(t("startup.finalize"));

        settled = true;

        if (!cancelled) {
          setRepository(nextRepository);
          setSettings(nextSettings);
          setStartupError(null);
          setLoading(false);
          logDebug("info", "app.bootstrap", "Bootstrap termine");
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("startup.unknownError");
        await activateFallback(message, error);
      }
    };

    const timeoutId = window.setTimeout(() => {
      activateFallback(
        t("startup.timeout", { stage: startupStageRef.current })
      ).catch((error) => {
        logDebug("error", "app.bootstrap", "Echec inattendu du fallback (timeout)", error);
      });
    }, 8_000);

    bootstrap().catch((error) => {
      logDebug("error", "app.bootstrap", "Echec inattendu du bootstrap (non intercepte)", error);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (loading || !repository) {
    return (
      <>
        <div className="splash">
          <div className="splash__panel">
            <p className="eyebrow">{tCommon("brand")}</p>
            <h1>{tCommon("startup.splashTitle")}</h1>
            <p>{tCommon("startup.splashBody")}</p>
            <p><strong>{tCommon("startup.stageLabel")}</strong> {startupStage}</p>
          </div>
        </div>
        <DebugPanel enabled={true} forced={debugEnabled || true} />
      </>
    );
  }

  const saveSettings = async (nextSettings: AppSettings) => {
    setSettings(nextSettings);
    await repository.saveSettings(nextSettings);
  };

  const setDebugEnabled = (enabled: boolean) => {
    persistDebugEnabled(enabled);
    setDebugEnabledState(enabled);
    logDebug("info", "debug", enabled ? "Mode debug active" : "Mode debug desactive");
  };

  return (
    <AppContext.Provider
      value={{
        repository,
        settings,
        saveSettings,
        coachService,
        browserPreview: !isTauriRuntime(),
        debugEnabled,
        setDebugEnabled,
        pomodoro,
        pulseRevision
      }}
    >
      {startupError ? (
        <div className="banner">
          {tCommon("startup.sqliteFallback")}
          <br />
          {tCommon("startup.detail")} {startupError}
        </div>
      ) : null}
      {isTauriRuntime() && isBackupDestinationMissing(settings) ? (
        <div className="banner">
          {tSettings("backup.destinationMissing")}{" "}
          <Link to="/parametres">{tSettings("backup.destinationMissingLink")}</Link>
        </div>
      ) : null}
      {children}
      <DebugPanel enabled={debugEnabled} forced={Boolean(startupError)} />
    </AppContext.Provider>
  );
};

export { AppContext };
