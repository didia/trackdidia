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
import { Link, useNavigate } from "react-router-dom";
import { FirstRunProfileChoice } from "../components/FirstRunProfileChoice";
import { BackupOverlapBanner } from "../components/BackupOverlapBanner";
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
import { syncAutomationKeyFor } from "../lib/sync/gate";
import { isTauriRuntime } from "../lib/storage/factory";
import type { AppRepository } from "../lib/storage/repository";
import { useAutoBackupScheduler } from "./use-auto-backup-scheduler";
import { useBootstrap } from "./use-bootstrap";
import { notifyGtdExternalChange } from "./gtd-external-change";
import { useCalendarSync } from "./use-calendar-sync";
import { useDesktopShell } from "./use-desktop-shell";
import { useLlmBridge, type LlmBridgeStatus } from "./use-llm-bridge";
import { useLocalDayReconciliation } from "./use-local-day-reconciliation";
import { type MultiDeviceSyncController, useMultiDeviceSync } from "./use-multi-device-sync";
import { usePomodoroController, type PomodoroControllerValue } from "./use-pomodoro-controller";
import { usePulseScheduler } from "./use-pulse-scheduler";

export interface AppContextValue {
  repository: AppRepository;
  settings: AppSettings;
  deviceProfile: AppSettings["syncProfile"];
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
  /** State of the local MCP endpoint for LLM clients (Settings shows it). */
  llmBridgeStatus: LlmBridgeStatus;
  /** Re-attempts starting the endpoint after a failure, without changing any setting. */
  retryLlmBridge: () => void;
  /** EXPERIMENTAL multi-device sync (manual and automatic; see `docs/multi-device-sync.md`). */
  sync: MultiDeviceSyncController;
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
  // Backups and automatic multi-device syncs (the startup pull included) take turns in this lane.
  const [syncLane] = useState(createSerialQueue);
  const {
    repository,
    settings,
    setSettings,
    loading,
    startupError,
    startupStage,
    startupSync,
    profileChoice,
  } = useBootstrap({ runExclusive: syncLane.run });
  const navigate = useNavigate();
  const [debugEnabled, setDebugEnabledState] = useState(getDebugEnabled);
  const [syncRevision, setSyncRevision] = useState(0);
  const coachService = useMemo(() => new CoachPulseService(new OpenRouterProvider()), []);
  const [startupWorkQueue] = useState(createSerialQueue);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const calendarDay = useLocalDayReconciliation(
    repository,
    settings.syncProfile === "personal" && settings.financeEnabled,
    settings.syncProfile === "personal" && settings.financeNotifyRunout,
  );
  const pomodoro = usePomodoroController(repository, calendarDay, syncRevision);
  const pomodoroRef = useRef(pomodoro);
  pomodoroRef.current = pomodoro;
  const browserPreview = !isTauriRuntime();
  useDesktopShell({ browserPreview, allowStart: !loading && !startupError, settings });
  // Never mounted under the startup fallback or browser preview: zero API/vault access.
  useCalendarSync(repository, {
    browserPreview,
    allowStart: !loading && !startupError,
  });

  const { status: llmBridgeStatus, retry: retryLlmBridge } = useLlmBridge(repository, {
    browserPreview,
    allowStart: !loading && !startupError,
    enabled: settings.llmBridgeEnabled,
    port: settings.llmBridgePort,
    token: settings.llmBridgeToken,
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

  // Data merged from another laptop reaches the screens that are already open: GTD, Today and Daily
  // through the external-change channel, the Pomodoro views through their reload key. (The calendar
  // day does not change within a day, so the day-boundary republish alone would not reach them.)
  const onSyncDataChanged = useCallback(() => {
    notifyGtdExternalChange();
    setSyncRevision((current) => current + 1);
  }, []);
  // Anything automatic exists only with the debug gate open AND sync enabled, on the desktop storage.
  const syncAutomationKey = syncAutomationKeyFor({
    browserPreview,
    startupError,
    debugEnabled,
    settings,
  });
  const sync = useMultiDeviceSync(repository, {
    browserPreview,
    getSettings,
    updateSettings,
    automationKey: syncAutomationKey,
    startupSync,
    runExclusive: syncLane.run,
    onDataChanged: onSyncDataChanged,
  });

  useEffect(() => {
    installDebugInstrumentation();
    logDebug("info", "app.bootstrap", "Demarrage du bootstrap React", {
      debugEnabled: getDebugEnabled(),
      tauriRuntime: isTauriRuntime(),
    });
  }, []);

  const pulseRevision = usePulseScheduler(
    settings.syncProfile === "personal" ? repository : null,
    coachService,
    getFocusSessionActive,
    {
      getSettings,
      updateSettings,
      enqueueStartupWork,
    },
  );
  useAutoBackupScheduler(repository, getSettings, publishSettings, {
    enqueueStartupWork,
    // Only a session with automatic sync has anything to take turns with; otherwise the backup runs
    // exactly as it did before sync existed.
    ...(syncAutomationKey === null ? {} : { runExclusive: syncLane.run }),
  });

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
            deviceProfile: settings.syncProfile,
            updateSettings,
            coachService,
            browserPreview,
            debugEnabled,
            setDebugEnabled,
            pomodoro,
            pulseRevision,
            calendarDay,
            llmBridgeStatus,
            retryLlmBridge,
            sync,
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
      llmBridgeStatus,
      retryLlmBridge,
      sync,
    ],
  );

  if (profileChoice) {
    return (
      <FirstRunProfileChoice
        {...profileChoice}
        onJoin={() => {
          void profileChoice.choose("personal").then((ok) => {
            if (ok) navigate("/parametres");
          });
        }}
      />
    );
  }

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
      {isTauriRuntime() ? <BackupOverlapBanner settings={settings} /> : null}
      {children}
      <DebugPanel enabled={debugEnabled} forced={Boolean(startupError)} />
    </AppContext.Provider>
  );
};

export { AppContext };
