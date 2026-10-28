import { useCallback, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../domain/types";
import { logDebug } from "../lib/debug";
import { backfillPercent, runSyncCaptureBackfill } from "../lib/sync/backfill-driver";
import type { SyncBackfillProgress } from "../lib/sync/backfill-state";
import type { EngineStatus, SyncNowReport } from "../lib/sync/engine-types";
import type { IgnoredSyncEntry } from "../lib/sync/folder-api";
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
} from "../lib/sync/sync-service";
import type { AppRepository } from "../lib/storage/repository";

/**
 * Holds the state of the EXPERIMENTAL multi-device sync around the plain functions of
 * `lib/sync/sync-service.ts`: the engine built from the settings, the last status and the last
 * run, and the actions the Settings card and the `/sync` page call. Manual only in this build: it
 * starts nothing by itself (no startup pull, no focus or timer trigger, no publish on edit).
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
  /** The identity was rewritten to this device's id at the last engine build (a cloned database). */
  identityRepaired: boolean;
  enable(): Promise<void>;
  /**
   * Continues an interrupted backfill ("Reprendre l'initialisation"). With sync not yet turned on it
   * is the enable flow again (every step is safe to repeat); with sync on it only runs the chunks.
   */
  resumeBackfill(): Promise<void>;
  disable(): Promise<void>;
  syncNow(options?: { approveStalePeers?: readonly string[] }): Promise<void>;
  refresh(): Promise<void>;
  /** Re-prepares both folders (after the backup folder or the shared folder was changed). */
  recheckFolders(): Promise<void>;
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
  identityRepaired: false,
  enable: async () => undefined,
  resumeBackfill: async () => undefined,
  disable: async () => undefined,
  syncNow: async () => undefined,
  refresh: async () => undefined,
  recheckFolders: async () => undefined,
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
}

/** The settings an engine is built from; a change rebuilds it. */
const engineKeyOf = (settings: AppSettings): string =>
  JSON.stringify([
    settings.backupDestinationDir,
    settings.syncGtdFolderDir,
    settings.syncDeviceName,
    settings.syncProfile,
  ]);

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

  const built = useRef<{ key: string; engine: BuiltSyncEngine } | null>(null);
  const busy = useRef(false);
  const latest = useRef({ repository, getSettings, updateSettings, deps });
  latest.current = { repository, getSettings, updateSettings, deps };

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

  const ensureEngine = useCallback(async (): Promise<BuiltSyncEngine> => {
    const current = latest.current;
    if (!current.repository) throw new SyncSetupError("unsupported_preview", "No repository");
    const settings = current.getSettings();
    const key = engineKeyOf(settings);
    if (built.current?.key === key) return built.current.engine;
    const engine = await buildSyncEngine({
      repository: current.repository,
      settings,
      getSettings: current.getSettings,
      deps: current.deps,
      onBackup: async (backup) => {
        await latest.current.updateSettings((stored) => ({
          ...stored,
          lastBackupAt: backup.createdAt,
          lastBackupPath: backup.backupPath,
        }));
      },
    });
    built.current = { key, engine };
    setIdentityRepaired(engine.identity.repaired);
    return engine;
  }, []);

  const readStatus = useCallback(async (engine: BuiltSyncEngine) => {
    setStatus(await engine.engine.getStatus());
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

  const syncNow = useCallback(
    (syncOptions: { approveStalePeers?: readonly string[] } = {}) =>
      exclusive("syncing", async () => {
        const engine = await ensureEngine();
        let report: SyncNowReport | null = null;
        let error: SyncUiError | null = null;
        try {
          report = await engine.engine.syncNow(
            syncOptions.approveStalePeers === undefined
              ? {}
              : { approveStalePeers: syncOptions.approveStalePeers },
          );
        } catch (caught) {
          error = toSyncUiError(caught);
        }
        setRun({ finishedAtMs: latest.current.deps.now(), report, error });
        if (report && report.pull.totals.applied + report.pull.totals.tombstonesApplied > 0) {
          // Settings merged from a peer reach the app's own copy of them.
          try {
            await latest.current.updateSettings((stored) => stored);
          } catch (caught) {
            logDebug("warn", "sync.ui", "Rechargement des reglages apres fusion en echec", caught);
          }
        }
        await readStatus(engine);
      }),
    [exclusive, ensureEngine, readStatus],
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
      identityRepaired,
      enable,
      resumeBackfill,
      disable,
      syncNow,
      refresh,
      recheckFolders,
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
      identityRepaired,
      enable,
      resumeBackfill,
      disable,
      syncNow,
      refresh,
      recheckFolders,
    ],
  );
};
