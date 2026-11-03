import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calendarPeerWarning } from "../lib/sync/calendar-peer-guard";
import type { SyncConflict, SyncConflictResolution } from "../lib/sync/conflicts";
import type { AppSettings } from "../domain/types";
import { logDebug } from "../lib/debug";
import { backfillPercent, runSyncCaptureBackfill } from "../lib/sync/backfill-driver";
import type { SyncBackfillProgress } from "../lib/sync/backfill-state";
import type { EngineStatus, SyncNowReport } from "../lib/sync/engine-types";
import type { IgnoredSyncEntry } from "../lib/sync/folder-api";
import {
  classifyPublish,
  classifyPull,
  classifyThrown,
  deriveSyncChip,
  pullChangedData,
  type RunClass,
  type SyncChip,
  worstClass,
} from "../lib/sync/lifecycle-policy";
import type { ExitBridge, QuitWindow } from "../lib/sync/quit-publish";
import type { StartupSync } from "../lib/sync/startup-sync";
import {
  type BuiltSyncEngine,
  buildSyncEngine,
  defaultSyncServiceDeps,
  disableSync,
  type EnableStep,
  type EnableSyncResult,
  enableSync,
  prepareFolders,
  syncEnvironmentOf,
  SyncSetupError,
  type SyncServiceDeps,
  syncEngineKeyOf,
} from "../lib/sync/sync-service";
import type { AppRepository } from "../lib/storage/repository";
import { confirmJoin, inspectJoin, type JoinPreview } from "../lib/sync/join-service";
import type { DeviceProfile } from "../lib/sync/profile";
import type { PullReport } from "../lib/sync/engine-types";
import { useSyncAutomation } from "./use-sync-automation";

/**
 * Holds the state of the EXPERIMENTAL multi-device sync around the plain functions of
 * `lib/sync/sync-service.ts`: the engine built from the settings, the last status and the last
 * run, and the actions the Settings card and the `/sync` page call. The automatic triggers (startup
 * pull, focus and hourly pull, debounced / blur / quit publish) are `lib/sync/lifecycle.ts`, wired to
 * the window by `use-sync-automation.ts`; they exist only while `automationKey` is non-null (debug
 * enabled), share this hook's engine, and never run while a manual action does.
 *
 * It lives in `AppProvider`, so the last report survives navigating between Settings and `/sync`.
 */

export type SyncPhase = "idle" | "enabling" | "disabling" | "syncing" | "checking" | "resuming";

/**
 * Where the capture backfill stands, for the Settings card and the `/sync` page. Present while a
 * pass is running (this session's enable, or one an earlier session left unfinished); `null` when
 * there is nothing to show.
 */
export interface BackfillView {
  percent: number;
  scannedRows: number;
  totalRows: number;
}

const viewOf = (progress: SyncBackfillProgress | null): BackfillView | null =>
  progress === null
    ? null
    : {
        percent: backfillPercent(progress, false),
        scannedRows: progress.scannedRows,
        totalRows: progress.totalRows,
      };

/** What the UI shows for a failure; matched on `code`, never on the message. */
export interface SyncUiError {
  /** A `SyncSetupErrorCode`, `already_running`, or `unexpected`. */
  code: string;
  message: string;
  role?: "gtd" | "personal";
}

export interface SyncRunRecord {
  finishedAtMs: number;
  /** `null` when the run threw before it produced a report. */
  report: SyncNowReport | null;
  error: SyncUiError | null;
}

export interface FolderIgnored {
  transport: string;
  entries: IgnoredSyncEntry[];
}

export interface MultiDeviceSyncController {
  /** False in browser preview and under the startup fallback: nothing here persists. */
  supported: boolean;
  phase: SyncPhase;
  enableStep: EnableStep | null;
  enableResult: EnableSyncResult | null;
  /** The last failure of enabling, disabling, checking the folders or building the engine. */
  setupError: SyncUiError | null;
  /** The engine's view (peers, pending changes, issues); `null` before the first refresh. */
  status: EngineStatus | null;
  /** Files the last listing of each folder ignored (stray files, Drive conflict copies). */
  ignored: FolderIgnored[];
  /** The capture backfill while it is unfinished (running now, or interrupted earlier). */
  backfill: BackfillView | null;
  /** The last Sync now. */
  run: SyncRunRecord | null;
  /** The status chip: what automatic and manual syncing are doing right now. */
  chip: SyncChip;
  /** The identity was rewritten to this device's id at the last engine build (a cloned database). */
  identityRepaired: boolean;
  conflicts: SyncConflict[];
  resolveConflict(id: string, resolution: SyncConflictResolution): Promise<void>;
  enable(): Promise<void>;
  /**
   * Continues an interrupted backfill ("Reprendre l'initialisation"). With sync not yet turned on it
   * is the enable flow again (every step is safe to repeat); with sync on it only runs the chunks.
   */
  resumeBackfill(): Promise<void>;
  disable(): Promise<void>;
  uninstall(): Promise<void>;
  checkCalendarPeers(): Promise<string | null>;
  publishCalendarState(): Promise<boolean>;
  syncNow(options?: { approveStalePeers?: readonly string[] }): Promise<void>;
  refresh(): Promise<void>;
  /** Re-prepares both folders (after the backup folder or the shared folder was changed). */
  recheckFolders(): Promise<void>;
  inspectJoin(settings: AppSettings, profile: DeviceProfile): Promise<JoinPreview | null>;
  join(settings: AppSettings, profile: DeviceProfile, peerId: string): Promise<PullReport | null>;
}

/** A controller that does nothing: tests that do not care about sync, and the browser preview. */
export const inertSyncController: MultiDeviceSyncController = {
  supported: false,
  phase: "idle",
  enableStep: null,
  enableResult: null,
  setupError: null,
  status: null,
  ignored: [],
  backfill: null,
  run: null,
  chip: { state: "idle", lastOkAtMs: null, retryAtMs: null },
  identityRepaired: false,
  conflicts: [],
  resolveConflict: async () => undefined,
  enable: async () => undefined,
  resumeBackfill: async () => undefined,
  disable: async () => undefined,
  uninstall: async () => undefined,
  checkCalendarPeers: async () => null,
  publishCalendarState: async () => true,
  syncNow: async () => undefined,
  refresh: async () => undefined,
  recheckFolders: async () => undefined,
  inspectJoin: async () => null,
  join: async () => null,
};

export const toSyncUiError = (error: unknown): SyncUiError => {
  if (error instanceof SyncSetupError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.role === undefined ? {} : { role: error.role }),
    };
  }
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unexpected";
  return { code, message: error instanceof Error ? error.message : String(error) };
};

export interface UseMultiDeviceSyncOptions {
  browserPreview: boolean;
  /** Reads the CURRENT settings (the ones just saved included). */
  getSettings: () => AppSettings;
  updateSettings: (updater: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  deps?: SyncServiceDeps;
  /**
   * `null` or absent: no automatic trigger exists. Otherwise `syncEngineKeyOf(settings)` of a
   * session whose sync is enabled (`isSyncAutomationEnabled`).
   */
  automationKey?: string | null;
  /** The engine and pull started during bootstrap, adopted when its key matches. */
  startupSync?: StartupSync | null;
  /** Serializes automatic syncs with backups (the app's exclusive lane). Defaults to no queue. */
  runExclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Data was merged from another laptop: reload the open screens. */
  onDataChanged?: () => void;
  /** Test seam: the window whose close request publishes. Defaults to the Tauri window. */
  quitWindow?: () => Promise<QuitWindow>;
  /** Test seam: the event bus and commands of the tray-quit handshake. Defaults to Tauri's. */
  exitBridge?: () => Promise<ExitBridge>;
}

const runDirectly = <T>(work: () => Promise<T>): Promise<T> => work();

export const useMultiDeviceSync = (
  repository: AppRepository | null,
  options: UseMultiDeviceSyncOptions,
): MultiDeviceSyncController => {
  const { browserPreview, getSettings, updateSettings } = options;
  const deps = options.deps ?? defaultSyncServiceDeps;
  const [supported, setSupported] = useState(!browserPreview);
  const [phase, setPhase] = useState<SyncPhase>("idle");
  const [enableStep, setEnableStep] = useState<EnableStep | null>(null);
  const [enableResult, setEnableResult] = useState<EnableSyncResult | null>(null);
  const [setupError, setSetupError] = useState<SyncUiError | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [ignored, setIgnored] = useState<FolderIgnored[]>([]);
  const [run, setRun] = useState<SyncRunRecord | null>(null);
  const [backfill, setBackfill] = useState<BackfillView | null>(null);
  const [identityRepaired, setIdentityRepaired] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);

  const built = useRef<{ key: string; engine: BuiltSyncEngine } | null>(null);
  const busy = useRef(false);
  const runExclusive = options.runExclusive ?? runDirectly;
  const latest = useRef({
    repository,
    getSettings,
    updateSettings,
    deps,
    runExclusive,
    onDataChanged: options.onDataChanged,
  });
  latest.current = {
    repository,
    getSettings,
    updateSettings,
    deps,
    runExclusive,
    onDataChanged: options.onDataChanged,
  };

  /** One action at a time; a second request while one runs is ignored, not queued. */
  const exclusive = useCallback(
    async (next: SyncPhase, action: () => Promise<void>): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setPhase(next);
      setSetupError(null);
      try {
        await action();
      } catch (error) {
        const uiError = toSyncUiError(error);
        if (uiError.code === "unsupported_preview") setSupported(false);
        logDebug("warn", "sync.ui", "Action de synchronisation en echec", {
          phase: next,
          code: uiError.code,
        });
        setSetupError(uiError);
      } finally {
        busy.current = false;
        setPhase("idle");
        setEnableStep(null);
      }
    },
    [],
  );

  const recordBackup = useCallback(async (backup: { createdAt: string; backupPath: string }) => {
    await latest.current.updateSettings((stored) => ({
      ...stored,
      lastBackupAt: backup.createdAt,
      lastBackupPath: backup.backupPath,
    }));
  }, []);

  const ensureEngine = useCallback(async (): Promise<BuiltSyncEngine> => {
    const current = latest.current;
    if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
    const settings = current.getSettings();
    const key = syncEngineKeyOf(settings);
    if (built.current?.key === key) return built.current.engine;
    const engine = await buildSyncEngine({
      repository: current.repository,
      settings,
      getSettings: current.getSettings,
      deps: current.deps,
      onBackup: recordBackup,
    });
    built.current = { key, engine };
    setIdentityRepaired(engine.identity.repaired);
    return engine;
  }, [recordBackup]);

  /** The engine built during bootstrap becomes this hook's engine (one engine per session). */
  const adoptEngine = useCallback(
    (startup: StartupSync) => {
      if (built.current?.key !== startup.key) {
        built.current = { key: startup.key, engine: startup.built };
        setIdentityRepaired(startup.built.identity.repaired);
      }
      // From now on the engine reads the app's live settings and records its backups through them.
      startup.binding.getSettings = () => latest.current.getSettings();
      startup.binding.onBackup = recordBackup;
    },
    [recordBackup],
  );

  /** Data merged from another laptop: the settings copy and the open screens catch up. */
  const dataChanged = useCallback(() => {
    // Settings merged from a peer reach the app's own copy of them.
    latest.current
      .updateSettings((stored) => stored)
      .catch((caught) => {
        logDebug("warn", "sync.ui", "Rechargement des reglages apres fusion en echec", caught);
      });
    latest.current.onDataChanged?.();
  }, []);

  const automation = useSyncAutomation({
    repository,
    automationKey: options.automationKey ?? null,
    startupSync: options.startupSync ?? null,
    now: () => latest.current.deps.now(),
    ensureEngine,
    adoptEngine,
    busy,
    runExclusive: (work) => latest.current.runExclusive(work),
    getSettings: () => latest.current.getSettings(),
    onDataChanged: dataChanged,
    ...(options.quitWindow ? { quitWindow: options.quitWindow } : {}),
    ...(options.exitBridge ? { exitBridge: options.exitBridge } : {}),
  });

  const readStatus = useCallback(async (engine: BuiltSyncEngine) => {
    setStatus(await engine.engine.getStatus());
    if (latest.current.repository)
      setConflicts(await latest.current.repository.listSyncConflicts());
    setIgnored(
      engine.transports
        .map((transport) => ({
          transport: transport.id,
          entries: [...(transport.lastListing()?.ignored ?? [])],
        }))
        .filter((item) => item.entries.length > 0),
    );
  }, []);

  /** An unfinished backfill is shown whether or not sync was turned on: it can be resumed either way. */
  const readBackfill = useCallback(async () => {
    const repo = latest.current.repository;
    if (!repo) return;
    const read = await repo.getSyncStatus();
    setBackfill(
      read.supported && read.captureEnabled && !read.backfillComplete
        ? viewOf(read.backfillProgress)
        : null,
    );
  }, []);

  const refresh = useCallback(
    () =>
      exclusive("checking", async () => {
        await readBackfill();
        if (!latest.current.getSettings().multiDeviceSyncEnabled) {
          setStatus(null);
          return;
        }
        await readStatus(await ensureEngine());
      }),
    [exclusive, ensureEngine, readStatus, readBackfill],
  );

  const enable = useCallback(
    () =>
      exclusive("enabling", async () => {
        const current = latest.current;
        if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
        setEnableResult(null);
        built.current = null;
        const result = await enableSync({
          repository: current.repository,
          settings: current.getSettings(),
          updateSettings: current.updateSettings,
          deps: current.deps,
          onStep: setEnableStep,
          onBackfillProgress: (tick) => setBackfill(viewOf(tick.progress)),
        }).catch(async (error) => {
          // A stopped or failed backfill stays resumable: show where it stopped.
          await readBackfill().catch(() => undefined);
          throw error;
        });
        setBackfill(null);
        setEnableResult(result);
        setIdentityRepaired(result.identity.repaired);
        setRun(null);
        await readStatus(await ensureEngine());
      }),
    [exclusive, ensureEngine, readStatus, readBackfill],
  );

  const resumeBackfill = useCallback(async () => {
    if (!latest.current.getSettings().multiDeviceSyncEnabled) {
      await enable();
      return;
    }
    await exclusive("resuming", async () => {
      const repo = latest.current.repository;
      if (!repo) throw new SyncSetupError("unsupported_preview", "No repository");
      try {
        const result = await runSyncCaptureBackfill(repo, {
          onProgress: (tick) => setBackfill(viewOf(tick.progress)),
        });
        if (result.complete) setBackfill(null);
      } catch (error) {
        await readBackfill().catch(() => undefined);
        throw error;
      }
      await readStatus(await ensureEngine());
    });
  }, [enable, exclusive, ensureEngine, readStatus, readBackfill]);

  const disable = useCallback(
    () =>
      exclusive("disabling", async () => {
        await disableSync(latest.current.updateSettings);
        built.current = null;
        setStatus(null);
        setIgnored([]);
        setEnableResult(null);
      }),
    [exclusive],
  );

  const uninstall = useCallback(async () => {
    await exclusive("disabling", async () => {
      const lifecycle = automation.lifecycle.current;
      lifecycle?.stop();
      await lifecycle?.whenIdle();
      const current = latest.current;
      if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
      await current.runExclusive(async () => {
        await disableSync(current.updateSettings);
        built.current = null;
        await current.repository!.uninstallSyncChangeTracking();
      });
      setStatus(null);
      setBackfill(null);
    });
  }, [exclusive, automation.lifecycle]);

  const checkCalendarPeers = useCallback(async (): Promise<string | null> => {
    if (!latest.current.getSettings().multiDeviceSyncEnabled) return null;
    let warning: string | null = "Impossible de vérifier les autres ordinateurs. Réessayez.";
    await exclusive("checking", async () => {
      await automation.lifecycle.current?.whenIdle();
      const engine = await ensureEngine();
      const transport = engine.transports.find((item) => item.domains.includes("gtd"));
      if (!transport) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const peers = await Promise.race([
          transport.listPeers(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 8000);
          }),
        ]);
        const ignored = transport.lastListing()?.ignored ?? [];
        if (ignored.some((entry) => /\/manifest\.json$/.test(entry.path))) return;
        const status = await latest.current.repository?.getSyncStatus();
        if (!status?.supported) return;
        warning = calendarPeerWarning(peers, status.peers, latest.current.deps.now());
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    return warning;
  }, [ensureEngine, exclusive, automation.lifecycle]);

  const publishCalendarState = useCallback(async (): Promise<boolean> => {
    if (!latest.current.getSettings().multiDeviceSyncEnabled) return true;
    let success = false;
    await exclusive("syncing", async () => {
      await automation.lifecycle.current?.whenIdle();
      const engine = await ensureEngine();
      const report = await latest.current.runExclusive(() =>
        engine.engine.publish({ force: true }),
      );
      success =
        report.domains.some(
          (domain) => domain.domain === "gtd" && domain.outcome === "published",
        ) &&
        report.domains.every((domain) => domain.outcome === "published") &&
        !report.issues.some(
          (issue) => issue.code === "publish_skipped" || issue.severity === "error",
        );
    });
    return success;
  }, [exclusive, ensureEngine, automation.lifecycle]);

  const resolveConflict = useCallback(
    async (id: string, resolution: SyncConflictResolution) => {
      await exclusive("checking", async () => {
        const repo = latest.current.repository;
        if (!repo) throw new SyncSetupError("unsupported_preview", "No repository");
        await latest.current.runExclusive(() => repo.resolveSyncConflict(id, resolution));
        setConflicts(await repo.listSyncConflicts());
        dataChanged();
      });
    },
    [exclusive, dataChanged],
  );

  const recheckFolders = useCallback(
    () =>
      exclusive("checking", async () => {
        const current = latest.current;
        if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
        const environment = await syncEnvironmentOf(current.repository);
        if (environment === null) {
          throw new SyncSetupError("unsupported_preview", "Browser preview");
        }
        await prepareFolders(current.deps, current.getSettings(), environment);
        built.current = null;
        await readStatus(await ensureEngine());
      }),
    [exclusive, ensureEngine, readStatus],
  );

  const inspectJoinAction = useCallback(
    async (settings: AppSettings, profile: DeviceProfile) => {
      let result: JoinPreview | null = null;
      await exclusive("checking", async () => {
        const current = latest.current;
        if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
        result = await current.runExclusive(() =>
          inspectJoin({ repository: current.repository!, settings, profile, deps: current.deps }),
        );
      });
      return result;
    },
    [exclusive],
  );

  const join = useCallback(
    async (settings: AppSettings, profile: DeviceProfile, peerId: string) => {
      let result: PullReport | null = null;
      await automation.lifecycle.current?.whenIdle();
      await exclusive("syncing", async () => {
        const current = latest.current;
        if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
        result = await current.runExclusive(() =>
          confirmJoin({
            repository: current.repository!,
            settings,
            profile,
            peerId,
            getSettings: current.getSettings,
            updateSettings: current.updateSettings,
            deps: current.deps,
          }),
        );
        built.current = null;
        if (result.totals.applied > 0 || result.totals.tombstonesApplied > 0) dataChanged();
      });
      return result;
    },
    [exclusive, automation.lifecycle, dataChanged],
  );

  const syncNow = useCallback(
    async (syncOptions: { approveStalePeers?: readonly string[] } = {}) => {
      // An automatic run in flight finishes first: the engine runs one thing at a time.
      await automation.lifecycle.current?.whenIdle();
      await exclusive("syncing", async () => {
        const lifecycle = automation.lifecycle.current;
        // "Synchroniser maintenant" always runs, and lifts any backoff or block.
        lifecycle?.manualStarted();
        const engine = await ensureEngine();
        let report: SyncNowReport | null = null;
        let error: SyncUiError | null = null;
        try {
          // In the exclusive lane, so the sync never overlaps an automatic backup. (Enable and
          // resume are not: they are the capture backfill, short writer slots that take no backup,
          // and holding the lane for a whole backfill would starve the automatic backups.)
          report = await latest.current.runExclusive(() =>
            engine.engine.syncNow(
              syncOptions.approveStalePeers === undefined
                ? {}
                : { approveStalePeers: syncOptions.approveStalePeers },
            ),
          );
        } catch (caught) {
          error = toSyncUiError(caught);
        }
        const outcome: RunClass = report
          ? worstClass(classifyPull(report.pull), classifyPublish(report.publish))
          : classifyThrown(error?.code ?? "unexpected");
        lifecycle?.manualFinished(outcome, error);
        setRun({ finishedAtMs: latest.current.deps.now(), report, error });
        if (report && pullChangedData(report.pull)) dataChanged();
        await readStatus(engine);
      });
    },
    [exclusive, ensureEngine, readStatus, dataChanged, automation.lifecycle],
  );

  const lifecycleState = automation.state;
  const [chipTick, setChipTick] = useState(0);
  // The chip text counts down to a retry; one render at the retry time moves it on.
  useEffect(() => {
    const retryAt = lifecycleState?.backoffUntilMs ?? null;
    if (retryAt === null) return;
    const delay = Math.max(0, retryAt - latest.current.deps.now()) + 50;
    const timer = setTimeout(() => setChipTick((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [lifecycleState?.backoffUntilMs]);
  const chip = useMemo<SyncChip>(
    () =>
      deriveSyncChip({
        running:
          lifecycleState?.running != null ||
          phase === "syncing" ||
          phase === "enabling" ||
          phase === "resuming",
        lastClass: lifecycleState?.lastClass ?? null,
        failures: lifecycleState?.consecutiveFailures ?? 0,
        backoffUntilMs: lifecycleState?.backoffUntilMs ?? null,
        lastOkAtMs: lifecycleState?.lastOkAtMs ?? null,
        backfillIncomplete: lifecycleState?.backfillIncomplete === true || backfill !== null,
      }),
    // `chipTick` re-evaluates the chip when a backoff has just ended.
    [lifecycleState, phase, backfill, chipTick],
  );

  return useMemo<MultiDeviceSyncController>(
    () => ({
      supported,
      phase,
      enableStep,
      enableResult,
      setupError,
      status,
      ignored,
      backfill,
      run,
      chip,
      identityRepaired,
      conflicts,
      resolveConflict,
      enable,
      resumeBackfill,
      disable,
      uninstall,
      checkCalendarPeers,
      publishCalendarState,
      syncNow,
      refresh,
      recheckFolders,
      inspectJoin: inspectJoinAction,
      join,
    }),
    [
      supported,
      phase,
      enableStep,
      enableResult,
      setupError,
      status,
      ignored,
      backfill,
      run,
      chip,
      identityRepaired,
      conflicts,
      resolveConflict,
      enable,
      resumeBackfill,
      disable,
      uninstall,
      checkCalendarPeers,
      publishCalendarState,
      syncNow,
      refresh,
      recheckFolders,
      inspectJoinAction,
      join,
    ],
  );
};
