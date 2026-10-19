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
    peers: peerRows.map(syncPeerFromRow),
  };
};
