import type { AppSettings } from "../../domain/types";
import { logDebug } from "../debug";
import type { AppRepository, BackupResult } from "../storage/repository";
import type { PullReport } from "./engine-types";
import { isSyncAutomationEnabled } from "./gate";
import { SYNC_STARTUP_PULL_BUDGET_MS, SYNC_STARTUP_RESERVE_MS } from "./lifecycle-policy";
import {
  type BuiltSyncEngine,
  buildSyncEngine,
  defaultSyncServiceDeps,
  type SyncServiceDeps,
  syncEngineKeyOf,
} from "./sync-service";

/**
 * Step 3 of the startup flow (spec "Startup and runtime flow"): pull from the other laptop BEFORE
 * recurrence generation, Scheduled promotion and the relationship draws, so those see the other
 * laptop's work (a task completed there is not regenerated here, today's draw made there is not
 * repeated). It lives inside the 8-second bootstrap rule and is built so it cannot be what breaks it:
 *
 * - **The wait is bounded by the deadline, not by a fixed 4 s.** It is `min(4 s, bootstrap deadline -
 *   now - 2.5 s)`, measured from the moment this function is called, so time bootstrap already spent
 *   (database init, migrations) shortens it, and building the engine (a device-id read and an identity
 *   write) counts against it. If the engine is not built when the wait lapses, there is no startup sync
 *   (`null`); the hook builds its own later.
 * - **After the wait lapses the pull cannot hold the database writer while bootstrap finishes.** The
 *   engine is given a `beforeWrite` gate: the safety backup (a whole `VACUUM INTO`) never starts until
 *   bootstrap has settled, and an apply piece starts only while the wait is still open. A pull that
 *   needs a backup (a first merge, a schema difference such as the one migration 47 causes) therefore
 *   merges nothing during bootstrap and does it right after, in the background; the generators that ran
 *   meanwhile converge with the merge (spec: they are deterministic). What can still overrun is the
 *   one writer slot already running when the wait lapses: an apply piece (about 0.1 to 0.3 s in
 *   process, projected at about 1 s with the real IPC cost, not measured) - hence the 2.5 s reserve.
 * - The pull has no engine `budgetMs`: past the gate it continues unbudgeted in the background (the
 *   answer to the slice-14 obligation about the in-memory chunk index: no automatic path cuts a merge,
 *   so only quitting the app can interrupt one, and the next start repeats the bundle from chunk 0).
 * - Nothing here can throw into bootstrap: an unreachable folder, a setup error, a failed backup are
 *   logged and bootstrap goes on.
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
  /** Upper bound of the wait; the default is {@link SYNC_STARTUP_PULL_BUDGET_MS}. */
  waitBudgetMs?: number;
  /** When the 8-second bootstrap rule fires, in `deps.now()` milliseconds. Absent: no deadline. */
  bootstrapDeadlineAtMs?: number;
  /** Resolves when bootstrap has finished (or failed). Absent: nothing is held back. */
  bootstrapSettled?: Promise<void>;
}

/**
 * Builds the engine and starts the startup pull. Resolves after the pull ended or the wait lapsed,
 * whichever is first. `null`: the gate is closed, there was no time left, or the engine could not be
 * built (logged; the manual page then shows the same error).
 */
export const startStartupSyncPull = async (
  input: StartupSyncInput,
): Promise<StartupSync | null> => {
  const { repository, settings } = input;
  if (!isSyncAutomationEnabled(input.debugEnabled, settings)) return null;
  const deps = input.deps ?? defaultSyncServiceDeps;
  const beganAtMs = deps.now();
  const budgetMs = input.waitBudgetMs ?? SYNC_STARTUP_PULL_BUDGET_MS;
  const waitMs = Math.max(
    0,
    Math.min(
      budgetMs,
      input.bootstrapDeadlineAtMs === undefined
        ? budgetMs
        : input.bootstrapDeadlineAtMs - beganAtMs - SYNC_STARTUP_RESERVE_MS,
    ),
  );
  if (waitMs === 0) {
    // Nothing is left to wait with (the reserve for the rest of bootstrap is already used).
    logDebug("info", "sync.startup", "Pas de pull de demarrage: plus de temps");
    return null;
  }
  const waitEndsAtMs = beganAtMs + waitMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapsed = new Promise<"lapsed">((resolve) => {
    timer = setTimeout(() => resolve("lapsed"), waitMs);
  });
  const bootstrapSettled = input.bootstrapSettled ?? Promise.resolve();
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

  try {
    const building = buildSyncEngine({
      repository,
      settings,
      getSettings: () => binding.getSettings(),
      deps,
      onBackup: (backup) => binding.onBackup(backup),
      beforeWrite: (kind) =>
        // A backup always waits for bootstrap; an apply piece only once the wait is over.
        kind === "apply" && deps.now() < waitEndsAtMs ? Promise.resolve() : bootstrapSettled,
    });
    // A build that outlives the wait is dropped (its outcome ignored); bootstrap does not wait for it.
    building.catch(() => undefined);
    let built: BuiltSyncEngine;
    try {
      const first = await Promise.race([building, lapsed]);
      if (first === "lapsed") {
        logDebug("info", "sync.startup", "Pas de pull de demarrage: moteur non pret a temps");
        return null;
      }
      built = first;
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
    const first = await Promise.race([settled, lapsed]);
    if (first === "lapsed") {
      logDebug("info", "sync.startup", "Pull de demarrage poursuivi en arriere-plan");
    } else {
      startup.finished = first;
    }
    return startup;
  } finally {
    clearTimeout(timer);
  }
};
