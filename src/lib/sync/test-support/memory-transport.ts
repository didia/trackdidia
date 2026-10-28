// Test-only: nothing in the app imports this file.
//
// SAFETY: an in-memory simulation of the shared folders. It never touches a real directory.
import { createHash } from "node:crypto";
import { type SyncChangeSet, SYNC_FORMAT_VERSION } from "../change-set";
import type { SyncDomain } from "../registry";
import {
  type BundleRead,
  type PeerDomainEntry,
  type PeerManifest,
  type PublishMeta,
  SyncTransportError,
  type SyncTransport,
} from "../transport";

/**
 * A simulation of the shared Drive folders for the sync engine's tests: one in-memory file system per
 * folder ROLE, written the way the real folder transport will write it, so the engine is exercised
 * against the same protocol (spec: "Folder protocol"):
 *
 * ```text
 * gtd/       sync/<deviceId>/manifest.json   sync/<deviceId>/gtd-<generation>.bundle
 * personal/  sync/<deviceId>/manifest.json   sync/<deviceId>/personal-<n>.bundle  finance-<n>.bundle
 * ```
 *
 * - Publish writes the bundle file first and the manifest LAST (the commit point), keeps the previous
 *   generation's file and deletes older ones. A reader only ever learns of a bundle from a manifest.
 * - Reads verify `bytes` and `sha256`; a mismatch is `notReady`, never an exception.
 * - Listing ignores this device's own directory and everything that is not exactly
 *   `sync/<deviceId>/manifest.json` (conflict copies such as `manifest (1).json`).
 * - Visibility is physical: a device holds transports only for the roles it was attached to
 *   ({@link MemoryFolders.attach}), and {@link MemoryFolders.visibleFiles} lists exactly what such a
 *   device can read. A work device is attached to the `gtd` folder only.
 * - Faults can be injected per folder and per bundle: unreachable, timeout, never answering, a
 *   publish that crashes before its manifest, partial and unverified bundles, corrupt bytes that
 *   verify, wrong-domain content, a rewritten manifest (older or newer schema, old `writtenAt`,
 *   unknown format), a conflict copy, and hooks that run in the middle of an operation.
 */

export type FolderRole = "gtd" | "personal";

/** The domains each folder role carries (spec: "Folder protocol"). */
export const ROLE_DOMAINS: Readonly<Record<FolderRole, readonly SyncDomain[]>> = {
  gtd: ["gtd"],
  personal: ["personal", "finance"],
};

export type FolderOperation = "listPeers" | "readBundle" | "publish" | "ownGeneration";

export interface OperationCounts {
  listPeers: number;
  readBundle: number;
  publish: number;
  ownGeneration: number;
}

export interface VisibleFile {
  role: FolderRole;
  path: string;
  content: string;
}

export type FolderMode = "up" | "unreachable" | "timeout" | "hang";

interface Folder {
  role: FolderRole;
  files: Map<string, string>;
  mode: FolderMode;
  /** Runs inside an operation, after its bookkeeping and before its effect. */
  hooks: Partial<Record<FolderOperation, (info: { deviceId: string }) => void | Promise<void>>>;
  /** Next publish writes its bundle and then dies before the manifest (a crash mid-publish). */
  crashBeforeManifest: number;
}

const manifestPath = (deviceId: string) => `sync/${deviceId}/manifest.json`;
const bundlePath = (deviceId: string, file: string) => `sync/${deviceId}/${file}`;
const sha256Of = (content: string) => createHash("sha256").update(content).digest("hex");
const bytesOf = (content: string) => Buffer.byteLength(content, "utf8");

const rowsOf = (changeSet: SyncChangeSet): number =>
  changeSet.entities.length +
  Object.values(changeSet.unionRows).reduce((total, rows) => total + rows.length, 0) +
  changeSet.settings.length;

export class MemoryFolders {
  private readonly folders: Record<FolderRole, Folder> = {
    gtd: { role: "gtd", files: new Map(), mode: "up", hooks: {}, crashBeforeManifest: 0 },
    personal: { role: "personal", files: new Map(), mode: "up", hooks: {}, crashBeforeManifest: 0 },
  };
  private readonly attachments = new Map<string, Set<FolderRole>>();
  private readonly counts = new Map<string, OperationCounts>();
  private readonly offline = new Set<string>();
  private fencing = true;
  /** The highest `publishSeq` committed per (role, device, engine, domain). */
  private readonly committedSeq = new Map<string, number>();

  // ---- Attaching devices ----------------------------------------------------------------------

  /**
   * Gives a device access to one folder and returns its transport. A device that is never attached
   * to a role has no transport for it and {@link visibleFiles} never lists that folder's files.
   */
  attach(deviceId: string, role: FolderRole): SyncTransport {
    const roles = this.attachments.get(deviceId) ?? new Set<FolderRole>();
    roles.add(role);
    this.attachments.set(deviceId, roles);
    return new MemoryTransport(this, this.folders[role], deviceId);
  }

  rolesOf(deviceId: string): FolderRole[] {
    return [...(this.attachments.get(deviceId) ?? [])];
  }

  /** Every file a device can read: the files of the folders it is attached to, and nothing else. */
  visibleFiles(deviceId: string): VisibleFile[] {
    const files: VisibleFile[] = [];
    for (const role of this.rolesOf(deviceId)) {
      for (const [path, content] of this.folders[role].files) files.push({ role, path, content });
    }
    return files;
  }

  /** Every file of a folder, for assertions about the folder itself (not about a device's view). */
  filesOf(role: FolderRole): VisibleFile[] {
    return [...this.folders[role].files].map(([path, content]) => ({ role, path, content }));
  }

  // ---- Counting -------------------------------------------------------------------------------

  /** How often a device called each operation on a folder. */
  calls(deviceId: string, role: FolderRole): OperationCounts {
    return { ...this.countsOf(deviceId, role) };
  }

  resetCalls(): void {
    this.counts.clear();
  }

  /** @internal */
  countsOf(deviceId: string, role: FolderRole): OperationCounts {
    const key = `${deviceId}|${role}`;
    let counts = this.counts.get(key);
    if (!counts) {
      counts = { listPeers: 0, readBundle: 0, publish: 0, ownGeneration: 0 };
      this.counts.set(key, counts);
    }
    return counts;
  }

  // ---- Fault injection ------------------------------------------------------------------------

  /** `unreachable` and `timeout` make every operation throw that error; `hang` never answers. */
  setMode(role: FolderRole, mode: FolderMode): void {
    this.folders[role].mode = mode;
  }

  /**
   * Turns commit-time fencing (`PublishMeta.publishSeq`) on or off. On by default, like a transport
   * that honours the contract; off models one that lets an old, slow publish commit after a newer one.
   */
  setFencing(enabled: boolean): void {
    this.fencing = enabled;
  }

  /** @internal Rejects (by returning false) a commit older than one already committed. */
  admitCommit(role: FolderRole, deviceId: string, domain: SyncDomain, meta: PublishMeta): boolean {
    const key = `${role}|${deviceId}|${meta.engineId}|${domain}`;
    const newest = this.committedSeq.get(key) ?? 0;
    if (this.fencing && meta.publishSeq < newest) return false;
    this.committedSeq.set(key, Math.max(newest, meta.publishSeq));
    return true;
  }

  /** A device that is offline reaches no folder at all (its laptop is closed or has no network). */
  setDeviceOffline(deviceId: string, offline: boolean): void {
    if (offline) this.offline.add(deviceId);
    else this.offline.delete(deviceId);
  }

  /** @internal */
  isOffline(deviceId: string): boolean {
    return this.offline.has(deviceId);
  }

  /** Runs `hook` inside every `operation` on the folder, before its effect. */
  onOperation(
    role: FolderRole,
    operation: FolderOperation,
    hook: ((info: { deviceId: string }) => void | Promise<void>) | undefined,
  ): void {
    if (hook === undefined) delete this.folders[role].hooks[operation];
    else this.folders[role].hooks[operation] = hook;
  }

  /** The next `count` publishes into the folder write their bundle, then fail before the manifest. */
  crashNextPublishes(role: FolderRole, count = 1): void {
    this.folders[role].crashBeforeManifest = count;
  }

  /**
   * Damages one published bundle file.
   * - `partial`: only the first half of the bytes arrived (size mismatch, so `notReady`).
   * - `unverified`: same size, different bytes (hash mismatch, so `notReady`).
   * - `not-json`: garbage that the manifest was rewritten to describe, so it VERIFIES but does not
   *   parse; the engine must reject it as a corrupt bundle.
   * - `bad-shape`: valid JSON that is not a change set, likewise verifying.
   */
  damageBundle(
    role: FolderRole,
    deviceId: string,
    domain: SyncDomain,
    kind: "partial" | "unverified" | "not-json" | "bad-shape",
  ): void {
    const folder = this.folders[role];
    const entry = this.manifestOf(folder, deviceId)?.domains[domain];
    if (!entry) throw new Error(`${deviceId} has no ${domain} bundle in the ${role} folder`);
    const path = bundlePath(deviceId, entry.file);
    const content = folder.files.get(path) ?? "";
    if (kind === "partial") {
      folder.files.set(path, content.slice(0, Math.floor(content.length / 2)));
    } else if (kind === "unverified") {
      folder.files.set(path, content.replace(/./g, "x").slice(0, content.length));
    } else {
      const replacement = kind === "not-json" ? "{this is not json" : '{"formatVersion":1}';
      folder.files.set(path, replacement);
      this.patchManifest(role, deviceId, {
        domains: {
          [domain]: { ...entry, sha256: sha256Of(replacement), bytes: bytesOf(replacement) },
        },
      });
    }
  }

  /** Puts the original bytes back (and a manifest entry that describes them), as a finished upload. */
  restoreBundle(role: FolderRole, deviceId: string, domain: SyncDomain, original: string): void {
    const folder = this.folders[role];
    const entry = this.manifestOf(folder, deviceId)?.domains[domain];
    if (!entry) throw new Error(`${deviceId} has no ${domain} bundle in the ${role} folder`);
    folder.files.set(bundlePath(deviceId, entry.file), original);
    this.patchManifest(role, deviceId, {
      domains: { [domain]: { ...entry, sha256: sha256Of(original), bytes: bytesOf(original) } },
    });
  }

  /** The raw text of a published bundle (to keep before damaging it). */
  bundleText(role: FolderRole, deviceId: string, domain: SyncDomain): string {
    const folder = this.folders[role];
    const entry = this.manifestOf(folder, deviceId)?.domains[domain];
    if (!entry) throw new Error(`${deviceId} has no ${domain} bundle in the ${role} folder`);
    return folder.files.get(bundlePath(deviceId, entry.file)) ?? "";
  }

  /**
   * Rewrites fields of a peer's manifest in place (`domains` entries are merged per domain key, so
   * a patch can also ADD a domain the folder should never carry). Models an older or newer
   * schema, a stale `writtenAt`, an unknown format version, a lying profile, a malformed field.
   */
  patchManifest(
    role: FolderRole,
    deviceId: string,
    patch: Partial<Omit<PeerManifest, "domains">> & { domains?: Record<string, unknown> },
  ): void {
    const folder = this.folders[role];
    const current = this.manifestOf(folder, deviceId);
    if (!current) throw new Error(`${deviceId} has no manifest in the ${role} folder`);
    const { domains, ...rest } = patch;
    const next = {
      ...current,
      ...rest,
      domains: { ...current.domains, ...(domains ?? {}) },
    };
    folder.files.set(manifestPath(deviceId), JSON.stringify(next));
  }

  /**
   * Stores arbitrary bundle text as a peer's `domainKey` bundle, with a manifest entry that
   * describes it correctly. For a wrong-domain bundle in the GTD folder (the personal change set of
   * another device placed behind a `gtd` entry) or a manifest key the folder should never carry.
   */
  plantBundle(
    role: FolderRole,
    deviceId: string,
    domainKey: string,
    content: SyncChangeSet | string,
  ): void {
    const folder = this.folders[role];
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const current = this.manifestOf(folder, deviceId);
    if (!current) throw new Error(`${deviceId} has no manifest in the ${role} folder`);
    const generation = (current.domains[domainKey]?.generation ?? 0) + 1;
    const file = `${domainKey}-${generation}.bundle`;
    folder.files.set(bundlePath(deviceId, file), text);
    this.patchManifest(role, deviceId, {
      domains: {
        [domainKey]: {
          generation,
          file,
          sha256: sha256Of(text),
          bytes: bytesOf(text),
          rows: typeof content === "string" ? 0 : rowsOf(content),
        },
      },
    });
  }

  /** A Drive conflict copy of a peer's manifest, with contents that would be wrong to follow. */
  plantConflictCopy(role: FolderRole, deviceId: string): void {
    const folder = this.folders[role];
    const current = this.manifestOf(folder, deviceId);
    if (!current) throw new Error(`${deviceId} has no manifest in the ${role} folder`);
    const poisoned = JSON.stringify({
      ...current,
      schemaVersion: 9999,
      deviceName: "Conflict copy",
    });
    folder.files.set(`sync/${deviceId}/manifest (1).json`, poisoned);
    folder.files.set(`sync/${deviceId} (1)/manifest.json`, poisoned);
    folder.files.set("sync/stray.txt", "not a device directory");
  }

  /** Deletes a peer's whole directory (a laptop removed from the folder). */
  removePeer(role: FolderRole, deviceId: string): void {
    const folder = this.folders[role];
    for (const path of [...folder.files.keys()]) {
      if (path.startsWith(`sync/${deviceId}/`)) folder.files.delete(path);
    }
  }

  /** The manifest of a peer as currently stored, or `null`. */
  manifestFor(role: FolderRole, deviceId: string): PeerManifest | null {
    return this.manifestOf(this.folders[role], deviceId);
  }

  // ---- Internals used by the transport --------------------------------------------------------

  /** @internal */
  manifestOf(folder: Folder, deviceId: string): PeerManifest | null {
    const text = folder.files.get(manifestPath(deviceId));
    if (text === undefined) return null;
    try {
      return JSON.parse(text) as PeerManifest;
    } catch {
      return null;
    }
  }
}

class MemoryTransport implements SyncTransport {
  readonly id: string;
  readonly domains: readonly SyncDomain[];

  constructor(
    private readonly world: MemoryFolders,
    private readonly folder: Folder,
    private readonly deviceId: string,
  ) {
    this.id = `folder:${folder.role}`;
    this.domains = ROLE_DOMAINS[folder.role];
  }

  private async enter(operation: FolderOperation): Promise<void> {
    this.world.countsOf(this.deviceId, this.folder.role)[operation] += 1;
    if (this.world.isOffline(this.deviceId)) {
      throw new SyncTransportError("unreachable", "This laptop is offline");
    }
    switch (this.folder.mode) {
      case "unreachable":
        throw new SyncTransportError(
          "unreachable",
          `The ${this.folder.role} folder is not mounted`,
        );
      case "timeout":
        throw new SyncTransportError("timeout", `The ${this.folder.role} folder did not answer`);
      case "hang":
        await new Promise<never>(() => undefined);
        break;
      default:
        break;
    }
    await this.folder.hooks[operation]?.({ deviceId: this.deviceId });
  }

  async listPeers(): Promise<PeerManifest[]> {
    await this.enter("listPeers");
    const peers: PeerManifest[] = [];
    for (const path of this.folder.files.keys()) {
      // Exactly sync/<deviceId>/manifest.json: conflict copies and strays do not match.
      const match = /^sync\/(dev:[0-9a-f-]{36})\/manifest\.json$/.exec(path);
      if (!match || match[1] === this.deviceId) continue;
      const manifest = this.world.manifestOf(this.folder, match[1] as string);
      if (manifest) peers.push(manifest);
    }
    return peers;
  }

  async readBundle(peer: PeerManifest, domain: SyncDomain): Promise<BundleRead> {
    await this.enter("readBundle");
    const entry = peer.domains?.[domain];
    if (!entry) return { notReady: true };
    const content = this.folder.files.get(bundlePath(peer.deviceId, entry.file));
    if (content === undefined) return { notReady: true };
    if (bytesOf(content) !== entry.bytes || sha256Of(content) !== entry.sha256) {
      return { notReady: true };
    }
    try {
      return { changeSet: JSON.parse(content) as unknown };
    } catch {
      // Verified bytes that do not parse: handed over as text, the engine rejects them.
      return { changeSet: content };
    }
  }

  async publish(
    domain: SyncDomain,
    changeSet: SyncChangeSet,
    meta: PublishMeta,
  ): Promise<{ generation: number }> {
    await this.enter("publish");
    if (!this.domains.includes(domain)) {
      throw new Error(`The ${this.folder.role} folder does not carry the ${domain} domain`);
    }
    // Commit point: an operation that was held past a newer one must not overwrite it.
    if (!this.world.admitCommit(this.folder.role, this.deviceId, domain, meta)) {
      throw new SyncTransportError(
        "stale_publish",
        `A newer ${domain} publish has already committed`,
      );
    }
    const previous = this.world.manifestOf(this.folder, this.deviceId);
    const generation = (previous?.domains[domain]?.generation ?? 0) + 1;
    const file = `${domain}-${generation}.bundle`;
    const content = JSON.stringify(changeSet);
    this.folder.files.set(bundlePath(this.deviceId, file), content);

    if (this.folder.crashBeforeManifest > 0) {
      this.folder.crashBeforeManifest -= 1;
      throw new SyncTransportError("unreachable", "The folder went away before the manifest");
    }

    const entry: PeerDomainEntry = {
      generation,
      file,
      sha256: sha256Of(content),
      bytes: bytesOf(content),
      rows: rowsOf(changeSet),
    };
    const manifest: PeerManifest = {
      formatVersion: SYNC_FORMAT_VERSION,
      deviceId: this.deviceId,
      deviceName: meta.deviceName,
      appVersion: meta.appVersion,
      schemaVersion: changeSet.schemaVersion,
      writtenAt: new Date(meta.writtenAtMs).toISOString(),
      hlcHigh: changeSet.hlcHigh,
      profile: meta.profile,
      domains: { ...(previous?.domains ?? {}), [domain]: entry },
      calendarSyncEnabled: meta.calendarSyncEnabled,
    };
    // The manifest is last: it is the commit point.
    this.folder.files.set(manifestPath(this.deviceId), JSON.stringify(manifest));

    // Keep the previous generation for a reader mid-download; delete older ones.
    const prefix = `sync/${this.deviceId}/${domain}-`;
    for (const path of [...this.folder.files.keys()]) {
      if (!path.startsWith(prefix) || !path.endsWith(".bundle")) continue;
      const old = Number(path.slice(prefix.length, -".bundle".length));
      if (Number.isInteger(old) && old < generation - 1) this.folder.files.delete(path);
    }
    return { generation };
  }

  async ownGeneration(domain: SyncDomain): Promise<number | null> {
    await this.enter("ownGeneration");
    return this.world.manifestOf(this.folder, this.deviceId)?.domains[domain]?.generation ?? null;
  }
}

export const createMemoryFolders = (): MemoryFolders => new MemoryFolders();
