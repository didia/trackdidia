import { useCallback, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../domain/types";
import { logDebug } from "../lib/debug";
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

export type SyncPhase = "idle" | "enabling" | "disabling" | "syncing" | "checking";

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
  /** The last Sync now. */
  run: SyncRunRecord | null;
  /** The identity was rewritten to this device's id at the last engine build (a cloned database). */
  identityRepaired: boolean;
  enable(): Promise<void>;
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
  run: null,
  identityRepaired: false,
  enable: async () => undefined,
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

  const refresh = useCallback(
    () =>
      exclusive("checking", async () => {
        if (!latest.current.getSettings().multiDeviceSyncEnabled) {
          setStatus(null);
          return;
        }
        await readStatus(await ensureEngine());
      }),
    [exclusive, ensureEngine, readStatus],
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
        });
        setEnableResult(result);
        setIdentityRepaired(result.identity.repaired);
        setRun(null);
        await readStatus(await ensureEngine());
      }),
    [exclusive, ensureEngine, readStatus],
  );

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
      run,
      identityRepaired,
      enable,
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
      run,
      identityRepaired,
      enable,
      disable,
      syncNow,
      refresh,
      recheckFolders,
    ],
  );
};
