import { describe, expect, it } from "vitest";
import { SYNC_FORMAT_VERSION } from "./change-set";
import { evaluateManifest, type ManifestGateInput, STALE_PEER_MS } from "./engine-gates";
import { encodeHlc } from "./hlc";
import type { PeerManifest } from "./transport";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const PEER = "dev:00000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);

const entry = (generation = 1) => ({
  generation,
  file: `gtd-${generation}.bundle`,
  sha256: SHA,
  bytes: 10,
  rows: 1,
});

const manifest = (overrides: Partial<PeerManifest> = {}): PeerManifest => ({
  formatVersion: SYNC_FORMAT_VERSION,
  deviceId: PEER,
  deviceName: "Maison",
  appVersion: "0.2.0",
  schemaVersion: 43,
  writtenAt: new Date(NOW - 60_000).toISOString(),
  hlcHigh: encodeHlc(NOW - 60_000, 0, PEER),
  profile: "personal",
  domains: { gtd: entry() },
  calendarSyncEnabled: false,
  ...overrides,
});

const gate = (overrides: Partial<ManifestGateInput> = {}) =>
  evaluateManifest({
    manifest: manifest(),
    transportId: "folder:gtd",
    transportDomains: ["gtd"],
    profile: "personal",
    nowMs: NOW,
    localSchemaVersion: 43,
    stored: undefined,
    approvedStale: false,
    ...overrides,
  });

describe("manifest gates", () => {
  it("lets a healthy manifest through with its domains in registry order", () => {
    const verdict = gate({
      manifest: manifest({
        domains: { finance: entry(), personal: entry(), gtd: entry() },
      }),
      transportDomains: ["gtd", "personal", "finance"],
    });
    expect(verdict.kind).toBe("ok");
    if (verdict.kind !== "ok") return;
    expect(verdict.allowed.map((item) => item.domain)).toEqual(["gtd", "personal", "finance"]);
    expect(verdict.refused).toEqual([]);
    expect(verdict.warnings).toEqual([]);
  });

  it("does not interpret a manifest of an unknown format", () => {
    expect(gate({ manifest: manifest({ formatVersion: 2 }) })).toMatchObject({
      kind: "format_unsupported",
      issue: { code: "format_version_unsupported", severity: "warning", peerName: "Maison" },
    });
    expect(gate({ manifest: { ...manifest(), formatVersion: undefined } }).kind).toBe(
      "format_unsupported",
    );
  });

  it("rejects malformed manifests with the problem named", () => {
    for (const bad of [
      null,
      "text",
      [],
      { ...manifest(), deviceId: "not-a-device" },
      { ...manifest(), schemaVersion: 0 },
      { ...manifest(), schemaVersion: 1.5 },
      { ...manifest(), writtenAt: "yesterday" },
      { ...manifest(), hlcHigh: "nope" },
      { ...manifest(), profile: "admin" },
      { ...manifest(), domains: [] },
      { ...manifest(), calendarSyncEnabled: "no" },
    ]) {
      const verdict = gate({ manifest: bad });
      expect(verdict.kind, JSON.stringify(bad)).toBe("invalid");
      if (verdict.kind === "invalid") expect(verdict.issue.code).toBe("manifest_invalid");
    }
  });

  it("a newer schema is refused before anything else, an equal or older one is not", () => {
    expect(gate({ manifest: manifest({ schemaVersion: 44 }) })).toMatchObject({
      kind: "update_required",
      issue: { code: "update_required" },
    });
    expect(
      gate({ manifest: manifest({ schemaVersion: 44, writtenAt: "2020-01-01T00:00:00Z" }) }).kind,
    ).toBe("update_required");
    expect(gate({ manifest: manifest({ schemaVersion: 43 }) }).kind).toBe("ok");
    expect(gate({ manifest: manifest({ schemaVersion: 7 }) }).kind).toBe("ok");
  });

  it("stale: written more than 90 days ago, or not pulled for more than 90 days", () => {
    const old = (ms: number) => new Date(NOW - ms).toISOString();
    expect(gate({ manifest: manifest({ writtenAt: old(STALE_PEER_MS) }) }).kind).toBe("ok");
    expect(gate({ manifest: manifest({ writtenAt: old(STALE_PEER_MS + 1) }) })).toMatchObject({
      kind: "stale",
      reason: "peer_written_long_ago",
    });

    const stored = (lastSyncedAt: string | null) => ({
      peerId: PEER,
      peerName: "Maison",
      lastManifest: null,
      lastSyncedAt,
      lastAppliedShaByDomain: {},
    });
    expect(gate({ stored: stored(old(STALE_PEER_MS)) }).kind).toBe("ok");
    expect(gate({ stored: stored(old(STALE_PEER_MS + 1)) })).toMatchObject({
      kind: "stale",
      reason: "not_pulled_recently",
    });
    // Never synced, or an unreadable stamp: only the peer's own age counts.
    expect(gate({ stored: stored(null) }).kind).toBe("ok");
    expect(gate({ stored: stored("garbage") }).kind).toBe("ok");
    // The user reviewed it.
    expect(
      gate({
        manifest: manifest({ writtenAt: old(STALE_PEER_MS + DAY) }),
        approvedStale: true,
      }).kind,
    ).toBe("ok");
  });

  it("warns, but does not refuse, a peer more than five minutes ahead", () => {
    const ahead = (ms: number) => manifest({ hlcHigh: encodeHlc(NOW + ms, 0, PEER) });
    expect(gate({ manifest: ahead(5 * 60_000) })).toMatchObject({ kind: "ok", warnings: [] });
    const verdict = gate({ manifest: ahead(5 * 60_000 + 1) });
    expect(verdict).toMatchObject({ kind: "ok", clockSkewMs: 5 * 60_000 + 1 });
    if (verdict.kind === "ok") expect(verdict.warnings[0]?.code).toBe("clock_skew");
  });

  it("refuses every domain the transport, this profile or the peer's profile does not allow", () => {
    const verdict = gate({
      manifest: manifest({
        profile: "work",
        domains: { gtd: entry(), personal: entry(), finance: entry(), calendar: entry() },
      }),
      transportDomains: ["gtd", "personal"],
      profile: "personal",
    });
    expect(verdict.kind).toBe("ok");
    if (verdict.kind !== "ok") return;
    expect(verdict.allowed.map((item) => item.domain)).toEqual(["gtd"]);
    expect(verdict.refused.map((item) => [item.domain, item.issue.code])).toEqual([
      ["personal", "domain_not_allowed"], // a work peer may not publish it
      ["finance", "domain_not_allowed"], // not carried by this transport
      ["calendar", "domain_not_allowed"], // not a sync domain
    ]);
    for (const refused of verdict.refused) {
      expect(refused.issue).toMatchObject({ severity: "error", peerName: "Maison" });
    }

    // A work device refuses a personal domain even from a transport that carries it.
    const work = gate({
      manifest: manifest({ domains: { gtd: entry(), personal: entry() } }),
      transportDomains: ["gtd", "personal"],
      profile: "work",
    });
    expect(work.kind === "ok" && work.allowed.map((item) => item.domain)).toEqual(["gtd"]);
    expect(work.kind === "ok" && work.refused.map((item) => item.domain)).toEqual(["personal"]);
  });

  it("refuses a domain entry that is malformed, keeping the others", () => {
    const verdict = gate({
      manifest: manifest({
        domains: { gtd: { ...entry(), sha256: "short" }, personal: entry() },
      }),
      transportDomains: ["gtd", "personal"],
    });
    expect(verdict.kind === "ok" && verdict.refused.map((r) => [r.domain, r.issue.code])).toEqual([
      ["gtd", "manifest_invalid"],
    ]);
    expect(verdict.kind === "ok" && verdict.allowed.map((item) => item.domain)).toEqual([
      "personal",
    ]);
  });
});

const DAY = 24 * 60 * 60_000;
