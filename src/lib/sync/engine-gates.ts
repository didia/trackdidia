import type { SyncIssue } from "./engine-types";
import { hlcSkewMs, HLC_SKEW_WARNING_MS, isHlcAheadOfLocalTime, parseHlc } from "./hlc";
import { domainsPublishable, domainsReadable, isDeviceProfile } from "./profile";
import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import { SYNC_FORMAT_VERSION } from "./change-set";
import { isValidDeviceId, type SyncPeerSummary } from "./status";
import type { PeerDomainEntry, PeerManifest } from "./transport";
import type { DeviceProfile } from "./profile";

/**
 * The gates a peer's manifest passes BEFORE any of its bundles is read or applied (spec: "Schema and
 * version skew", "Deletes", "Failure modes"). Pure: the engine feeds in the manifest, what it
 * remembers of the peer and the time, and gets back a verdict. No I/O, no repository.
 */

const DAY_MS = 24 * 60 * 60_000;

/** A peer that last wrote, or a peer this laptop last pulled from, longer ago than this is stale. */
export const STALE_PEER_MS = 90 * DAY_MS;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type StaleReason =
  /** The peer's own `writtenAt` is older than 90 days: its tombstones may be long pruned. */
  | "peer_written_long_ago"
  /** This laptop has not pulled from the peer for 90 days: ours may have been pruned. */
  | "not_pulled_recently";

export interface RefusedDomain {
  /** The key as the manifest wrote it. */
  domain: string;
  issue: SyncIssue;
}

export interface AllowedDomain {
  domain: SyncDomain;
  entry: PeerDomainEntry;
}

export type ManifestVerdict =
  | { kind: "invalid"; issue: SyncIssue }
  | { kind: "format_unsupported"; issue: SyncIssue }
  | { kind: "update_required"; issue: SyncIssue }
  | { kind: "stale"; reason: StaleReason; issue: SyncIssue }
  | {
      kind: "ok";
      /** In registry order, so gtd is applied before personal before finance. */
      allowed: AllowedDomain[];
      refused: RefusedDomain[];
      warnings: SyncIssue[];
      clockSkewMs: number | null;
    };

export interface ManifestGateInput {
  manifest: unknown;
  transportId: string;
  /** What the transport declares. */
  transportDomains: readonly SyncDomain[];
  /** This device's profile. */
  profile: DeviceProfile;
  nowMs: number;
  /** Highest migration id applied here. */
  localSchemaVersion: number;
  /** What `sync_peers` remembers of this peer, if anything. */
  stored: SyncPeerSummary | undefined;
  /** The user reviewed this stale peer and chose to merge it. */
  approvedStale: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `null` when the entry is usable, otherwise what is wrong with it. */
export const entryProblem = (entry: unknown): string | null => {
  if (!isRecord(entry)) return "expected an object";
  if (!isCount(entry.generation) || entry.generation < 1)
    return "generation is not a positive integer";
  if (typeof entry.file !== "string" || entry.file.length === 0) return "file is not a name";
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    return "sha256 is not a lowercase hex SHA-256";
  }
  if (!isCount(entry.bytes)) return "bytes is not a count";
  if (!isCount(entry.rows)) return "rows is not a count";
  return null;
};

/** `null` when the manifest has the shape the engine relies on, otherwise what is wrong. */
export const manifestProblem = (manifest: unknown): string | null => {
  if (!isRecord(manifest)) return "expected an object";
  if (!isValidDeviceId(manifest.deviceId)) return "deviceId is not a device id";
  if (typeof manifest.deviceName !== "string") return "deviceName is not text";
  if (typeof manifest.appVersion !== "string") return "appVersion is not text";
  if (!isCount(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    return "schemaVersion is not a positive integer";
  }
  if (typeof manifest.writtenAt !== "string" || Number.isNaN(Date.parse(manifest.writtenAt))) {
    return "writtenAt is not a timestamp";
  }
  if (parseHlc(manifest.hlcHigh) === null) return "hlcHigh is not a clock";
  if (!isDeviceProfile(manifest.profile)) return "profile is not a device profile";
  if (!isRecord(manifest.domains)) return "domains is not an object";
  if (typeof manifest.calendarSyncEnabled !== "boolean")
    return "calendarSyncEnabled is not a boolean";
  return null;
};

const nameOf = (manifest: unknown): string => {
  if (isRecord(manifest)) {
    if (typeof manifest.deviceName === "string" && manifest.deviceName.length > 0) {
      return manifest.deviceName;
    }
    if (typeof manifest.deviceId === "string") return manifest.deviceId;
  }
  return "an unknown device";
};

const idOf = (manifest: unknown): string | undefined =>
  isRecord(manifest) && typeof manifest.deviceId === "string" ? manifest.deviceId : undefined;

/**
 * Decides what to do with a peer's manifest. Order matters and is part of the contract: a manifest
 * that is malformed or of an unknown format is never interpreted further; a newer schema is refused
 * before staleness is considered (updating the app is the fix there); a stale peer is refused unless
 * the user approved it. Only then are the domain entries filtered.
 */
export const evaluateManifest = (input: ManifestGateInput): ManifestVerdict => {
  const { manifest, transportId } = input;
  const peerId = idOf(manifest);
  const peerName = nameOf(manifest);
  const base = { transport: transportId, ...(peerId === undefined ? {} : { peerId }), peerName };

  // The format version first: an unknown format's other fields cannot be trusted to mean anything.
  if (isRecord(manifest) && manifest.formatVersion !== SYNC_FORMAT_VERSION) {
    return {
      kind: "format_unsupported",
      issue: {
        ...base,
        severity: "warning",
        code: "format_version_unsupported",
        message: `${peerName} uses sync format ${String(manifest.formatVersion)}, which this version of TrackDidia does not understand; update TrackDidia to sync with it`,
        detail: String(manifest.formatVersion),
      },
    };
  }
  const problem = manifestProblem(manifest);
  if (problem !== null) {
    return {
      kind: "invalid",
      issue: {
        ...base,
        severity: "error",
        code: "manifest_invalid",
        message: `The manifest of ${peerName} is not valid (${problem}); ignored`,
        detail: problem,
      },
    };
  }
  const peer = manifest as PeerManifest;

  if (peer.schemaVersion > input.localSchemaVersion) {
    return {
      kind: "update_required",
      issue: {
        ...base,
        severity: "warning",
        code: "update_required",
        message: `Update TrackDidia to sync with ${peerName} (it uses a newer database version: ${peer.schemaVersion}, this laptop has ${input.localSchemaVersion})`,
        detail: String(peer.schemaVersion),
      },
    };
  }

  if (!input.approvedStale) {
    const writtenMs = Date.parse(peer.writtenAt);
    const lastSynced =
      input.stored?.lastSyncedAt === null || input.stored?.lastSyncedAt === undefined
        ? null
        : Date.parse(input.stored.lastSyncedAt);
    let reason: StaleReason | null = null;
    if (input.nowMs - writtenMs > STALE_PEER_MS) {
      reason = "peer_written_long_ago";
    } else if (
      lastSynced !== null &&
      !Number.isNaN(lastSynced) &&
      input.nowMs - lastSynced > STALE_PEER_MS
    ) {
      reason = "not_pulled_recently";
    }
    if (reason !== null) {
      return {
        kind: "stale",
        reason,
        issue: {
          ...base,
          severity: "warning",
          code: "stale_peer",
          message:
            reason === "peer_written_long_ago"
              ? `${peerName} last synced more than 90 days ago: it has been offline too long to merge safely. Review before merging`
              : `This laptop has not synced with ${peerName} for more than 90 days: it has been offline too long to merge safely. Review before merging`,
          detail: reason,
        },
      };
    }
  }

  const warnings: SyncIssue[] = [];
  let clockSkewMs: number | null = null;
  if (isHlcAheadOfLocalTime(peer.hlcHigh, input.nowMs, HLC_SKEW_WARNING_MS)) {
    clockSkewMs = hlcSkewMs(peer.hlcHigh, input.nowMs);
    warnings.push({
      ...base,
      severity: "warning",
      code: "clock_skew",
      message: `The clock of ${peerName} is about ${Math.round((clockSkewMs ?? 0) / 60_000)} minutes ahead of this laptop; check the date and time on both`,
      detail: String(clockSkewMs),
    });
  }

  const readable = domainsReadable(input.profile);
  const writtenByPeerProfile = domainsPublishable(peer.profile);
  const allowed: AllowedDomain[] = [];
  const refused: RefusedDomain[] = [];
  const refuse = (domain: string, why: string, code: "domain_not_allowed" | "manifest_invalid") =>
    refused.push({
      domain,
      issue: {
        ...base,
        severity: "error",
        code,
        domain,
        message:
          code === "domain_not_allowed"
            ? `${peerName} offers the "${domain}" domain, which is ${why}; it is never applied`
            : `${peerName} lists "${domain}" with an invalid entry (${why}); ignored`,
        detail: why,
      },
    });

  for (const key of Object.keys(peer.domains)) {
    const entry = (peer.domains as Record<string, unknown>)[key];
    if (!(SYNC_DOMAINS as readonly string[]).includes(key)) {
      refuse(key, "not a sync domain", "domain_not_allowed");
    } else if (!input.transportDomains.includes(key as SyncDomain)) {
      refuse(key, `not carried by ${transportId}`, "domain_not_allowed");
    } else if (!readable.includes(key as SyncDomain)) {
      refuse(key, `not allowed on a ${input.profile} device`, "domain_not_allowed");
    } else if (!writtenByPeerProfile.includes(key as SyncDomain)) {
      refuse(key, `not allowed for a ${peer.profile} device to publish`, "domain_not_allowed");
    } else {
      const bad = entryProblem(entry);
      if (bad !== null) {
        refuse(key, bad, "manifest_invalid");
      } else {
        allowed.push({ domain: key as SyncDomain, entry: entry as PeerDomainEntry });
      }
    }
  }
  allowed.sort((a, b) => SYNC_DOMAINS.indexOf(a.domain) - SYNC_DOMAINS.indexOf(b.domain));
  return { kind: "ok", allowed, refused, warnings, clockSkewMs };
};
