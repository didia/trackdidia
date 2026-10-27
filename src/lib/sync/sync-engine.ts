import { LATEST_MIGRATION_ID } from "../storage/migrations";
import { runPublish, newPublishMemory } from "./engine-publish";
import { runPull } from "./engine-pull";
import {
  DEFAULT_TRANSPORT_TIMEOUT_MS,
  type EngineContext,
  type SyncEngineOptions,
} from "./engine-support";
import {
  type EngineActivity,
  type EngineStatus,
  type PeerState,
  type PeerStatus,
  type PublishOptions,
  type PublishReport,
  type PullOptions,
  type PullReport,
  SyncEngineError,
  type SyncIssue,
  type SyncNowReport,
} from "./engine-types";
import { isDeviceProfile } from "./profile";
import { SYNC_DOMAINS } from "./registry";

export type {
  EnsureSafetyBackup,
  SafetyBackupResult,
  SyncEngineOptions,
  SyncEngineRepository,
} from "./engine-support";
export * from "./engine-types";

/**
 * The sync engine: pull -> merge -> apply -> publish, over a repository and transports. Everything
 * it needs from the outside is injected (repository, transports, clock, profile, the safety-backup
 * hook), so it runs unchanged against the in-memory simulation in tests and against the folder
 * transport in the app. It starts nothing by itself: the lifecycle slice decides when to call it.
 *
 * - {@link SyncEngine.pull}: see `engine-pull.ts` (gates, per-peer isolation, budget, safety backup).
 * - {@link SyncEngine.publish}: see `engine-publish.ts` (profile filter, routing, counter).
 * - {@link SyncEngine.syncNow}: pull, then publish. Publishing does not wait for a complete pull and
 *   is not stopped by a failed one: our own state keeps flowing out ("Schema and version skew").
 *
 * One run at a time. Asking for the same kind of run while it is in flight returns the in-flight
 * promise (a focus event during a focus pull is the same pull); asking for a different kind rejects
 * with a `SyncEngineError("already_running")`, because quietly queueing a merge behind a publish (or
 * the reverse) would make the caller's "done" mean something else.
 */
export class SyncEngine {
  private readonly ctx: EngineContext;
  private readonly memory = newPublishMemory();
  private inFlight: { kind: EngineActivity; promise: Promise<unknown> } | null = null;
  private lastPull: PullReport | null = null;
  private lastPublish: PublishReport | null = null;

  constructor(options: SyncEngineOptions) {
    if (!isDeviceProfile(options.profile)) {
      throw new SyncEngineError(
        "invalid_transports",
        `Unknown device profile "${String(options.profile)}"`,
      );
    }
    const claimed = new Map<string, string>();
    for (const transport of options.transports) {
      for (const domain of transport.domains) {
        if (!(SYNC_DOMAINS as readonly string[]).includes(domain)) {
          throw new SyncEngineError(
            "invalid_transports",
            `${transport.id} declares "${String(domain)}", which is not a sync domain`,
          );
        }
        const other = claimed.get(domain);
        if (other !== undefined) {
          throw new SyncEngineError(
            "invalid_transports",
            `${transport.id} and ${other} both declare the "${domain}" domain`,
          );
        }
        claimed.set(domain, transport.id);
      }
    }
    this.ctx = {
      repo: options.repo,
      transports: [...options.transports],
      profile: options.profile,
      now: options.now ?? Date.now,
      localSchemaVersion: options.localSchemaVersion ?? LATEST_MIGRATION_ID,
      appVersion: options.appVersion ?? "unknown",
      calendarSyncEnabled: options.calendarSyncEnabled ?? (() => false),
      beforeFirstMerge: options.beforeFirstMerge,
      transportTimeoutMs: options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
    };
  }

  /** Whether a pull, publish or sync is running right now. */
  get running(): EngineActivity | null {
    return this.inFlight?.kind ?? null;
  }

  pull(options: PullOptions = {}): Promise<PullReport> {
    return this.run("pull", async () => {
      const report = await runPull(this.ctx, options);
      this.lastPull = report;
      return report;
    });
  }

  publish(options: PublishOptions = {}): Promise<PublishReport> {
    return this.run("publish", async () => this.publishNow(options));
  }

  /** Pull, then publish. The pull options apply to the pull; `force` to the publish. */
  syncNow(options: PullOptions & PublishOptions = {}): Promise<SyncNowReport> {
    return this.run("syncNow", async () => {
      const pull = await runPull(this.ctx, options);
      this.lastPull = pull;
      const publish = await this.publishNow(options);
      return { pull, publish };
    });
  }

  /** What the `/sync` page shows: readiness, pending changes, one line per known peer, issues. */
  async getStatus(): Promise<EngineStatus> {
    let status: Awaited<ReturnType<EngineContext["repo"]["getSyncStatus"]>>;
    try {
      status = await this.ctx.repo.getSyncStatus();
    } catch {
      status = { supported: false };
    }
    const issues = [...(this.lastPull?.issues ?? []), ...(this.lastPublish?.issues ?? [])].filter(
      (issue) => issue.severity !== "info",
    );
    if (!status.supported) {
      return {
        ready: false,
        running: this.running,
        profile: this.ctx.profile,
        pendingChanges: 0,
        peers: [],
        lastPull: this.lastPull,
        lastPublish: this.lastPublish,
        issues,
      };
    }
    return {
      ready: status.identity !== null && status.captureEnabled,
      running: this.running,
      profile: this.ctx.profile,
      pendingChanges: status.pendingChanges,
      peers: this.peerStatuses(status.peers),
      lastPull: this.lastPull,
      lastPublish: this.lastPublish,
      issues,
    };
  }

  private async publishNow(options: PublishOptions): Promise<PublishReport> {
    const report = await runPublish(this.ctx, this.memory, options);
    this.lastPublish = report;
    return report;
  }

  private run<T>(kind: EngineActivity, work: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      if (this.inFlight.kind === kind) return this.inFlight.promise as Promise<T>;
      return Promise.reject(
        new SyncEngineError(
          "already_running",
          `A ${this.inFlight.kind} is already running; try again when it has finished`,
        ),
      );
    }
    const promise = work().finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { kind, promise };
    return promise;
  }

  private peerStatuses(
    stored: Extract<
      Awaited<ReturnType<EngineContext["repo"]["getSyncStatus"]>>,
      { supported: true }
    >["peers"],
  ): PeerStatus[] {
    const seen = new Map<string, PeerStatus>();
    for (const peer of stored) {
      const manifest = peer.lastManifest;
      seen.set(peer.peerId, {
        peerId: peer.peerId,
        peerName: peer.peerName,
        state: "unknown",
        message: null,
        lastSyncedAt: peer.lastSyncedAt,
        schemaVersion: typeof manifest?.schemaVersion === "number" ? manifest.schemaVersion : null,
        appVersion: typeof manifest?.appVersion === "string" ? manifest.appVersion : null,
        profile: isDeviceProfile(manifest?.profile) ? manifest.profile : null,
        calendarSyncEnabled:
          typeof manifest?.calendarSyncEnabled === "boolean" ? manifest.calendarSyncEnabled : null,
      });
    }
    const pull = this.lastPull;
    if (!pull) return [...seen.values()];

    // One peer can be reported once per folder it appears in: the most serious state wins.
    const worstByPeer = new Map<string, { state: PeerState; message: string | null }>();
    for (const peer of pull.peers) {
      if (peer.peerId === "") continue;
      const issues = pull.issues.filter(
        (issue) => issue.peerId === peer.peerId && issue.transport === peer.transport,
      );
      const worst =
        issues.find((issue) => issue.severity === "error") ??
        issues.find((issue) => issue.severity === "warning") ??
        issues[0];
      const state = stateOf(
        peer.status,
        peer.domains.map((domain) => domain.outcome),
        pull,
        peer.transport,
        worst,
      );
      const known = worstByPeer.get(peer.peerId);
      if (!known || PEER_STATE_RANK[state] > PEER_STATE_RANK[known.state]) {
        worstByPeer.set(peer.peerId, { state, message: worst?.message ?? null });
      }
      const entry: PeerStatus = seen.get(peer.peerId) ?? {
        peerId: peer.peerId,
        peerName: peer.peerName,
        state: "unknown",
        message: null,
        lastSyncedAt: null,
        schemaVersion: null,
        appVersion: null,
        profile: null,
        calendarSyncEnabled: null,
      };
      entry.peerName = peer.peerName || entry.peerName;
      seen.set(peer.peerId, entry);
    }
    for (const [peerId, verdict] of worstByPeer) {
      const entry = seen.get(peerId);
      if (entry) {
        entry.state = verdict.state;
        entry.message = verdict.message;
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.peerName === b.peerName ? (a.peerId < b.peerId ? -1 : 1) : a.peerName < b.peerName ? -1 : 1,
    );
  }
}

/** Higher is more serious; the `/sync` page shows the most serious state a peer is in. */
const PEER_STATE_RANK: Record<PeerState, number> = {
  unknown: 0,
  synced: 1,
  not_ready: 2,
  unreachable: 3,
  error: 4,
  stale: 5,
  update_required: 6,
  format_unsupported: 7,
  invalid_manifest: 8,
};

const stateOf = (
  status: PullReport["peers"][number]["status"],
  outcomes: readonly string[],
  pull: PullReport,
  transportId: string,
  worst: SyncIssue | undefined,
): PeerState => {
  if (status !== "ok") return status;
  if (pull.transports.some((transport) => transport.id === transportId && !transport.reachable)) {
    return "unreachable";
  }
  if (outcomes.some((outcome) => outcome === "rejected" || outcome === "refused")) return "error";
  if (outcomes.includes("not_ready")) return "not_ready";
  if (worst?.severity === "error") return "error";
  return "synced";
};

export const createSyncEngine = (options: SyncEngineOptions): SyncEngine => new SyncEngine(options);
