import { logDebug } from "../debug";
import type { PublishReport, PullReport } from "./engine-types";
import {
  backoffDelayMs,
  classifyPublish,
  classifyPull,
  classifyThrown,
  isBackoffActive,
  nextFirstPendingAt,
  pullChangedData,
  type RunClass,
  SYNC_HOURLY_PULL_MS,
  SYNC_PENDING_POLL_MS,
  SYNC_QUIT_PUBLISH_CAP_MS,
  shouldPublish,
  shouldPull,
  type SyncTrigger,
} from "./lifecycle-policy";

/**
 * The automatic triggers of multi-device sync, as one object with injected collaborators: no React,
 * no DOM, no engine. `use-multi-device-sync.ts` builds it and wires window events to
 * {@link SyncLifecycle.resume}, {@link SyncLifecycle.hidden} and {@link SyncLifecycle.quit}; tests
 * drive it with fake timers and a fake runner.
 *
 * What it does, all of it decided by `lifecycle-policy.ts`:
 * - `start()` arms two timers (a 15 s poll for unpublished changes that publishes once the first one
 *   is 2 minutes old, and the hourly pull) and nothing else. `stop()` clears them. A lifecycle that
 *   was never started has no timer and does nothing, which is what keeps a device with sync off
 *   byte-for-byte unchanged.
 * - Runs are one at a time (a trigger that finds one in flight is dropped, not queued), skip while a
 *   manual action holds the controller, and go through `runExclusive` so a backup and a sync never
 *   overlap.
 * - A failing run backs the automatic triggers off (30 s doubling to 15 min). A run only the user can
 *   fix (no identity, the required backup cannot be made, a folder rejected by its marker) BLOCKS
 *   them until `reset()` or a manual run succeeds. "Synchroniser maintenant" bypasses and resets both.
 */

export interface LifecycleRunner {
  pull(): Promise<PullReport>;
  publish(): Promise<PublishReport>;
}

export interface LifecycleSnapshot {
  running: "pull" | "publish" | null;
  consecutiveFailures: number;
  backoffUntilMs: number | null;
  /** True after a run only the user can fix; automatic triggers do nothing until `reset()`. */
  blocked: boolean;
  lastClass: RunClass | null;
  lastOkAtMs: number | null;
  lastError: { code: string; message: string } | null;
  lastPullStartedAtMs: number | null;
  backfillIncomplete: boolean;
}

export interface SyncLifecycleDeps {
  now(): number;
  /** The engine to run on; may throw (a setup error with a `code`). */
  runner(): Promise<LifecycleRunner>;
  /** Changes captured and not yet published; 0 when sync is not set up. A cheap read. */
  pendingChanges(): Promise<number>;
  /** Runs `work` alone among backups and syncs. */
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  /** True while a manual action (Sync now, enable, ...) holds the controller. */
  manualBusy(): boolean;
  /** A pull applied data: open screens must reload. */
  onDataChanged(): void;
  onChange(snapshot: LifecycleSnapshot): void;
}

export interface SyncLifecycle {
  start(options?: { lastPullStartedAtMs?: number | null; publishNow?: boolean }): void;
  stop(): void;
  readonly started: boolean;
  /** Window focus or the page becoming visible. */
  resume(): Promise<void>;
  /** Window blur or the page becoming hidden. */
  hidden(): Promise<void>;
  /** The window is closing: publish what is pending, waiting at most `capMs`. */
  quit(capMs?: number): Promise<void>;
  /** One pass of the unpublished-changes poll (the timer calls it; exposed for tests). */
  tick(): Promise<void>;
  /** A manual run begins: the backoff and the block are lifted. */
  manualStarted(): void;
  /** A manual run ended with this class (and message when it failed). */
  manualFinished(runClass: RunClass, error?: { code: string; message: string } | null): void;
  /** Takes over a pull that began before this lifecycle (the startup pull continuing in the background). */
  adoptPull(pull: {
    startedAtMs: number;
    result: Promise<PullReport>;
    /** False when the startup pull already settled and was applied before the UI existed. */
    announceData: boolean;
  }): void;
  /** Lifts the block and the backoff (settings that decide whether sync can run changed). */
  reset(): void;
  /** Resolves when no automatic run is in flight. */
  whenIdle(): Promise<void>;
  snapshot(): LifecycleSnapshot;
}

const errorInfo = (error: unknown): { code: string; message: string } => ({
  code:
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unexpected",
  message: error instanceof Error ? error.message : String(error),
});

const firstIssueMessage = (
  report: PullReport | PublishReport,
): { code: string; message: string } | null => {
  const issue =
    report.issues.find((item) => item.severity === "error") ??
    report.issues.find((item) => item.severity === "warning");
  return issue ? { code: issue.code, message: issue.message } : null;
};

export const createSyncLifecycle = (deps: SyncLifecycleDeps): SyncLifecycle => {
  let started = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let hourlyTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  let firstPendingAtMs: number | null = null;
  const state: LifecycleSnapshot = {
    running: null,
    consecutiveFailures: 0,
    backoffUntilMs: null,
    blocked: false,
    lastClass: null,
    lastOkAtMs: null,
    lastError: null,
    lastPullStartedAtMs: null,
    backfillIncomplete: false,
  };

  const snapshot = (): LifecycleSnapshot => ({ ...state });
  const emit = () => {
    try {
      deps.onChange(snapshot());
    } catch (error) {
      logDebug("warn", "sync.lifecycle", "Observateur d'etat en echec", error);
    }
  };

  const record = (runClass: RunClass, error: { code: string; message: string } | null) => {
    state.lastClass = runClass;
    state.backfillIncomplete = runClass === "backfill";
    if (runClass === "ok") {
      state.consecutiveFailures = 0;
      state.backoffUntilMs = null;
      state.blocked = false;
      state.lastOkAtMs = deps.now();
      state.lastError = null;
    } else if (runClass === "retry") {
      state.consecutiveFailures += 1;
      state.backoffUntilMs = deps.now() + backoffDelayMs(state.consecutiveFailures);
      state.lastError = error;
    } else if (runClass === "blocked") {
      state.blocked = true;
      state.lastError = error;
    }
  };

  const logRun = (
    kind: "pull" | "publish",
    trigger: SyncTrigger,
    startedAt: number,
    extra: object,
  ) => {
    logDebug("info", "sync.lifecycle", "Synchronisation automatique terminee", {
      kind,
      trigger,
      durationMs: deps.now() - startedAt,
      ...extra,
    });
  };

  /** Runs one pull or publish unless something else is going on; resolves when it finished. */
  const execute = (kind: "pull" | "publish", trigger: SyncTrigger): Promise<void> => {
    if (!started || state.blocked || inFlight !== null || deps.manualBusy()) {
      return Promise.resolve();
    }
    const startedAt = deps.now();
    state.running = kind;
    if (kind === "pull") state.lastPullStartedAtMs = startedAt;
    emit();
    const work = (async () => {
      try {
        // The nearest timing of one statement round trip that exists without the desktop app:
        // getSyncStatus issues two SELECTs. Logged so a real IPC latency can be read off a session.
        const probeStart = deps.now();
        await deps.pendingChanges();
        const statusReadMs = deps.now() - probeStart;
        const result = await deps.runExclusive(async () => {
          const runner = await deps.runner();
          return kind === "pull" ? runner.pull() : runner.publish();
        });
        if (kind === "pull") {
          const report = result as PullReport;
          record(classifyPull(report), firstIssueMessage(report));
          if (pullChangedData(report)) deps.onDataChanged();
          logRun(kind, trigger, startedAt, {
            statusReadMs,
            bundlesApplied: report.totals.bundlesApplied,
            chunksApplied: report.totals.chunksApplied,
            maxChunkMs: report.totals.maxChunkMs,
            complete: report.complete,
          });
        } else {
          const report = result as PublishReport;
          record(classifyPublish(report), firstIssueMessage(report));
          firstPendingAtMs = null;
          logRun(kind, trigger, startedAt, {
            statusReadMs,
            counterAdvanced: report.counterAdvanced,
          });
        }
      } catch (error) {
        const info = errorInfo(error);
        // Another run of a different kind holds the engine: not a failure, the next trigger retries.
        if (info.code !== "already_running") {
          record(classifyThrown(info.code), info);
          logDebug("warn", "sync.lifecycle", "Synchronisation automatique en echec", {
            kind,
            trigger,
            code: info.code,
          });
        }
      } finally {
        state.running = null;
        emit();
      }
    })();
    const tracked = work.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  const pullIfDue = (trigger: SyncTrigger): Promise<void> =>
    shouldPull({
      trigger,
      nowMs: deps.now(),
      lastPullStartedAtMs: state.lastPullStartedAtMs,
      backoffUntilMs: state.backoffUntilMs,
    })
      ? execute("pull", trigger)
      : Promise.resolve();

  const publishIfDue = async (trigger: SyncTrigger): Promise<void> => {
    if (!started || state.blocked || inFlight !== null) return;
    const pending = await deps.pendingChanges().catch(() => 0);
    const nowMs = deps.now();
    firstPendingAtMs = nextFirstPendingAt(firstPendingAtMs, pending, nowMs);
    if (
      shouldPublish({
        trigger,
        nowMs,
        pendingChanges: pending,
        firstPendingAtMs,
        backoffUntilMs: state.backoffUntilMs,
      })
    ) {
      await execute("publish", trigger);
    }
  };

  const guard = (work: () => Promise<void>): Promise<void> =>
    work().catch((error) => {
      logDebug("warn", "sync.lifecycle", "Declencheur de synchronisation en echec", error);
    });

  return {
    get started() {
      return started;
    },
    start(options = {}) {
      if (started) return;
      started = true;
      if (options.lastPullStartedAtMs !== undefined) {
        state.lastPullStartedAtMs = options.lastPullStartedAtMs;
      }
      tickTimer = setInterval(
        () => void guard(() => publishIfDue("debounce")),
        SYNC_PENDING_POLL_MS,
      );
      hourlyTimer = setInterval(() => void guard(() => pullIfDue("hourly")), SYNC_HOURLY_PULL_MS);
      if (options.publishNow === true) {
        // After a pull adopted from bootstrap (it is in flight, and its republish bump is pending
        // work too), not instead of it: a publish asked while it runs would be dropped.
        void guard(async () => {
          await inFlight;
          await publishIfDue("startup");
        });
      }
      emit();
    },
    stop() {
      if (!started) return;
      started = false;
      if (tickTimer !== undefined) clearInterval(tickTimer);
      if (hourlyTimer !== undefined) clearInterval(hourlyTimer);
      tickTimer = undefined;
      hourlyTimer = undefined;
      firstPendingAtMs = null;
    },
    resume: () => guard(() => (started ? pullIfDue("resume") : Promise.resolve())),
    hidden: () => guard(() => publishIfDue("blur")),
    tick: () => guard(() => publishIfDue("debounce")),
    async quit(capMs = SYNC_QUIT_PUBLISH_CAP_MS) {
      if (!started || state.blocked || isBackoffActive(state.backoffUntilMs, deps.now())) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      });
      try {
        // A run already in flight (a pull, or a publish) is waited for first, then what is still
        // pending is published, all within the one cap.
        const work = guard(async () => {
          await inFlight;
          await publishIfDue("quit");
        });
        await Promise.race([work, cap]);
      } finally {
        clearTimeout(timer);
      }
    },
    manualStarted() {
      state.consecutiveFailures = 0;
      state.backoffUntilMs = null;
      state.blocked = false;
      emit();
    },
    manualFinished(runClass, error = null) {
      record(runClass, error);
      firstPendingAtMs = null;
      emit();
    },
    adoptPull({ startedAtMs, result, announceData }) {
      state.lastPullStartedAtMs = startedAtMs;
      state.running = "pull";
      emit();
      const tracked = result
        .then(
          (report) => {
            record(classifyPull(report), firstIssueMessage(report));
            if (started && announceData && pullChangedData(report)) deps.onDataChanged();
          },
          (error) => {
            const info = errorInfo(error);
            if (info.code !== "already_running") record(classifyThrown(info.code), info);
          },
        )
        .finally(() => {
          state.running = null;
          if (inFlight === tracked) inFlight = null;
          emit();
        });
      inFlight = tracked;
    },
    reset() {
      state.consecutiveFailures = 0;
      state.backoffUntilMs = null;
      state.blocked = false;
      state.lastClass = null;
      state.lastError = null;
      emit();
    },
    whenIdle: () => inFlight ?? Promise.resolve(),
    snapshot,
  };
};
