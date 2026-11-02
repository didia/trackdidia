import type { PublishReport, PullReport, SyncIssue } from "./engine-types";

/**
 * The deterministic decisions behind the automatic sync triggers, without timers, DOM or engine:
 * when a pull or a publish is due, how long a failing folder is left alone, how a finished run is
 * classified, and what the status chip says. `lifecycle.ts` runs them, `use-multi-device-sync.ts`
 * wires the events; everything here is a function of its arguments and is tested directly.
 *
 * Numbers (spec "Startup and runtime flow"): startup pull budget 4 s; pull on focus/visible at most
 * once per 60 s and hourly; publish 2 minutes after the first unpublished change, on blur/hide, and
 * on quit with a 3 s cap. Backoff for a failing folder: 30 s, doubling, capped at 15 minutes.
 */

/** How long bootstrap waits for the startup pull before it carries on and lets the pull continue. */
export const SYNC_STARTUP_PULL_BUDGET_MS = 4_000;
/**
 * Of the 8 s bootstrap rule (`BOOTSTRAP_TIMEOUT_MS`), what the startup pull must leave to the rest of
 * bootstrap (normalizations, recurrence generation, draws): its wait never extends past the deadline
 * minus this.
 */
export const SYNC_STARTUP_RESERVE_MS = 2_500;
/** Focus / visibility pulls are at most this often. */
export const SYNC_RESUME_PULL_DEBOUNCE_MS = 60_000;
export const SYNC_HOURLY_PULL_MS = 60 * 60_000;
/** A change waits this long (from the first unpublished one) before it is published. */
export const SYNC_PUBLISH_DEBOUNCE_MS = 120_000;
/** How often "is anything unpublished?" is asked (a single cheap row read). */
export const SYNC_PENDING_POLL_MS = 15_000;
/** The longest a quit waits for its last publish. */
export const SYNC_QUIT_PUBLISH_CAP_MS = 3_000;
export const SYNC_BACKOFF_BASE_MS = 30_000;
export const SYNC_BACKOFF_CAP_MS = 15 * 60_000;

/** What started a run. `manual` is "Synchroniser maintenant": it ignores and resets the backoff. */
export type SyncTrigger = "startup" | "resume" | "hourly" | "debounce" | "blur" | "quit" | "manual";

/** Delay before the next automatic attempt after `consecutiveFailures` failures (>= 1). */
export const backoffDelayMs = (consecutiveFailures: number): number => {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  // 2 ** 20 is far past the cap; clamping the exponent keeps the arithmetic finite.
  return Math.min(SYNC_BACKOFF_CAP_MS, SYNC_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
};

export const isBackoffActive = (backoffUntilMs: number | null, nowMs: number): boolean =>
  backoffUntilMs !== null && nowMs < backoffUntilMs;

export interface PullDecisionInput {
  trigger: SyncTrigger;
  nowMs: number;
  /** When the last pull (any trigger) began, or `null` if none ran in this session. */
  lastPullStartedAtMs: number | null;
  backoffUntilMs: number | null;
}

/** Whether a pull started by `trigger` should run now. */
export const shouldPull = (input: PullDecisionInput): boolean => {
  if (input.trigger === "manual") return true;
  if (isBackoffActive(input.backoffUntilMs, input.nowMs)) return false;
  if (input.trigger === "resume") {
    return (
      input.lastPullStartedAtMs === null ||
      input.nowMs - input.lastPullStartedAtMs >= SYNC_RESUME_PULL_DEBOUNCE_MS
    );
  }
  return true;
};

export interface PublishDecisionInput {
  trigger: SyncTrigger;
  nowMs: number;
  /** Changes captured and not yet published (`SyncStatus.pendingChanges`). */
  pendingChanges: number;
  /** When pending changes were first seen after the last publish, or `null` when none were. */
  firstPendingAtMs: number | null;
  backoffUntilMs: number | null;
}

/**
 * Whether a publish started by `trigger` should run now. Nothing pending never publishes. The
 * debounce trigger waits for the first unpublished change to be 2 minutes old; startup, blur and
 * quit publish at once; manual always runs.
 */
export const shouldPublish = (input: PublishDecisionInput): boolean => {
  if (input.trigger === "manual") return true;
  if (input.pendingChanges <= 0) return false;
  if (isBackoffActive(input.backoffUntilMs, input.nowMs)) return false;
  if (input.trigger === "debounce") {
    return (
      input.firstPendingAtMs !== null &&
      input.nowMs - input.firstPendingAtMs >= SYNC_PUBLISH_DEBOUNCE_MS
    );
  }
  return true;
};

/**
 * Tracks when the pending changes were FIRST seen: `null` while nothing is pending, kept while the
 * same unpublished work waits, set to `nowMs` the first time something is pending.
 */
export const nextFirstPendingAt = (
  previous: number | null,
  pendingChanges: number,
  nowMs: number,
): number | null => (pendingChanges <= 0 ? null : (previous ?? nowMs));

/**
 * How a finished run counts toward the backoff.
 * - `ok`: nothing to retry.
 * - `retry`: the folder or a bundle failed in a way time may fix; back off.
 * - `blocked`: only the user can fix it (no identity, a backup that cannot be made, a folder rejected
 *   by its role marker): automatic triggers stop until settings change or a manual run succeeds.
 * - `backfill`: change tracking is still being initialized; nothing to retry yet, nothing wrong.
 */
export type RunClass = "ok" | "retry" | "blocked" | "backfill";

const BLOCKED_CODES = new Set<string>(["sync_not_ready", "safety_backup_required"]);
const RETRY_WARNING_CODES = new Set<string>(["transport_unreachable", "transport_timeout"]);

export const classifyIssues = (issues: readonly SyncIssue[]): RunClass => {
  if (issues.some((issue) => BLOCKED_CODES.has(issue.code))) return "blocked";
  if (issues.some((issue) => issue.code === "backfill_incomplete")) return "backfill";
  if (issues.some((issue) => issue.severity === "error" || RETRY_WARNING_CODES.has(issue.code))) {
    return "retry";
  }
  return "ok";
};

export const classifyPull = (report: PullReport): RunClass => {
  const base = classifyIssues(report.issues);
  if (base !== "ok") return base;
  return report.transports.some((transport) => !transport.reachable) ? "retry" : "ok";
};

export const classifyPublish = (report: PublishReport): RunClass => classifyIssues(report.issues);

const CLASS_RANK: Record<RunClass, number> = { ok: 0, backfill: 1, retry: 2, blocked: 3 };

/** The more serious of two classes (a Sync now is a pull then a publish). */
export const worstClass = (a: RunClass, b: RunClass): RunClass =>
  CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;

/** Setup errors (a `SyncSetupError` code) that only the user can fix; any other error is retried. */
const BLOCKED_SETUP_CODES = new Set<string>([
  "unsupported_preview",
  "unsupported_profile",
  "no_backup_destination",
  "no_gtd_folder",
  "folders_overlap",
  "folder_rejected",
  "device_name_invalid",
  "no_device_id",
  "no_folders",
]);

export const classifyThrown = (code: string): RunClass =>
  BLOCKED_SETUP_CODES.has(code) ? "blocked" : "retry";

/** True when the pull applied something the open screens should show. */
export const pullChangedData = (report: PullReport): boolean =>
  report.totals.applied + report.totals.tombstonesApplied > 0;

export type SyncChipState = "idle" | "syncing" | "error" | "backfill" | "paused";

export interface SyncChipInput {
  /** A run (automatic or manual) or the startup pull is in progress. */
  running: boolean;
  /** The class of the last finished run, or `null` before any. */
  lastClass: RunClass | null;
  /** Consecutive failed runs. */
  failures: number;
  /** When the next automatic attempt may happen, while backing off. */
  backoffUntilMs: number | null;
  lastOkAtMs: number | null;
  /** The capture backfill is unfinished (the engine pulls and publishes nothing). */
  backfillIncomplete: boolean;
}

export interface SyncChip {
  state: SyncChipState;
  /** Epoch ms of the last successful run, for the "à jour depuis" line. */
  lastOkAtMs: number | null;
  /** Epoch ms of the next retry, while the state is `error`. */
  retryAtMs: number | null;
}

/**
 * The chip. `syncing` wins (something is happening); then `backfill` (the initialization is
 * unfinished, nothing syncs); then `paused` (only the user can resume it); then `error` (a retry is
 * scheduled); otherwise `idle`.
 */
export const deriveSyncChip = (input: SyncChipInput): SyncChip => {
  const base = { lastOkAtMs: input.lastOkAtMs, retryAtMs: null as number | null };
  if (input.running) return { ...base, state: "syncing" };
  if (input.backfillIncomplete || input.lastClass === "backfill") {
    return { ...base, state: "backfill" };
  }
  if (input.lastClass === "blocked") return { ...base, state: "paused" };
  if (input.lastClass === "retry" || input.failures > 0) {
    return { ...base, state: "error", retryAtMs: input.backoffUntilMs };
  }
  return { ...base, state: "idle" };
};
