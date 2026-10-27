import type { AppRepository } from "../storage/repository";
import type { SafetyBackupReason, SyncIssue } from "./engine-types";
import type { DeviceProfile } from "./profile";
import type { SyncTransport } from "./transport";
import { SyncTransportError } from "./transport";

/** The repository methods the engine uses; a test can wrap or spy on exactly these. */
export type SyncEngineRepository = Pick<
  AppRepository,
  | "getSyncStatus"
  | "listSyncChanges"
  | "applySyncBundle"
  | "recordSyncPeerApplied"
  | "markSyncPublished"
>;

export interface SafetyBackupResult {
  /** Where the backup went, when the hook knows. Recorded in the pull report. */
  path?: string;
}

/**
 * Makes the pre-merge backup (`createBackup("auto")` into this device's own destination). Resolve
 * when the backup exists; throw when it could not be made. The engine merges nothing after a throw.
 */
export type EnsureSafetyBackup = (
  reasons: readonly SafetyBackupReason[],
) => Promise<SafetyBackupResult | undefined>;

export interface SyncEngineOptions {
  repo: SyncEngineRepository;
  /**
   * One per folder role this device can reach. Each declares the domains it carries; two may not
   * declare the same one. A work device is given the shared GTD folder's transport only.
   */
  transports: readonly SyncTransport[];
  profile: DeviceProfile;
  /** Epoch milliseconds. Drives every age check, the skew check and the pull budget. */
  now?: () => number;
  /** Highest migration id applied here. Defaults to the latest migration of this build. */
  localSchemaVersion?: number;
  appVersion?: string;
  /** Whether calendar sync is on here; written into the manifest so peers can warn. */
  calendarSyncEnabled?: () => boolean | Promise<boolean>;
  /** The safety backup hook (see {@link EnsureSafetyBackup}). Required to merge into user data. */
  beforeFirstMerge?: EnsureSafetyBackup;
  /**
   * Gives up on a single transport call after this long and reports a timeout, so a transport that
   * never answers cannot hold the run slot forever. Transports have timeouts of their own; this is
   * the engine's backstop. Default {@link DEFAULT_TRANSPORT_TIMEOUT_MS}; `Infinity` disables it.
   */
  transportTimeoutMs?: number;
}

/** The engine's own limit for one transport call (a folder that is online-only can be slow). */
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;

export interface EngineContext {
  repo: SyncEngineRepository;
  transports: readonly SyncTransport[];
  profile: DeviceProfile;
  now: () => number;
  localSchemaVersion: number;
  appVersion: string;
  calendarSyncEnabled: () => boolean | Promise<boolean>;
  beforeFirstMerge: EnsureSafetyBackup | undefined;
  transportTimeoutMs: number;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Awaits `operation`, giving up after `timeoutMs` with a `timeout` {@link SyncTransportError}. */
export const withTimeout = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> => {
  const pending = operation();
  if (!Number.isFinite(timeoutMs)) return pending;
  // The loser of the race must not surface later as an unhandled rejection.
  pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new SyncTransportError("timeout", `${what} did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** A transport failure as an issue: unreachable and timeout are warnings, anything else an error. */
export const transportIssue = (
  transport: SyncTransport,
  error: unknown,
  what: string,
  extra: Partial<SyncIssue> = {},
): SyncIssue => {
  if (error instanceof SyncTransportError) {
    return {
      ...extra,
      severity: "warning",
      code: error.code === "timeout" ? "transport_timeout" : "transport_unreachable",
      transport: transport.id,
      message:
        error.code === "timeout"
          ? `${what}: the folder did not answer in time (${transport.id}); will retry`
          : `${what}: the folder cannot be reached (${transport.id}); will retry`,
      detail: error.message,
    };
  }
  return {
    ...extra,
    severity: "error",
    code: "transport_failed",
    transport: transport.id,
    message: `${what}: ${messageOf(error)} (${transport.id})`,
    detail: messageOf(error),
  };
};

/** True for the two errors that mean "this folder is not there right now". */
export const isTransportDown = (issue: SyncIssue): boolean =>
  issue.code === "transport_unreachable" || issue.code === "transport_timeout";
