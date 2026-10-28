import { describe, expect, it } from "vitest";
import {
  assertValidDeviceId,
  buildSupportedSyncStatus,
  isValidDeviceId,
  normalizeDeviceName,
  syncPeerFromRow,
  toCounter,
} from "./status";

const GOOD = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";

describe("device id validation (mirrors the native host)", () => {
  it("accepts dev: + a lowercase UUID v4", () => {
    expect(isValidDeviceId(GOOD)).toBe(true);
    expect(assertValidDeviceId(GOOD)).toBe(GOOD);
    for (const variant of ["8", "9", "a", "b"]) {
      expect(isValidDeviceId(`dev:0b9c7c1e-6a3f-4b8e-${variant}d2a-1f2e3d4c5b6a`)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const value of [
      "",
      GOOD.toUpperCase(),
      GOOD.replace("dev:", "device:"),
      GOOD.replace("-4b8e-", "-1b8e-"),
      GOOD.replace("-9d2a-", "-cd2a-"),
      GOOD.slice(0, -1),
      `${GOOD}0`,
      `${GOOD}\n`,
      GOOD.replace("b", "g"),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isValidDeviceId(value)).toBe(false);
      expect(() => assertValidDeviceId(value)).toThrow(/Invalid device id/);
    }
  });
});

describe("normalizeDeviceName", () => {
  it("trims, allows empty, and bounds length", () => {
    expect(normalizeDeviceName("  Perso  ")).toBe("Perso");
    expect(normalizeDeviceName("   ")).toBe("");
    expect(normalizeDeviceName("x".repeat(100))).toHaveLength(100);
    expect(() => normalizeDeviceName("x".repeat(101))).toThrow(/at most 100/);
    expect(() => normalizeDeviceName(5)).toThrow(/expected a string/);
  });
});

describe("toCounter", () => {
  it("keeps non-negative safe integers and zeroes the rest", () => {
    expect(toCounter(7)).toBe(7);
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined]) {
      expect(toCounter(value)).toBe(0);
    }
  });
});

describe("syncPeerFromRow", () => {
  it("parses well-formed columns", () => {
    expect(
      syncPeerFromRow({
        peer_id: "dev:a",
        peer_name: "A",
        last_manifest_json: '{"schemaVersion":42}',
        last_synced_at: "2026-10-18T00:00:00.000Z",
        last_applied_sha_by_domain: '{"gtd":"sha"}',
      }),
    ).toEqual({
      peerId: "dev:a",
      peerName: "A",
      lastManifest: { schemaVersion: 42 },
      lastSyncedAt: "2026-10-18T00:00:00.000Z",
      lastAppliedShaByDomain: { gtd: "sha" },
    });
  });

  it("degrades corrupt JSON and wrong shapes instead of throwing", () => {
    for (const manifest of [null, "", "{nope", "null", "[]", "3", '"s"']) {
      for (const shas of [null, "", "{nope", "[]", "null", "5"]) {
        expect(
          syncPeerFromRow({
            peer_id: "p",
            peer_name: "n",
            last_manifest_json: manifest,
            last_synced_at: null,
            last_applied_sha_by_domain: shas,
          }),
        ).toEqual({
          peerId: "p",
          peerName: "n",
          lastManifest: null,
          lastSyncedAt: null,
          lastAppliedShaByDomain: {},
        });
      }
    }
  });
});

describe("buildSupportedSyncStatus", () => {
  it("is empty without an identity row", () => {
    expect(buildSupportedSyncStatus(null, [])).toEqual({
      supported: true,
      identity: null,
      changeCounter: 0,
      lastPublishCounter: 0,
      pendingChanges: 0,
      captureEnabled: false,
      backfillComplete: false,
      backfillProgress: null,
      peers: [],
    });
    expect(buildSupportedSyncStatus(null, [], true)).toMatchObject({ captureEnabled: true });
  });

  it("derives pending changes and tolerates garbage counters", () => {
    expect(
      buildSupportedSyncStatus(
        { device_id: GOOD, device_name: "L", change_counter: 10, last_publish_counter: 4 },
        [],
      ),
    ).toMatchObject({ changeCounter: 10, lastPublishCounter: 4, pendingChanges: 6 });
    expect(
      buildSupportedSyncStatus(
        {
          device_id: GOOD,
          device_name: "L",
          change_counter: null as unknown as number,
          last_publish_counter: -3,
        },
        [],
      ),
    ).toMatchObject({ changeCounter: 0, lastPublishCounter: 0, pendingChanges: 0 });
  });
});
