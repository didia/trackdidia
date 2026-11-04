import { describe, expect, it } from "vitest";
import { CALENDAR_PEER_MAX_AGE_MS, calendarPeerWarning } from "./calendar-peer-guard";
import { encodeHlc } from "./hlc";
import type { PeerManifest } from "./transport";

const now = Date.parse("2026-11-03T12:00:00Z");
const peer: PeerManifest = {
  formatVersion: 1,
  deviceId: "dev:00000000-0000-4000-8000-000000000001",
  deviceName: "Maison",
  appVersion: "1",
  schemaVersion: 42,
  writtenAt: new Date(now).toISOString(),
  hlcHigh: encodeHlc(now, 0, "dev:00000000-0000-4000-8000-000000000001"),
  profile: "personal",
  domains: {},
  calendarSyncEnabled: false,
};

describe("calendar peer guard", () => {
  it("permits a fresh peer with calendar disabled", () => {
    expect(calendarPeerWarning([peer], [], now)).toBeNull();
  });
  it("permits an idle peer whose calendar-off manifest is days old", () => {
    for (const days of [2, 10, 29]) {
      const writtenAt = new Date(now - days * 24 * 3600_000).toISOString();
      expect(calendarPeerWarning([{ ...peer, writtenAt }], [], now)).toBeNull();
    }
  });
  it("blocks peers older than the heartbeat window or dated in the future", () => {
    const stale = new Date(now - CALENDAR_PEER_MAX_AGE_MS - 1000).toISOString();
    expect(calendarPeerWarning([{ ...peer, writtenAt: stale }], [], now)).toContain("Maison");
    const future = new Date(now + 10 * 60_000).toISOString();
    expect(calendarPeerWarning([{ ...peer, writtenAt: future }], [], now)).toContain("Maison");
  });
  it("blocks enabled, invalid and missing peers by name", () => {
    expect(calendarPeerWarning([{ ...peer, calendarSyncEnabled: true }], [], now)).toContain(
      "Maison",
    );
    expect(
      calendarPeerWarning(
        [{ ...peer, calendarSyncEnabled: undefined } as unknown as PeerManifest],
        [],
        now,
      ),
    ).toContain("Maison");
    expect(calendarPeerWarning([], [{ peerId: peer.deviceId, peerName: "Maison" }], now)).toContain(
      "Maison",
    );
  });
});
