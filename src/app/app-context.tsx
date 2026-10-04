import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DebugPanel } from "../components/DebugPanel";
import type { SettingsUpdater } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { isBackupDestinationMissing } from "../lib/backup";
import {
  getDebugEnabled,
  installDebugInstrumentation,
  logDebug,
  setDebugEnabled as persistDebugEnabled,
} from "../lib/debug";
import { rescueTimeCredentialFingerprint } from "../lib/rescuetime/credential-fingerprint";
import { createSerialQueue } from "../lib/serial-queue";
import { isTauriRuntime } from "../lib/storage/factory";
import type { AppRepository } from "../lib/storage/repository";
import { useAutoBackupScheduler } from "./use-auto-backup-scheduler";
import { useBootstrap } from "./use-bootstrap";
import { useEmailTriageCoordinator } from "./use-email-triage-coordinator";
import { useLocalDayReconciliation } from "./use-local-day-reconciliation";
import { usePomodoroController, type PomodoroControllerValue } from "./use-pomodoro-controller";
import { usePulseScheduler } from "./use-pulse-scheduler";

export interface AppContextValue {
  repository: AppRepository;
  settings: AppSettings;
  updateSettings: (updater: SettingsUpdater) => Promise<AppSettings>;
  coachService: CoachPulseService;
  browserPreview: boolean;
  debugEnabled: boolean;
  setDebugEnabled: (enabled: boolean) => void;
  pomodoro: PomodoroControllerValue;
  /** Increments when the pulse engine persists a new coach message for today. */
  pulseRevision: number;
  /** Current local `YYYY-MM-DD`. Changes when the local-day boundary reconciles. */
  calendarDay: string;
  /** Restarts email-triage polling after enable/pause/interval changes. */
  reconfigureEmailTriage: () => Promise<void>;
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
  const { repository, settings, setSettings, loading, startupError, startupStage } = useBootstrap();
  const [debugEnabled, setDebugEnabledState] = useState(getDebugEnabled);
  const coachService = useMemo(() => new CoachPulseService(new OpenRouterProvider()), []);
  const [startupWorkQueue] = useState(createSerialQueue);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const calendarDay = useLocalDayReconciliation(repository, settings.financeEnabled);
  const pomodoro = usePomodoroController(repository, calendarDay);
  const pomodoroRef = useRef(pomodoro);
  pomodoroRef.current = pomodoro;
  const browserPreview = !isTauriRuntime();
  const { reconfigure: reconfigureEmailTriage } = useEmailTriageCoordinator(repository, {
    browserPreview,
    allowStart: !loading && !startupError,
    settings,
  });

  const getSettings = useCallback(() => settingsRef.current, []);
  const getFocusSessionActive = useCallback(() => {
    const activeSession = pomodoroRef.current.state.activeSession;
    return activeSession?.kind === "focus" && activeSession.status === "running";
  }, []);
  const enqueueStartupWork = useCallback(
    (work: () => Promise<void>) => startupWorkQueue.run(work),
    [startupWorkQueue],
  );

  const publishSettings = useCallback(
    (nextSettings: AppSettings) => {
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
    },
    [setSettings],
  );

  const updateSettings = useCallback(
    async (updater: SettingsUpdater) => {
      if (!repository) throw new Error("Repository is not initialized");
      let previousKey = "";
      const nextSettings = await repository.updateSettings((current) => {
        previousKey = current.rescuetimeApiKey.trim();
        return updater(current);
      });
      publishSettings(nextSettings);
      const nextKey = nextSettings.rescuetimeApiKey.trim();
      if (previousKey !== nextKey) {
        // Never log the key. Cache correctness already uses credential fingerprints.
        try {
          await repository.pruneRescueTimeSnapshotCache(
            nextKey ? await rescueTimeCredentialFingerprint(nextKey) : null,
          );
        } catch {
          // Housekeeping failure must not fail a successfully persisted update.
        }
      }
      return nextSettings;
    },
    [repository, publishSettings],
  );

  useEffect(() => {
    installDebugInstrumentation();
    logDebug("info", "app.bootstrap", "Demarrage du bootstrap React", {
      debugEnabled: getDebugEnabled(),
      tauriRuntime: isTauriRuntime(),
    });
  }, []);

  const pulseRevision = usePulseScheduler(repository, coachService, getFocusSessionActive, {
    getSettings,
    updateSettings,
    enqueueStartupWork,
  });
  useAutoBackupScheduler(repository, getSettings, publishSettings, { enqueueStartupWork });

  const setDebugEnabled = useCallback((enabled: boolean) => {
    persistDebugEnabled(enabled);
    setDebugEnabledState(enabled);
    logDebug("info", "debug", enabled ? "Mode debug active" : "Mode debug desactive");
  }, []);

  const value = useMemo<AppContextValue | null>(
    () =>
      repository
        ? {
            repository,
            settings,
            updateSettings,
            coachService,
            browserPreview,
            debugEnabled,
            setDebugEnabled,
            pomodoro,
            pulseRevision,
            calendarDay,
            reconfigureEmailTriage,
          }
        : null,
    [
      repository,
      settings,
      updateSettings,
      coachService,
      browserPreview,
      debugEnabled,
      setDebugEnabled,
      pomodoro,
      pulseRevision,
      calendarDay,
      reconfigureEmailTriage,
    ],
  );

  if (loading || !value) {
    return (
      <>
        <div className="splash">
          <div className="splash__panel">
            <p className="eyebrow">{tCommon("brand")}</p>
            <h1>{tCommon("startup.splashTitle")}</h1>
            <p>{tCommon("startup.splashBody")}</p>
            <p>
              <strong>{tCommon("startup.stageLabel")}</strong> {startupStage}
            </p>
          </div>
        </div>
        <DebugPanel enabled forced />
      </>
    );
  }

  return (
    <AppContext.Provider value={value}>
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
