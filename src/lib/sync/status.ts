import type { SyncChangeSet } from "./change-set";
import { SYNC_DOMAINS } from "./registry";

/**
 * Types and pure helpers behind `AppRepository.getSyncStatus` / `ensureSyncIdentity`. No I/O: the
 * SQLite repository feeds it raw rows, tests feed it garbage.
 */

/** This installation's identity as stored in `sync_identity`. */
export interface SyncIdentity {
  deviceId: string;
  deviceName: string;
}

/** What `ensureSyncIdentity` did. At most one of `created` / `repaired` is true. */
export interface SyncIdentityResult extends SyncIdentity {
  /** The identity row did not exist and was created. */
  created: boolean;
  /**
   * The row existed with a different device id (a restored or cloned database) and was rewritten to
   * the id from the device-id file. HLC state and counters were kept.
   */
  repaired: boolean;
}

export interface SyncPeerSummary {
  peerId: string;
  peerName: string;
  /** Last manifest read from this peer, or `null` when absent or unreadable. */
  lastManifest: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  /** Content hash of the last bundle applied per domain; malformed entries are dropped. */
  lastAppliedShaByDomain: Record<string, string>;
}

/** What `AppRepository.recordSyncPeerApplied` stores about one peer (see the repository contract). */
export interface SyncPeerAppliedInput {
  /** `dev:<uuid v4>` of the peer. */
  peerId: string;
  peerName: string;
  /** The manifest the applied bundles were announced in, as read. */
  manifest: Record<string, unknown> | null;
  /** Lowercase hex SHA-256 of the bundle applied, by domain. Merged into the stored map. */
  appliedShaByDomain: Record<string, string>;
  /** ISO timestamp of the contact, or `null` to keep the one already stored. */
  syncedAt: string | null;
}

/** The committed publish counters, read through the writer queue (`readSyncPublishCounters`). */
export interface SyncPublishCounters {
  changeCounter: number;
  lastPublishCounter: number;
}

/** A change set together with the committed `change_counter` it covers (`readSyncSnapshot`). */
export interface SyncSnapshot {
  changeSet: SyncChangeSet;
  /**
   * `change_counter` as read in the SAME writer slot as the change set: committed, and covered by it.
   * Every change counted by this value is in `changeSet`; a change committed later is not.
   */
  changeCounter: number;
}

/** The result of `AppRepository.markSyncPublished`. */
export interface SyncPublishMark {
  /** `last_publish_counter` after the call. */
  lastPublishCounter: number;
  /** Whether the call moved it forward. */
  advanced: boolean;
}

export type SyncStatus =
  /** Browser preview and the startup fallback: nothing is persisted, so nothing can sync. */
  | { supported: false }
  | {
      supported: true;
      /** `null` until `ensureSyncIdentity` has run on this database. */
      identity: SyncIdentity | null;
      changeCounter: number;
      lastPublishCounter: number;
      /** Changes captured since the last publish (`changeCounter - lastPublishCounter`, floored at 0). */
      pendingChanges: number;
      /**
       * True while change capture is installed on this database (`enableSyncCapture` ran; there is
       * no repository method to turn it off yet). While false, local edits are not tracked at all.
       */
      captureEnabled: boolean;
      peers: SyncPeerSummary[];
    };

export const SYNC_UNAVAILABLE_IN_PREVIEW_MESSAGE =
  "Multi-device sync is unavailable in browser preview: it needs the desktop app's persistent storage.";

// Same shape the native host accepts (`dev:` + lowercase hyphenated UUID v4); see
// `is_valid_device_id` in src-tauri/src/device_id.rs.
const DEVICE_ID_PATTERN =
  /^dev:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isValidDeviceId = (value: unknown): value is string =>
  typeof value === "string" && DEVICE_ID_PATTERN.test(value);

export const assertValidDeviceId = (value: unknown): string => {
  if (!isValidDeviceId(value)) {
    throw new Error("Invalid device id: expected 'dev:' followed by a lowercase UUID v4");
  }
  return value;
};

export const DEVICE_NAME_MAX_LENGTH = 100;

/** Trims a device name and rejects non-strings and over-long names. May return an empty string. */
export const normalizeDeviceName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Invalid device name: expected a string");
  }
  const name = value.trim();
  if (name.length > DEVICE_NAME_MAX_LENGTH) {
    throw new Error(`Invalid device name: at most ${DEVICE_NAME_MAX_LENGTH} characters`);
  }
  return name;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** A non-negative safe integer, or 0 for anything else (null, NaN, negative, text). */
export const toCounter = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export interface SyncPeerRow {
  peer_id: string;
  peer_name: string;
  last_manifest_json: string | null;
  last_synced_at: string | null;
  last_applied_sha_by_domain: string | null;
}

/** Maps a `sync_peers` row defensively: a corrupt JSON column degrades to empty, never throws. */
export const syncPeerFromRow = (row: SyncPeerRow): SyncPeerSummary => {
  const manifest = parseJson(row.last_manifest_json);
  const shas = parseJson(row.last_applied_sha_by_domain);
  const lastAppliedShaByDomain: Record<string, string> = {};
  if (isPlainRecord(shas)) {
    for (const [domain, sha] of Object.entries(shas)) {
      if (typeof sha === "string") lastAppliedShaByDomain[domain] = sha;
    }
  }
  return {
    peerId: String(row.peer_id),
    peerName: typeof row.peer_name === "string" ? row.peer_name : "",
    lastManifest: isPlainRecord(manifest) ? manifest : null,
    lastSyncedAt: typeof row.last_synced_at === "string" ? row.last_synced_at : null,
    lastAppliedShaByDomain,
  };
};

export interface SyncIdentityRow {
  device_id: string;
  device_name: string;
  change_counter: number;
  last_publish_counter: number;
}

export const buildSupportedSyncStatus = (
  identityRow: SyncIdentityRow | null,
  peerRows: SyncPeerRow[],
  captureEnabled = false,
): Extract<SyncStatus, { supported: true }> => {
  const changeCounter = toCounter(identityRow?.change_counter);
  const lastPublishCounter = toCounter(identityRow?.last_publish_counter);
  return {
    supported: true,
    identity: identityRow
      ? { deviceId: String(identityRow.device_id), deviceName: String(identityRow.device_name) }
      : null,
    changeCounter,
    lastPublishCounter,
    pendingChanges: Math.max(0, changeCounter - lastPublishCounter),
    captureEnabled,
    peers: peerRows.map(syncPeerFromRow),
  };
};

/** A validated {@link SyncPeerAppliedInput}, ready to bind: the manifest is already JSON text. */
export interface NormalizedPeerApplied {
  peerId: string;
  peerName: string;
  manifestJson: string | null;
  appliedShaByDomain: Record<string, string>;
  syncedAt: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Rejects an invalid peer id, an unknown domain, a malformed hash or an unusable timestamp. */
export const normalizePeerApplied = (input: SyncPeerAppliedInput): NormalizedPeerApplied => {
  const peerId = assertValidDeviceId(input?.peerId);
  const name = typeof input.peerName === "string" ? input.peerName.trim() : "";
  const appliedShaByDomain: Record<string, string> = {};
  if (!isPlainRecord(input.appliedShaByDomain)) {
    throw new Error("Invalid applied hashes: expected an object keyed by domain");
  }
  for (const [domain, sha] of Object.entries(input.appliedShaByDomain)) {
    if (!(SYNC_DOMAINS as readonly string[]).includes(domain)) {
      throw new Error(`Invalid applied hashes: unknown sync domain "${domain}"`);
    }
    if (typeof sha !== "string" || !SHA256_HEX.test(sha)) {
      throw new Error(`Invalid applied hashes: "${domain}" is not a lowercase hex SHA-256`);
    }
    appliedShaByDomain[domain] = sha;
  }
  if (
    input.syncedAt !== null &&
    (typeof input.syncedAt !== "string" || Number.isNaN(Date.parse(input.syncedAt)))
  ) {
    throw new Error("Invalid sync time: expected an ISO timestamp or null");
  }
  if (input.manifest !== null && !isPlainRecord(input.manifest)) {
    throw new Error("Invalid peer manifest: expected an object or null");
  }
  return {
    peerId,
    peerName: name.length > 0 ? name.slice(0, DEVICE_NAME_MAX_LENGTH) : peerId,
    manifestJson: input.manifest === null ? null : JSON.stringify(input.manifest),
    appliedShaByDomain,
    syncedAt: input.syncedAt,
  };
};

/** The stored hash map with `incoming` laid over it. A corrupt stored value degrades to empty. */
export const mergeAppliedShas = (
  storedJson: string | null,
  incoming: Record<string, string>,
): Record<string, string> => {
  const merged = syncPeerFromRow({
    peer_id: "",
    peer_name: "",
    last_manifest_json: null,
    last_synced_at: null,
    last_applied_sha_by_domain: storedJson,
  }).lastAppliedShaByDomain;
  return { ...merged, ...incoming };
};

/**
 * The new `last_publish_counter`, or `null` when it must not change: `value` has to be a counter,
 * has to move forward, and may not pass `change_counter` (a value above it was never read from it).
 */
export const nextPublishCounter = (
  value: unknown,
  changeCounter: number,
  lastPublishCounter: number,
): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid change counter: expected a non-negative integer");
  }
  return value > lastPublishCounter && value <= changeCounter ? value : null;
};
