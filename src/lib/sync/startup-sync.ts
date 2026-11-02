import type { AppSettings } from "../../domain/types";
import { logDebug } from "../debug";
import type { AppRepository, BackupResult } from "../storage/repository";
import type { PullReport } from "./engine-types";
import { isSyncAutomationEnabled } from "./gate";
import { SYNC_STARTUP_PULL_BUDGET_MS } from "./lifecycle-policy";
import {
  type BuiltSyncEngine,
  buildSyncEngine,
  defaultSyncServiceDeps,
  type SyncServiceDeps,
  syncEngineKeyOf,
} from "./sync-service";

/**
 * Step 3 of the startup flow (spec "Startup and runtime flow"): pull from the other laptops BEFORE
 * recurrence generation, Scheduled promotion and the relationship draws, so those see the other
 * laptop's work (a task completed there is not regenerated here, today's draw made there is not
 * repeated). It lives inside the 8-second bootstrap rule, never weakens it:
 *
 * - The pull has a WAIT budget of 4 s, not a work budget. When the pull is not done by then,
 *   bootstrap carries on at once and the same pull keeps running in the background, unbudgeted. This
 *   is the answer to the slice-14 obligation about restarting a huge first merge at chunk 0: the
 *   engine's resume index is in memory, but a first merge is never cut by a budget, so a restart is
 *   the only thing that can interrupt one (and the chunks already applied then merge as no-ops).
 * - Nothing here can throw into bootstrap or trigger the in-memory fallback: an unreachable folder, a
 *   setup error, a failed backup are logged and bootstrap goes on.
 * - With the gate closed (`isSyncAutomationEnabled`) this returns `null` before touching anything.
 *
 * The engine built here is handed to `useMultiDeviceSync`, which adopts it, so there is ONE engine
 * (one in-flight guard, one publish memory) for the whole session.
 */

/** Late-bound collaborators of the engine built at startup; the hook rebinds them when it adopts it. */
export interface StartupSyncBinding {
  getSettings: () => AppSettings;
  onBackup: (backup: BackupResult) => void | Promise<void>;
}

export type StartupPullOutcome = { ok: true; report: PullReport } | { ok: false; error: unknown };

export interface StartupSync {
  built: BuiltSyncEngine;
  /** `syncEngineKeyOf` of the settings the engine was built from. */
  key: string;
  binding: StartupSyncBinding;
  startedAtMs: number;
  /** Settles (never rejects) when the pull ends, in budget or not. */
  settled: Promise<StartupPullOutcome>;
  /** The outcome when the pull ended within the wait budget; `null` when it is still running. */
  finished: StartupPullOutcome | null;
}

export interface StartupSyncInput {
  repository: AppRepository;
  settings: AppSettings;
  debugEnabled: boolean;
  /** Runs `work` alone among backups and syncs (the app's exclusive lane). */
  runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  deps?: SyncServiceDeps;
  waitBudgetMs?: number;
}

/**
 * Builds the engine and starts the startup pull. Resolves after the pull ended or the wait budget
 * lapsed, whichever is first. `null`: the gate is closed, or the engine could not be built (logged;
 * the manual page then shows the same error).
 */
export const startStartupSyncPull = async (
  input: StartupSyncInput,
): Promise<StartupSync | null> => {
  const { repository, settings } = input;
  if (!isSyncAutomationEnabled(input.debugEnabled, settings)) return null;
  const deps = input.deps ?? defaultSyncServiceDeps;
  const binding: StartupSyncBinding = {
    getSettings: () => settings,
    // Until the hook adopts the engine the backup is recorded in the database directly.
    onBackup: async (backup) => {
      await repository.updateSettings((stored) => ({
        ...stored,
        lastBackupAt: backup.createdAt,
        lastBackupPath: backup.backupPath,
      }));
    },
  };
  let built: BuiltSyncEngine;
  try {
    built = await buildSyncEngine({
      repository,
      settings,
      getSettings: () => binding.getSettings(),
      deps,
      onBackup: (backup) => binding.onBackup(backup),
    });
  } catch (error) {
    logDebug("warn", "sync.startup", "Synchronisation au demarrage impossible", {
      code: (error as { code?: unknown } | null)?.code,
    });
    return null;
  }

  const startedAtMs = deps.now();
  const settled: Promise<StartupPullOutcome> = input
    .runExclusive(() => built.engine.pull())
    .then(
      (report): StartupPullOutcome => ({ ok: true, report }),
      (error): StartupPullOutcome => ({ ok: false, error }),
    );
  const startup: StartupSync = {
    built,
    key: syncEngineKeyOf(settings),
    binding,
    startedAtMs,
    settled,
    finished: null,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapsed = new Promise<"lapsed">((resolve) => {
    timer = setTimeout(() => resolve("lapsed"), input.waitBudgetMs ?? SYNC_STARTUP_PULL_BUDGET_MS);
  });
  try {
    const first = await Promise.race([settled, lapsed]);
    if (first === "lapsed") {
      logDebug("info", "sync.startup", "Pull de demarrage poursuivi en arriere-plan");
    } else {
      startup.finished = first;
    }
  } finally {
    clearTimeout(timer);
  }
  return startup;
};
