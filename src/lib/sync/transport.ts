import type { SyncChangeSet } from "./change-set";
import type { DeviceProfile } from "./profile";
import type { SyncDomain } from "./registry";

/**
 * The seam between the sync engine and wherever bundles live. The engine (`sync-engine.ts`) knows
 * nothing about folders, files, Drive or Tauri: it talks to `SyncTransport`s. The folder transport
 * (a later slice) and any future Drive transport implement this interface; the in-memory simulation in
 * `test-support/memory-transport.ts` implements it for tests.
 *
 * One transport instance serves ONE folder role. The shared GTD folder is a transport that declares
 * `domains: ["gtd"]`; the personal folder is one that declares `["personal", "finance"]`. The engine
 * takes an array of transports and routes every read and publish by domain through the declared
 * `domains`, so a `personal` bundle can never be handed to the GTD folder's transport. A device that
 * is not given a transport for a role (a work laptop has no personal folder) simply cannot reach it.
 */

/** What a peer says about one domain's current bundle (spec: `manifest.json`). */
export interface PeerDomainEntry {
  /** Increases by one with every publish of this domain by that peer. */
  generation: number;
  /** Bundle file name inside the peer's directory. Opaque to the engine. */
  file: string;
  /** Lowercase hex SHA-256 of the bundle bytes: the content identity the engine tracks. */
  sha256: string;
  bytes: number;
  rows: number;
}

/**
 * A peer's `manifest.json`. The engine treats it as untrusted input: `domains` is keyed by plain
 * strings so a manifest naming a domain nobody declared (a `personal` entry in the shared GTD
 * folder) can be represented, and refused, instead of being silently lost by a type.
 */
export interface PeerManifest {
  formatVersion: number;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  /** Highest migration id applied on the peer. */
  schemaVersion: number;
  /** ISO timestamp of the peer's last publish. */
  writtenAt: string;
  /** An upper bound of every clock the peer has published (see `SyncChangeSet.hlcHigh`). */
  hlcHigh: string;
  profile: DeviceProfile;
  domains: Record<string, PeerDomainEntry>;
  calendarSyncEnabled: boolean;
}

/** The outcome of reading one bundle. The transport has verified `bytes` and `sha256`. */
export type BundleRead =
  /**
   * Verified bytes. `changeSet` is whatever they decode to and is NOT trusted: bytes that verify but
   * do not parse are delivered as the raw text, and the engine's validation rejects them with the
   * peer's name (a corrupt bundle is an error to report, not an exception to propagate).
   */
  | { changeSet: unknown }
  /**
   * The file is missing, short, or fails verification: the peer's upload has not finished
   * propagating. The engine keeps its previous state and retries on the next trigger.
   */
  | { notReady: true };

/** What the transport needs to describe this device in the manifest it writes. */
export interface PublishMeta {
  deviceName: string;
  appVersion: string;
  profile: DeviceProfile;
  calendarSyncEnabled: boolean;
  /** Epoch milliseconds the publish started (the manifest's `writtenAt`). */
  writtenAtMs: number;
  /**
   * Identifies the engine instance that issues the call. Fencing is per (engine, domain): another
   * instance (a restarted app) starts a new sequence.
   */
  engineId: string;
  /**
   * Increases with every `publish` call of this engine instance (across domains; strictly per domain).
   * THE FENCING CONTRACT: a transport must not let an older `publishSeq` commit after a newer one for
   * the same (device, domain, `engineId`). The engine gives up on a call that times out and may then
   * publish a newer snapshot while the old operation is still running in the transport; when that old
   * operation finally reaches its commit point it must be rejected with
   * `SyncTransportError("stale_publish")` instead of overwriting the newer bundle and manifest. A
   * transport that serializes ALL publishes of a device in one queue, in call order, and runs each
   * to completion before the next, satisfies the contract without looking at the number. A rejected
   * stale commit is not a user-visible failure.
   */
  publishSeq: number;
}

export type SyncTransportErrorCode =
  | "unreachable"
  | "timeout"
  /** A newer publish of the same domain has already committed (see {@link PublishMeta.publishSeq}). */
  | "stale_publish";

/**
 * The folder is not there (an unmounted Drive path, a missing role marker), or did not answer in
 * time. Typed so the engine can say which, and so that neither can be mistaken for a bundle problem.
 */
export class SyncTransportError extends Error {
  readonly code: SyncTransportErrorCode;
  /**
   * The host's error code behind it (`folder_not_prepared`, `io`, ...), when the transport knows
   * one. Lets the page tell "the folder was never prepared" from "the drive is not mounted".
   */
  readonly reason: string | undefined;

  constructor(
    code: SyncTransportErrorCode,
    message: string,
    options?: { cause?: unknown; reason?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncTransportError";
    this.code = code;
    this.reason = options?.reason;
  }
}

export type SyncTransportFailureKind =
  /**
   * The folder is set up wrongly: it holds the other role's marker, or sits inside / around the
   * other folder. Retrying cannot fix it; the user has to pick another folder.
   */
  | "configuration"
  /** A bundle exceeds what the folder protocol can carry. Permanent until the data shrinks. */
  | "too_large"
  /** This runtime cannot read what a peer wrote (a compressed bundle without `DecompressionStream`). */
  | "unsupported"
  /** A bug or a host contract violation (a wrong domain handed over, an id the host refused). */
  | "internal";

/**
 * A failure that is NOT "the folder is not there right now": retrying quietly would only hide it. The
 * engine reports it as an error (`transport_failed`, `detail` = {@link SyncTransportFailure.kind})
 * and the `/sync` page shows it prominently instead of as a transient warning.
 */
export class SyncTransportFailure extends Error {
  readonly kind: SyncTransportFailureKind;
  /** The host's error code or the bundle error code behind it, when there is one. */
  readonly reason: string | undefined;

  constructor(
    kind: SyncTransportFailureKind,
    message: string,
    options?: { cause?: unknown; reason?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncTransportFailure";
    this.kind = kind;
    this.reason = options?.reason;
  }
}

export interface SyncTransport {
  /** Stable, human-readable name for reports ("folder:gtd"). */
  readonly id: string;
  /**
   * The domains this transport carries, in both directions. A transport never reads or writes a
   * domain it does not declare, and the engine never routes one to it.
   */
  readonly domains: readonly SyncDomain[];
  /**
   * The manifests of every OTHER device that wrote to this folder. Excludes this device and ignores
   * Drive conflict copies (`manifest (1).json`) and stray files. Rejects with a
   * {@link SyncTransportError} when the folder cannot be reached.
   */
  listPeers(): Promise<PeerManifest[]>;
  /**
   * One peer's bundle for one domain, size- and hash-verified. A mismatch or a partial download is
   * `{ notReady: true }`, never an exception that aborts the run. Rejects with a
   * {@link SyncTransportError} only when the folder cannot be reached.
   */
  readBundle(peer: PeerManifest, domain: SyncDomain): Promise<BundleRead>;
  /**
   * Writes this device's bundle for `domain`: bundle file first, manifest last (the commit point).
   * Returns the new generation. Rejects with a {@link SyncTransportError} when unreachable, or `stale_publish` when fenced
   * (see {@link PublishMeta.publishSeq}).
   */
  publish(
    domain: SyncDomain,
    changeSet: SyncChangeSet,
    meta: PublishMeta,
  ): Promise<{ generation: number }>;
  /**
   * The generation of this device's own published bundle of `domain`, or `null` when none was ever
   * published to this folder. It is what lets the engine publish into a folder that was configured
   * after the local change counter had already moved on.
   */
  ownGeneration(domain: SyncDomain): Promise<number | null>;
}
