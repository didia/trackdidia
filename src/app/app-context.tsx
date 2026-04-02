import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AppSettings } from "../domain/types";
import { AiCoachService } from "../lib/ai/coach-service";
import { DebugPanel } from "../components/DebugPanel";
import { OpenAiProvider } from "../lib/ai/openai-provider";
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
import { AUTO_BACKUP_CHECK_INTERVAL_MS, isAutoBackupDue } from "../lib/backup";
import { usePomodoroController, type PomodoroControllerValue } from "./use-pomodoro-controller";
import { getTodayDate } from "../lib/date";

export interface AppContextValue {
  repository: AppRepository;
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
  coachService: AiCoachService;
  browserPreview: boolean;
  debugEnabled: boolean;
  setDebugEnabled: (enabled: boolean) => void;
  pomodoro: PomodoroControllerValue;
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
  const [repository, setRepository] = useState<AppRepository | null>(null);
  const [settings, setSettings] = useState(defaultAppSettings());
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState("Demarrage du bootstrap");
  const [debugEnabled, setDebugEnabledState] = useState(getDebugEnabled());
  const coachService = useMemo(() => new AiCoachService(new OpenAiProvider()), []);
  const startupStageRef = useRef(startupStage);
  const autoBackupRunningRef = useRef(false);
  const pomodoro = usePomodoroController(repository);

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

    const runAutoBackupIfDue = async (trigger: "startup" | "interval") => {
      if (autoBackupRunningRef.current || !settings.autoBackupEnabled) {
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

    void runAutoBackupIfDue("startup");
    const intervalId = window.setInterval(() => {
      void runAutoBackupIfDue("interval");
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
        markStage("Creation du repository");
        const nextRepository = await createRepository();
        markStage("Chargement des parametres");
        let nextSettings = await nextRepository.getSettings();
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
          markStage("Import initial des taches GTD");
          const summary = await nextRepository.importGoogleTasksExport(initialGoogleTasksExport);
          nextSettings = {
            ...nextSettings,
            gtdImportDoneAt: new Date().toISOString()
          };
          await nextRepository.saveSettings(nextSettings);
          logDebug("info", "app.bootstrap", "Import Google Tasks termine", summary);
        }

        if (!nextSettings.gtdReferencesMigrationDoneAt) {
          markStage("Migration des references");
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
          markStage("Normalisation des taches planifiees");
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
          markStage("Consolidation des taches recurrentes");
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

        markStage("Generation des recurrences du jour");
        const generatedCount = await nextRepository.generateDueRecurringTasks(getTodayDate());
        logDebug("info", "app.bootstrap", "Generation des recurrences terminee", {
          generatedCount
        });

        markStage("Generation des activites relationnelles du jour");
        const generatedRelationshipCount = await nextRepository.generateDailyRelationshipTasks(getTodayDate());
        nextSettings = await nextRepository.getSettings();
        logDebug("info", "app.bootstrap", "Generation des activites relationnelles terminee", {
          generatedRelationshipCount
        });

        markStage("Finalisation du bootstrap");

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
          error instanceof Error ? error.message : "Erreur inconnue pendant l'initialisation.";
        await activateFallback(message, error);
      }
    };

    const timeoutId = window.setTimeout(() => {
      void activateFallback(
        `Timeout de demarrage apres 8 secondes. Etape en cours: ${startupStageRef.current}`
      );
    }, 8_000);

    void bootstrap();

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
            <p className="eyebrow">Trackdidia</p>
            <h1>Preparation de ton espace quotidien...</h1>
            <p>Initialisation du stockage local et des routines.</p>
            <p><strong>Etape:</strong> {startupStage}</p>
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
        pomodoro
      }}
    >
      {startupError ? (
        <div className="banner">
          Echec du stockage SQLite au demarrage. L'application utilise un mode temporaire non persistant.
          <br />
          Detail: {startupError}
        </div>
      ) : null}
      {children}
      <DebugPanel enabled={debugEnabled} forced={Boolean(startupError)} />
    </AppContext.Provider>
  );
};

export { AppContext };
