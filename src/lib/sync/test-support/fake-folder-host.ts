// Test-only: nothing in the app imports this file.
//
// SAFETY: an in-memory stand-in for the native folder commands. It never touches a real directory.
import { createHash } from "node:crypto";
import type { FolderApi } from "../transport-folder";
import {
  type ListedSyncPeers,
  type PreparedSyncFolder,
  type PublishedSyncBundle,
  type ReadSyncBundleResult,
  SYNC_MAX_BUNDLE_BYTES,
  SyncFolderError,
  type SyncFolderErrorCode,
  type SyncFolderRole,
} from "../folder-api";

/**
 * A fake of `sync_folder.rs` at the `folder-api.ts` seam, enforcing the rules the transport relies
 * on: role markers, `domain_not_allowed`, nesting, manifest merge, generations owned by the host,
 * size and hash verification, the 64 MiB cap. Folders are identified by the path string the caller
 * passes, and must be "mounted" first (an unmounted path is `folder_not_found`, exactly like an
 * absent Drive).
 *
 * Faults: {@link FakeFolderHost.failNext} rejects the next call of a command with a host error;
 * {@link FakeFolderHost.timeoutNextPublish} makes the next publish time out either before or after
 * it commits.
 */

const ROLE_DOMAINS: Record<SyncFolderRole, readonly string[]> = {
  gtd: ["gtd"],
  personal: ["personal", "finance"],
};

type Command = "prepare" | "publish" | "list" | "read";

interface Folder {
  role: SyncFolderRole | null;
  /** Relative path -> content. */
  files: Map<string, Uint8Array | string>;
}

export interface FakeCall {
  command: Command;
  folderDir: string;
  role: SyncFolderRole;
  detail?: Record<string, unknown>;
}

const normalize = (path: string) => path.replace(/[/\\]+$/, "");
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dirName = (deviceId: string) => `dev-${deviceId.slice("dev:".length)}`;
const isInside = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);

export class FakeFolderHost {
  private readonly folders = new Map<string, Folder>();
  private readonly failures = new Map<Command, SyncFolderError[]>();
  private publishTimeout: "before" | "after" | null = null;
  readonly calls: FakeCall[] = [];

  /** Makes a folder exist (a mounted Drive path). */
  mount(folderDir: string, files: Record<string, string> = {}): void {
    this.folders.set(normalize(folderDir), { role: null, files: new Map(Object.entries(files)) });
  }

  unmount(folderDir: string): void {
    this.folders.delete(normalize(folderDir));
  }

  failNext(command: Command, code: SyncFolderErrorCode, message: string = code): void {
    const queue = this.failures.get(command) ?? [];
    queue.push(new SyncFolderError(code, message));
    this.failures.set(command, queue);
  }

  /** `before`: times out without writing. `after`: the publish commits, then the caller times out. */
  timeoutNextPublish(when: "before" | "after"): void {
    this.publishTimeout = when;
  }

  filesOf(folderDir: string): string[] {
    return [...(this.folders.get(normalize(folderDir))?.files.keys() ?? [])].sort();
  }

  read(folderDir: string, path: string): Uint8Array | string | undefined {
    return this.folders.get(normalize(folderDir))?.files.get(path);
  }

  write(folderDir: string, path: string, content: Uint8Array | string): void {
    this.folder(folderDir).files.set(path, content);
  }

  private folder(folderDir: string): Folder {
    const folder = this.folders.get(normalize(folderDir));
    if (!folder) throw new SyncFolderError("folder_not_found", `${folderDir} does not exist`);
    return folder;
  }

  private syncDir(role: SyncFolderRole, environment: string): string {
    void role;
    return environment === "development" ? "sync-dev" : "sync";
  }

  private enter(command: Command, folderDir: string, role: SyncFolderRole, detail?: object): void {
    this.calls.push({ command, folderDir, role, ...(detail ? { detail: { ...detail } } : {}) });
    const next = this.failures.get(command)?.shift();
    if (next) throw next;
  }

  private checked(folderDir: string, role: SyncFolderRole): Folder {
    const folder = this.folder(folderDir);
    if (folder.role !== role) {
      throw new SyncFolderError(
        "folder_not_prepared",
        `${folderDir} has not been prepared as the ${role} folder`,
      );
    }
    return folder;
  }

  private manifestOf(folder: Folder, environment: string, deviceId: string) {
    const raw = folder.files.get(
      `${this.syncDir("gtd", environment)}/${dirName(deviceId)}/manifest.json`,
    );
    return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  readonly api: FolderApi = {
    prepareSyncFolder: async (target, otherFolderDir): Promise<PreparedSyncFolder> => {
      this.enter("prepare", target.folderDir, target.role, { otherFolderDir });
      const folder = this.folder(target.folderDir);
      const root = normalize(target.folderDir);
      if (folder.role !== null && folder.role !== target.role) {
        throw new SyncFolderError("role_mismatch", `${root} is already the ${folder.role} folder`);
      }
      if (
        target.role === "gtd" &&
        [...folder.files.keys()].some((path) => /^backups(-dev)?\//.test(path))
      ) {
        throw new SyncFolderError("role_mismatch", `${root} looks like a backup folder`);
      }
      if (otherFolderDir) {
        const other = normalize(otherFolderDir);
        if (isInside(root, other) || isInside(other, root)) {
          throw new SyncFolderError("nested_folder", `${root} and ${other} are nested`);
        }
      }
      folder.role = target.role;
      const syncDir = `${root}/${this.syncDir(target.role, target.environment)}`;
      return { syncDir, role: target.role };
    },

    publishSyncBundle: async (input): Promise<PublishedSyncBundle> => {
      this.enter("publish", input.folderDir, input.role, { domain: input.domain });
      const folder = this.checked(input.folderDir, input.role);
      if (!ROLE_DOMAINS[input.role].includes(input.domain)) {
        throw new SyncFolderError(
          "domain_not_allowed",
          `${input.domain} may not be written to the ${input.role} folder`,
        );
      }
      if (input.bundle.length > SYNC_MAX_BUNDLE_BYTES) {
        throw new SyncFolderError("too_large", "bundle over the cap");
      }
      if (input.manifest.deviceId !== input.deviceId) {
        throw new SyncFolderError("device_id_invalid", "manifest deviceId differs");
      }
      if (this.publishTimeout === "before") {
        this.publishTimeout = null;
        throw new SyncFolderError("timeout", "publish timed out");
      }
      const base = `${this.syncDir(input.role, input.environment)}/${dirName(input.deviceId)}`;
      const previous = this.manifestOf(folder, input.environment, input.deviceId);
      const previousDomains = (previous?.domains ?? {}) as Record<string, { generation: number }>;
      const generation = (previousDomains[input.domain]?.generation ?? 0) + 1;
      const file = `${input.domain}-${generation}.bundle`;
      folder.files.set(`${base}/${file}`, new Uint8Array(input.bundle));
      const entry = {
        generation,
        file,
        sha256: sha256Of(input.bundle),
        bytes: input.bundle.length,
        rows: input.rows,
      };
      const { domains: _ignored, ...rest } = input.manifest;
      void _ignored;
      folder.files.set(
        `${base}/manifest.json`,
        JSON.stringify({ ...rest, domains: { ...previousDomains, [input.domain]: entry } }),
      );
      if (this.publishTimeout === "after") {
        this.publishTimeout = null;
        throw new SyncFolderError("timeout", "publish timed out after committing");
      }
      return { generation, file, sha256: entry.sha256, bytes: entry.bytes, warnings: [] };
    },

    listSyncPeers: async (target): Promise<ListedSyncPeers> => {
      this.enter("list", target.folderDir, target.role);
      const folder = this.checked(target.folderDir, target.role);
      const prefix = `${this.syncDir(target.role, target.environment)}/`;
      const peers: Record<string, unknown>[] = [];
      let own: Record<string, unknown> | null = null;
      const ignored: { path: string; reason: string }[] = [];
      for (const [path, content] of [...folder.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const match = /^(dev-[^/]+)\/manifest\.json$/.exec(rest);
        if (!match) {
          if (rest.includes("manifest (")) ignored.push({ path: rest, reason: "conflict_copy" });
          else if (/^[^/]+$/.test(rest)) ignored.push({ path: rest, reason: "not_a_directory" });
          continue;
        }
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(String(content)) as Record<string, unknown>;
        } catch {
          ignored.push({ path: rest, reason: "manifest_not_json" });
          continue;
        }
        const domains = (manifest.domains ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(domains)) {
          if (!ROLE_DOMAINS[target.role].includes(key)) delete domains[key];
        }
        if (manifest.deviceId === target.ownDeviceId) own = manifest;
        else peers.push(manifest);
      }
      return { peers, own, ignored };
    },

    readSyncBundle: async (target): Promise<ReadSyncBundleResult> => {
      this.enter("read", target.folderDir, target.role, { domain: target.domain });
      const folder = this.checked(target.folderDir, target.role);
      if (!ROLE_DOMAINS[target.role].includes(target.domain)) {
        throw new SyncFolderError("domain_not_allowed", `${target.domain} is not read here`);
      }
      const manifest = this.manifestOf(folder, target.environment, target.peerDeviceId);
      const entry = (manifest?.domains as Record<string, Record<string, unknown>> | undefined)?.[
        target.domain
      ];
      if (!entry) return { status: "notReady", reason: "domain_missing" };
      const base = `${this.syncDir(target.role, target.environment)}/${dirName(target.peerDeviceId)}`;
      const content = folder.files.get(`${base}/${String(entry.file)}`);
      if (!(content instanceof Uint8Array)) return { status: "notReady", reason: "file_missing" };
      if (content.length !== entry.bytes) return { status: "notReady", reason: "size_mismatch" };
      if (sha256Of(content) !== entry.sha256)
        return { status: "notReady", reason: "hash_mismatch" };
      return {
        status: "ok",
        bytes: new Uint8Array(content),
        generation: entry.generation as number,
        sha256: entry.sha256 as string,
        rows: entry.rows as number,
      };
    },
  };
}

export const createFakeFolderHost = (): FakeFolderHost => new FakeFolderHost();
