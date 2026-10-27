import { logDebug } from "../debug";
import { decodeBundle, encodeBundle, MAX_ENCODED_BUNDLE_BYTES, SyncBundleError } from "./bundle";
import { SYNC_FORMAT_VERSION, type SyncChangeSet } from "./change-set";
import {
  type IgnoredSyncEntry,
  type ListedSyncPeers,
  listSyncPeers,
  prepareSyncFolder,
  publishSyncBundle,
  readSyncBundle,
  SYNC_MAX_BUNDLE_BYTES,
  SyncFolderError,
  type SyncFolderEnvironment,
  type SyncFolderRole,
} from "./folder-api";
import { compareHlc, isValidHlc } from "./hlc";
import type { SyncDomain } from "./registry";
import {
  type BundleRead,
  type PeerManifest,
  type PublishMeta,
  type SyncTransport,
  SyncTransportError,
  SyncTransportFailure,
} from "./transport";

/**
 * The folder transport: a {@link SyncTransport} over the four native folder commands
 * (`folder-api.ts`), one instance per folder role.
 *
 * - The `gtd` folder carries `["gtd"]`; the `personal` folder (the backup destination) carries
 *   `["personal", "finance"]`. The role is fixed at construction and sent with every command, and the
 *   transport refuses to publish a domain it does not carry before anything is encoded, so a
 *   `personal` bundle cannot reach the shared GTD folder through here. The host checks the same pair
 *   again (`domain_not_allowed`), which a correct engine never triggers: if it happens it is a bug
 *   and is reported as an `internal` failure, not retried.
 * - Bundles are {@link encodeBundle}d here and decoded here; the host treats them as opaque bytes.
 *   Bundle contents are never logged.
 * - Errors. A folder that is not there (`folder_not_found`, `folder_not_prepared`, `io`) is
 *   `SyncTransportError("unreachable")`, a host `timeout` is `SyncTransportError("timeout")`: both are
 *   warnings the next run retries. Everything that retrying cannot fix is a
 *   {@link SyncTransportFailure}: `configuration` (`role_mismatch`, `nested_folder`), `too_large`,
 *   `unsupported` and `internal`.
 * - A publish that times out may still commit in the host (it keeps running underneath). The
 *   transport therefore reads its own manifest back and, when the new bundle is there, reports
 *   success instead of a failure that would republish a second generation of the same data.
 * - Publishes of one device are serialized here (the host also serializes them per device directory).
 */

export const FOLDER_ROLE_DOMAINS: Readonly<Record<SyncFolderRole, readonly SyncDomain[]>> = {
  gtd: ["gtd"],
  personal: ["personal", "finance"],
};

/** What the transport needs from `folder-api.ts`; tests substitute a fake host. */
export interface FolderApi {
  prepareSyncFolder: typeof prepareSyncFolder;
  publishSyncBundle: typeof publishSyncBundle;
  listSyncPeers: typeof listSyncPeers;
  readSyncBundle: typeof readSyncBundle;
}

export const realFolderApi: FolderApi = {
  prepareSyncFolder,
  publishSyncBundle,
  listSyncPeers,
  readSyncBundle,
};

export interface FolderTransportOptions {
  role: SyncFolderRole;
  /** The user-chosen folder root (the GTD folder, or the backup destination for `personal`). */
  folderDir: string;
  environment: SyncFolderEnvironment;
  /** This device's id (`dev:<uuid v4>`), from the device-id file. */
  deviceId: string;
  api?: FolderApi;
}

/** What the last listing of the folder skipped; the `/sync` page shows it as warnings. */
export interface FolderListing {
  atMs: number;
  ignored: IgnoredSyncEntry[];
}

/** Maps what the host or the bundle module threw to the transport's own typed errors. */
export const mapFolderError = (error: unknown, what: string): Error => {
  if (error instanceof SyncTransportError || error instanceof SyncTransportFailure) return error;
  if (error instanceof SyncBundleError) {
    return new SyncTransportFailure(
      error.code === "compression_unavailable"
        ? "unsupported"
        : // One record over the line cap every reader enforces: it can never be published.
          error.code === "line_too_long"
          ? "too_large"
          : "internal",
      `${what}: ${error.message}`,
      { cause: error, reason: error.code },
    );
  }
  if (!(error instanceof SyncFolderError)) {
    return new SyncTransportFailure(
      "internal",
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  switch (error.code) {
    case "timeout":
      return new SyncTransportError("timeout", `${what}: ${error.message}`, { cause: error });
    case "folder_not_found":
    case "folder_not_prepared":
    case "io":
      return new SyncTransportError("unreachable", `${what}: ${error.message}`, {
        cause: error,
        reason: error.code,
      });
    case "role_mismatch":
    case "nested_folder":
      return new SyncTransportFailure(
        "configuration",
        `${what}: ${error.message}. Choose another folder in Settings`,
        { cause: error, reason: error.code },
      );
    case "too_large":
      return new SyncTransportFailure(
        "too_large",
        `${what}: the data is too large for the folder protocol (${error.message})`,
        { cause: error, reason: error.code },
      );
    default:
      // domain_not_allowed, device_id_invalid, invalid_argument, unknown: a correct engine and a
      // correct host never produce them.
      return new SyncTransportFailure("internal", `${what}: ${error.message} (${error.code})`, {
        cause: error,
        reason: error.code,
      });
  }
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class FolderTransport implements SyncTransport {
  readonly id: string;
  readonly domains: readonly SyncDomain[];
  readonly role: SyncFolderRole;
  private readonly folderDir: string;
  private readonly environment: SyncFolderEnvironment;
  private readonly deviceId: string;
  private readonly api: FolderApi;
  private tail: Promise<unknown> = Promise.resolve();
  private listing: FolderListing | null = null;
  private publishWarnings: string[] = [];
  /** The highest clock this device has published to this folder, across domains. */
  private hlcHigh: string | null = null;

  constructor(options: FolderTransportOptions) {
    this.role = options.role;
    this.id = `folder:${options.role}`;
    this.domains = FOLDER_ROLE_DOMAINS[options.role];
    this.folderDir = options.folderDir;
    this.environment = options.environment;
    this.deviceId = options.deviceId;
    this.api = options.api ?? realFolderApi;
  }

  /** What the last `listPeers` skipped (stray files, Drive conflict copies), or `null` before one. */
  lastListing(): FolderListing | null {
    return this.listing;
  }

  /** Non-fatal notes of the last publish (a directory flush the volume does not support, ...). */
  lastPublishWarnings(): readonly string[] {
    return this.publishWarnings;
  }

  private target() {
    return { folderDir: this.folderDir, role: this.role, environment: this.environment };
  }

  private assertCarries(domain: SyncDomain, what: string): void {
    if (!this.domains.includes(domain)) {
      throw new SyncTransportFailure(
        "internal",
        `${this.id} does not carry the "${domain}" domain (${what})`,
        { reason: "domain_not_allowed" },
      );
    }
  }

  private async list(what: string): Promise<ListedSyncPeers> {
    try {
      return await this.api.listSyncPeers({ ...this.target(), ownDeviceId: this.deviceId });
    } catch (error) {
      throw mapFolderError(error, what);
    }
  }

  async listPeers(): Promise<PeerManifest[]> {
    const listed = await this.list("Listing the other laptops");
    const ignored = Array.isArray(listed?.ignored) ? listed.ignored : [];
    this.listing = { atMs: Date.now(), ignored };
    const own = isRecord(listed?.own) ? listed.own : null;
    if (own !== null && isValidHlc(own.hlcHigh)) this.noteHlc(own.hlcHigh);
    // The host validated what it could; the engine's manifest gates do the rest. A stray non-object
    // is dropped here rather than handed on as a "manifest".
    const peers = Array.isArray(listed?.peers) ? listed.peers.filter(isRecord) : [];
    return peers as unknown as PeerManifest[];
  }

  async readBundle(peer: PeerManifest, domain: SyncDomain): Promise<BundleRead> {
    this.assertCarries(domain, "read");
    const what = `Reading the ${domain} data of ${String(peer?.deviceName ?? "a laptop")}`;
    let read: Awaited<ReturnType<typeof readSyncBundle>>;
    try {
      read = await this.api.readSyncBundle({
        ...this.target(),
        ownDeviceId: this.deviceId,
        peerDeviceId: String(peer.deviceId),
        domain,
      });
    } catch (error) {
      throw mapFolderError(error, what);
    }
    if (read.status !== "ok") return { notReady: true };
    // The manifest can move between the listing and this read. Applying the newer bundle under the
    // older hash would only make the next pull read it again, but "not ready" is simpler and exact.
    const listedSha = peer.domains?.[domain]?.sha256;
    if (typeof listedSha === "string" && read.sha256 !== listedSha) return { notReady: true };

    try {
      return { changeSet: await decodeBundle(read.bytes) };
    } catch (error) {
      if (!(error instanceof SyncBundleError)) throw mapFolderError(error, what);
      if (error.code === "compression_unavailable") throw mapFolderError(error, what);
      // Verified bytes that are not a bundle: a corrupt or foreign file. The contract hands the
      // engine something it cannot validate, and it rejects the bundle with the peer's name. The
      // reason goes to the debug log (never any content).
      logDebug("warn", "sync.transport", "Un bundle verifie n'a pas pu etre decode", {
        transport: this.id,
        peer: peer.deviceId,
        domain,
        code: error.code,
      });
      return { changeSet: `undecodable bundle (${error.code}): ${error.message}` };
    }
  }

  async publish(
    domain: SyncDomain,
    changeSet: SyncChangeSet,
    meta: PublishMeta,
  ): Promise<{ generation: number }> {
    this.assertCarries(domain, "publish");
    if (changeSet.domain !== domain) {
      throw new SyncTransportFailure(
        "internal",
        `Refusing to publish a "${changeSet.domain}" bundle as "${domain}" to ${this.id}`,
        { reason: "domain_not_allowed" },
      );
    }
    const what = `Publishing the ${domain} data`;
    return this.serialized(async () => {
      let encoded: Awaited<ReturnType<typeof encodeBundle>>;
      try {
        encoded = await encodeBundle(changeSet);
      } catch (error) {
        throw mapFolderError(error, what);
      }
      if (encoded.bytes.length > SYNC_MAX_BUNDLE_BYTES) {
        throw new SyncTransportFailure(
          "too_large",
          `${what}: the bundle is ${encoded.bytes.length} bytes, over the ${MAX_ENCODED_BUNDLE_BYTES} the folder protocol carries`,
          { reason: "too_large" },
        );
      }
      this.noteHlc(changeSet.hlcHigh);
      const manifest = {
        formatVersion: SYNC_FORMAT_VERSION,
        deviceId: this.deviceId,
        deviceName: meta.deviceName,
        appVersion: meta.appVersion,
        schemaVersion: changeSet.schemaVersion,
        writtenAt: new Date(meta.writtenAtMs).toISOString(),
        hlcHigh: this.hlcHigh ?? changeSet.hlcHigh,
        profile: meta.profile,
        calendarSyncEnabled: meta.calendarSyncEnabled,
      };
      try {
        const published = await this.api.publishSyncBundle({
          ...this.target(),
          deviceId: this.deviceId,
          domain,
          bundle: encoded.bytes,
          rows: encoded.records,
          manifest,
        });
        this.publishWarnings = Array.isArray(published.warnings) ? published.warnings : [];
        return { generation: published.generation };
      } catch (error) {
        const mapped = mapFolderError(error, what);
        // After a timeout the host may still have committed: do not report a failure that would
        // publish the same data again as a second generation.
        if (mapped instanceof SyncTransportError && mapped.code === "timeout") {
          const committed = await this.committedGeneration(domain, encoded.bytes);
          if (committed !== null) return { generation: committed };
        }
        throw mapped;
      }
    });
  }

  async ownGeneration(domain: SyncDomain): Promise<number | null> {
    this.assertCarries(domain, "ownGeneration");
    const listed = await this.list("Checking this laptop's published data");
    return generationOf(listed.own, domain);
  }

  /** The generation of this device's manifest entry when it holds exactly `bytes`, else `null`. */
  private async committedGeneration(domain: SyncDomain, bytes: Uint8Array): Promise<number | null> {
    try {
      const listed = await this.list("Checking whether the publish committed");
      const entry = isRecord(listed.own) ? domainEntry(listed.own, domain) : null;
      if (entry === null || entry.sha256 !== (await sha256Hex(bytes))) return null;
      return generationOf(listed.own, domain);
    } catch {
      return null;
    }
  }

  private noteHlc(candidate: string): void {
    if (this.hlcHigh === null || compareHlc(candidate, this.hlcHigh) > 0) this.hlcHigh = candidate;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

const domainEntry = (
  manifest: Record<string, unknown>,
  domain: string,
): Record<string, unknown> | null => {
  const domains = manifest.domains;
  if (!isRecord(domains)) return null;
  const entry = Object.getOwnPropertyDescriptor(domains, domain)?.value;
  return isRecord(entry) ? entry : null;
};

const generationOf = (manifest: Record<string, unknown> | null, domain: string): number | null => {
  if (manifest === null || !isRecord(manifest)) return null;
  const generation = domainEntry(manifest, domain)?.generation;
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 1
    ? generation
    : null;
};

export const createFolderTransport = (options: FolderTransportOptions): FolderTransport =>
  new FolderTransport(options);
