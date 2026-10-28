import type { SyncBackfillProgress } from "./backfill-state";
import type { SyncApplyResult } from "./change-set";
import type { DeviceProfile } from "./profile";
import type { SyncDomain } from "./registry";

/**
 * Report and option types of the sync engine (`sync-engine.ts`). Everything an engine run tells its
 * caller is plain data here: the future `/sync` page and the status chip render it, tests assert on
 * it. Matching is always on `code`, never on `message` (messages are for people).
 */

export type SyncEngineErrorCode =
  /** A second, different run was requested while one is in flight. */
  | "already_running"
  /** Two transports declare the same domain, or one declares a domain that does not exist. */
  | "invalid_transports"
  /** A bundle was about to be handed to a transport that does not carry its domain. */
  | "domain_routing_violation";

/** Thrown by the engine itself (never for a problem with a peer or a bundle: those are reports). */
export class SyncEngineError extends Error {
  readonly code: SyncEngineErrorCode;

  constructor(code: SyncEngineErrorCode, message: string) {
    super(message);
    this.name = "SyncEngineError";
    this.code = code;
  }
}

export type SyncIssueSeverity = "info" | "warning" | "error";

export type SyncIssueCode =
  /** Sync cannot run here: browser preview, no identity yet, or change capture not enabled. */
  | "sync_not_ready"
  /**
   * Change capture is installed but its first pass over the database has not finished (an interrupted
   * enable): nothing is published or applied until it has. Continuing it is the user's or the
   * lifecycle's job (`runSyncCaptureBackfill`).
   */
  | "backfill_incomplete"
  | "transport_unreachable"
  | "transport_timeout"
  /** A transport failed in a way that is neither of the above. */
  | "transport_failed"
  | "transport_ignored"
  /** The manifest is unreadable or malformed. */
  | "manifest_invalid"
  | "format_version_unsupported"
  /** The peer migrated further than this build: "update TrackDidia to sync with <device>". */
  | "update_required"
  /** Offline too long to merge safely; the user reviews and approves (spec: "Deletes"). */
  | "stale_peer"
  /** The peer's clock runs more than five minutes ahead of ours. The merge still happens. */
  | "clock_skew"
  /** A domain this device, this transport or the peer's own profile may not carry. Never applied. */
  | "domain_not_allowed"
  /** The bundle's content belongs to another domain than the manifest promised. Never applied. */
  | "wrong_domain_bundle"
  /** The bundle was written by another device than the manifest's. */
  | "bundle_device_mismatch"
  /** The peer's upload has not finished propagating: try again on the next trigger. */
  | "bundle_not_ready"
  /** The bundle does not validate; rejected as a whole. */
  | "bundle_invalid"
  /** The repository refused the bundle (`SyncApplyError` / `SyncClockError`); nothing was kept. */
  | "bundle_rejected"
  | "bundle_failed"
  /** Applying worked but remembering it failed: the bundle will be re-applied (a no-op). */
  | "bookkeeping_failed"
  /** A safety backup was required before merging and could not be made; nothing was applied. */
  | "safety_backup_required"
  | "publish_failed"
  | "publish_skipped"
  /** Local changes stay pending because a domain this device may publish has no transport right now. */
  | "pending_unpublished_domain";

export interface SyncIssue {
  severity: SyncIssueSeverity;
  code: SyncIssueCode;
  message: string;
  /** Transport id ("folder:gtd"). */
  transport?: string;
  peerId?: string;
  peerName?: string;
  domain?: SyncDomain | string;
  /** The inner error code (`SyncApplyError.code`, `SyncChangeSetError.code`, a stale reason). */
  detail?: string;
}

export type DomainPullOutcome =
  /** The bundle was merged into the local database. */
  | "applied"
  /** The manifest's hash is the one already applied: nothing was read. */
  | "unchanged"
  | "not_ready"
  /** The bundle was read and refused (invalid, wrong domain, repository error). */
  | "rejected"
  /** The manifest entry itself was refused (domain not allowed, malformed entry). */
  | "refused"
  /** Not attempted: the time budget ran out. It is listed in `remaining`. */
  | "deferred"
  /** Not attempted: the transport became unreachable earlier in this run. */
  | "unreachable"
  /** Not attempted: a required safety backup could not be made. */
  | "halted";

export interface DomainPullResult {
  domain: SyncDomain | string;
  outcome: DomainPullOutcome;
  generation?: number;
  sha256?: string;
  /**
   * Present when `outcome` is `applied`, and for a `deferred` bundle whose pieces were partly applied
   * (then it sums the pieces that were).
   */
  apply?: SyncApplyResult;
  /** Present when the bundle was large enough to be applied as several pieces. */
  chunks?: {
    /** Pieces the bundle was split into. */
    total: number;
    /** Pieces applied by this pull. */
    applied: number;
    /** Slowest piece of this pull, in milliseconds. */
    maxMs: number;
  };
}

/** Why a peer's manifest as a whole was or was not acted on. */
export type PeerPullStatus =
  /** The gates passed: its domains were looked at. */
  "ok" | "invalid_manifest" | "format_unsupported" | "update_required" | "stale";

export interface PeerPullReport {
  peerId: string;
  peerName: string;
  transport: string;
  status: PeerPullStatus;
  /** Skew of the peer's clock over ours in milliseconds, when it is above the warning threshold. */
  clockSkewMs?: number;
  domains: DomainPullResult[];
}

export interface TransportReport {
  id: string;
  domains: SyncDomain[];
  reachable: boolean;
}

/** Work a budget-limited pull left undone. `peerId` is null when the peers were not even listed. */
export interface PendingPull {
  transport: string;
  domain: SyncDomain;
  peerId: string | null;
  peerName: string | null;
}

export type SafetyBackupReason = "first_merge" | "schema_skew";

export interface SafetyBackupReport {
  /** Why a backup was needed. Empty when none was. */
  reasons: SafetyBackupReason[];
  /**
   * `not_needed`: nothing required one (or nothing was applied). `taken`: the hook ran before the
   * first apply. `skipped_empty_joiner`: a verified empty joiner has nothing to lose, recorded.
   * `failed`: it was required and could not be made, so nothing was applied.
   */
  status: "not_needed" | "taken" | "skipped_empty_joiner" | "failed";
  /** What the hook returned, when it named the backup. */
  path?: string;
}

export interface PullTotals {
  bundlesApplied: number;
  applied: number;
  skipped: number;
  tombstonesApplied: number;
  conflictsLogged: number;
  /** Writer slots used to apply bundles (one per bundle, more for a large one). */
  chunksApplied: number;
  /** Duration of the slowest slot, in milliseconds. */
  maxChunkMs: number;
}

export interface PullReport {
  startedAtMs: number;
  finishedAtMs: number;
  /** False when the budget ran out or a required safety backup could not be made. */
  complete: boolean;
  /** What a follow-up `pull()` still has to do. Empty when `complete`. */
  remaining: PendingPull[];
  transports: TransportReport[];
  peers: PeerPullReport[];
  issues: SyncIssue[];
  safetyBackup: SafetyBackupReport;
  totals: PullTotals;
}

export interface PullOptions {
  /**
   * Stop starting new peer/domain work once this many milliseconds (on the engine's clock) have
   * passed since the pull began. An apply that has begun always finishes: it is one transaction. A
   * large bundle is applied as several transactions and the budget is checked BETWEEN them (after at
   * least one per pull), so the pull can end half way through a bundle; the pieces done are kept, the
   * bundle is reported as deferred, and the next pull continues.
   */
  budgetMs?: number;
  /**
   * Peers (device ids) the user reviewed and chose to merge although they are stale (spec:
   * "this laptop has been offline too long to merge safely"). Without this, stale peers are refused.
   */
  approveStalePeers?: readonly string[];
  /**
   * The join flow verified that this database holds nothing but migration and seed rows: the safety
   * backup is skipped (and the skip recorded). The engine does not check this itself.
   */
  verifiedEmptyJoiner?: boolean;
}

export type PublishDomainOutcome =
  | "published"
  /** Nothing changed since the last publish and a bundle exists. */
  | "clean"
  /** No transport carries the domain on this device. */
  | "no_transport"
  | "failed";

export interface PublishDomainResult {
  domain: SyncDomain;
  outcome: PublishDomainOutcome;
  transport?: string;
  generation?: number;
}

export interface PublishReport {
  startedAtMs: number;
  finishedAtMs: number;
  /** Local changes pending when the run began. */
  pendingBefore: number;
  domains: PublishDomainResult[];
  /** Whether `last_publish_counter` moved. */
  counterAdvanced: boolean;
  issues: SyncIssue[];
}

export interface PublishOptions {
  /** Publish every publishable domain even if nothing changed. */
  force?: boolean;
}

export interface SyncNowReport {
  pull: PullReport;
  publish: PublishReport;
}

/** How the `/sync` page should describe one peer. */
export type PeerState =
  | "synced"
  | "update_required"
  | "stale"
  | "format_unsupported"
  | "invalid_manifest"
  | "not_ready"
  /** Work for this peer was left for the next run (time budget): nothing wrong, nothing merged yet. */
  | "pending"
  | "error"
  | "unreachable"
  /** Known from an earlier session; not seen in the last pull. */
  | "unknown";

export interface PeerStatus {
  peerId: string;
  peerName: string;
  state: PeerState;
  message: string | null;
  lastSyncedAt: string | null;
  schemaVersion: number | null;
  appVersion: string | null;
  profile: DeviceProfile | null;
  calendarSyncEnabled: boolean | null;
}

export type EngineActivity = "pull" | "publish" | "syncNow";

export interface EngineStatus {
  /** Whether sync can run here at all (identity created, capture enabled and its backfill done). */
  ready: boolean;
  /**
   * The capture backfill: `complete` false means a pass is still running (an interrupted enable) and
   * the engine publishes and applies nothing. `progress` is the running or last pass.
   */
  backfill: { complete: boolean; progress: SyncBackfillProgress | null };
  running: EngineActivity | null;
  profile: DeviceProfile;
  pendingChanges: number;
  peers: PeerStatus[];
  lastPull: PullReport | null;
  lastPublish: PublishReport | null;
  /** Warnings and errors of the last pull and the last publish. */
  issues: SyncIssue[];
}
