import { invoke } from "@tauri-apps/api/core";

/**
 * Thin typed wrappers over the four native folder commands in `src-tauri/src/sync_folder.rs`
 * (`sync_prepare_folder`, `sync_publish`, `sync_list_peers`, `sync_read_bundle`). No policy lives
 * here: the folder transport (a later slice) decides which error is "unreachable", which is
 * "timeout" and which is "not ready". Rust treats a bundle as opaque bytes; they cross the IPC
 * boundary as base64 text, so memory is roughly 3-4x the bundle size at the peak (the base64 string,
 * the decoded bytes, and whatever the caller builds from them). Rust refuses bundles over
 * {@link SYNC_MAX_BUNDLE_BYTES}.
 */

export type SyncFolderRole = "gtd" | "personal";
export type SyncFolderEnvironment = "development" | "production";

/** Mirrors `MAX_BUNDLE_BYTES` in `sync_folder.rs`. */
export const SYNC_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export type SyncFolderErrorCode =
  | "folder_not_found"
  | "folder_not_prepared"
  | "role_mismatch"
  | "nested_folder"
  | "domain_not_allowed"
  | "device_id_invalid"
  | "too_large"
  | "timeout"
  | "io"
  | "invalid_argument"
  /** The host rejected with something that is not a `{ code, message }` object. */
  | "unknown";

const KNOWN_CODES: ReadonlySet<string> = new Set<SyncFolderErrorCode>([
  "folder_not_found",
  "folder_not_prepared",
  "role_mismatch",
  "nested_folder",
  "domain_not_allowed",
  "device_id_invalid",
  "too_large",
  "timeout",
  "io",
  "invalid_argument",
]);

/** A rejection from a folder command, with the host's typed code. */
export class SyncFolderError extends Error {
  readonly code: SyncFolderErrorCode;

  constructor(code: SyncFolderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncFolderError";
    this.code = code;
  }
}

/** Maps whatever `invoke` rejected with to a {@link SyncFolderError}. */
export const toSyncFolderError = (error: unknown): SyncFolderError => {
  if (error instanceof SyncFolderError) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && KNOWN_CODES.has(code)) {
      return new SyncFolderError(
        code as SyncFolderErrorCode,
        typeof message === "string" ? message : code,
        { cause: error },
      );
    }
  }
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "sync_folder_command_failed";
  return new SyncFolderError("unknown", text, { cause: error });
};

const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toSyncFolderError(error);
  }
};

const BASE64_CHUNK = 0x8000;

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
};

export const base64ToBytes = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** The configured folder every command is scoped to. Never a path inside it. */
export interface SyncFolderTarget {
  /** The user-chosen folder root (the shared GTD folder, or the personal/backup folder). */
  folderDir: string;
  role: SyncFolderRole;
  environment: SyncFolderEnvironment;
}

export interface PreparedSyncFolder {
  /** Absolute `<root>/sync` (or `sync-dev`), created if missing. */
  syncDir: string;
  role: SyncFolderRole;
}

/**
 * Configuration-time check: writes or verifies the folder's role marker and creates the sync
 * directory. Rejects with `role_mismatch` (other role's marker, or a GTD folder holding `backups/`),
 * `nested_folder`, or `folder_not_found` (an unmounted Drive path is never created).
 * `otherFolderDir` is the other role's configured folder, when set, for the nesting check.
 */
export const prepareSyncFolder = (
  target: SyncFolderTarget,
  otherFolderDir?: string,
): Promise<PreparedSyncFolder> =>
  call<PreparedSyncFolder>("sync_prepare_folder", {
    folderDir: target.folderDir,
    role: target.role,
    environment: target.environment,
    otherFolderDir: otherFolderDir ?? null,
  });

export interface PublishSyncBundleInput extends SyncFolderTarget {
  deviceId: string;
  domain: string;
  bundle: Uint8Array;
  rows: number;
  /**
   * The device-level manifest fields (`formatVersion`, `deviceId`, `deviceName`, ...). `deviceId`
   * must equal `deviceId`. `domains` is ignored: the host owns every domain entry and merges this
   * publish into the device's existing manifest.
   */
  manifest: Record<string, unknown>;
}

export interface PublishedSyncBundle {
  /** Chosen by the host: the previous generation of this domain + 1. */
  generation: number;
  file: string;
  sha256: string;
  bytes: number;
  /** Non-fatal problems (directory flush unsupported, an old generation that would not delete). */
  warnings: string[];
}

export const publishSyncBundle = (input: PublishSyncBundleInput): Promise<PublishedSyncBundle> =>
  call<PublishedSyncBundle>("sync_publish", {
    folderDir: input.folderDir,
    role: input.role,
    environment: input.environment,
    deviceId: input.deviceId,
    domain: input.domain,
    bundleBase64: bytesToBase64(input.bundle),
    rows: input.rows,
    manifestJson: JSON.stringify(input.manifest),
  });

export interface IgnoredSyncEntry {
  /** Relative to the sync directory, e.g. `dev-<uuid>/manifest (1).json` (device directories are `dev-<uuid>`). */
  path: string;
  reason: string;
}

export interface ListedSyncPeers {
  /**
   * Every other device's validated manifest, sorted by device id. UNTRUSTED beyond what the host
   * checked (device id equals its directory, domains allowed for the role and well formed); the
   * engine still validates the rest.
   */
  peers: Record<string, unknown>[];
  /** This device's own manifest, when it has published to this folder. */
  own: Record<string, unknown> | null;
  ignored: IgnoredSyncEntry[];
}

export const listSyncPeers = (
  target: SyncFolderTarget & { ownDeviceId: string },
): Promise<ListedSyncPeers> =>
  call<ListedSyncPeers>("sync_list_peers", {
    folderDir: target.folderDir,
    role: target.role,
    environment: target.environment,
    ownDeviceId: target.ownDeviceId,
  });

export type ReadSyncBundleResult =
  | {
      status: "ok";
      /** Verified against the peer manifest's `bytes` and `sha256`. */
      bytes: Uint8Array;
      generation: number;
      sha256: string;
      rows: number;
    }
  | { status: "notReady"; reason: string };

interface RawReadResult {
  status: "ok" | "notReady";
  bytesBase64?: string;
  generation?: number;
  sha256?: string;
  rows?: number;
  reason?: string;
}

export const readSyncBundle = async (
  target: SyncFolderTarget & { ownDeviceId: string; peerDeviceId: string; domain: string },
): Promise<ReadSyncBundleResult> => {
  const raw = await call<RawReadResult>("sync_read_bundle", {
    folderDir: target.folderDir,
    role: target.role,
    environment: target.environment,
    ownDeviceId: target.ownDeviceId,
    peerDeviceId: target.peerDeviceId,
    domain: target.domain,
  });
  if (raw.status === "ok" && typeof raw.bytesBase64 === "string") {
    return {
      status: "ok",
      bytes: base64ToBytes(raw.bytesBase64),
      generation: raw.generation ?? 0,
      sha256: raw.sha256 ?? "",
      rows: raw.rows ?? 0,
    };
  }
  return { status: "notReady", reason: raw.reason ?? "unknown" };
};
