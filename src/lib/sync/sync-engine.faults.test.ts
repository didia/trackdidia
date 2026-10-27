// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import type { SyncChangeSet } from "./change-set";
import { createSyncEngine } from "./sync-engine";
import { LATEST_MIGRATION_ID } from "../storage/migrations";
import { STALE_PEER_MS } from "./engine-gates";
import { DEFAULT_TRANSPORT_TIMEOUT_MS } from "./engine-support";
import type { PullReport, SyncIssue } from "./engine-types";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
} from "./test-support/engine-harness";
import { createMemoryFolders } from "./test-support/memory-transport";
import { SyncTransportError } from "./transport";

/**
 * What the engine does when the folder, a peer or a bundle misbehaves (spec: "Failure modes",
 * "Schema and version skew", "Deletes"): every case ends with the local database either exactly as
 * it was or with only the good peers merged, and with a report that names the culprit.
 */

const DAY = 24 * 60 * 60_000;

const taskIds = async (device: EngineDevice): Promise<string[]> =>
  (await device.repo.listTasks({ includeCompleted: true })).map((task) => task.id).sort();

const hasTask = async (device: EngineDevice, id: string): Promise<boolean> =>
  (await taskIds(device)).includes(id);

const issuesOf = (report: PullReport, code: SyncIssue["code"]): SyncIssue[] =>
  report.issues.filter((issue) => issue.code === code);

const applies = (device: EngineDevice) =>
  device.calls.filter((call) => call.method === "applySyncBundle");

const trio = async () => {
  const world = await createEngineWorld([{ name: "A" }, { name: "B" }, { name: "C" }]);
  return { world, a: world.device("A"), b: world.device("B"), c: world.device("C") };
};

const pair = async (
  spec: Parameters<typeof createEngineWorld>[0] = [{ name: "A" }, { name: "B" }],
) => {
  const world = await createEngineWorld(spec);
  return { world, a: world.device("A"), b: world.device("B") };
};

/** B has published a task; A is the one pulling. */
const publishedByB = async (world: EngineWorld, id = "from-b") => {
  const b = world.device("B");
  await b.repo.createTask({ id, title: id, bucket: "inbox" });
  await b.engine.publish();
};

describe("an unreachable folder", () => {
  it("never blocks the local app, writes nothing, and recovers on the next run", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    world.folders.setMode("personal", "unreachable");
    const before = world.folders.filesOf("personal");

    const pull = await a.engine.pull();
    // The personal folder is a warning; the GTD folder still merged.
    expect(issuesOf(pull, "transport_unreachable")).toMatchObject([
      { severity: "warning", transport: "folder:personal" },
    ]);
    expect(pull.transports.find((t) => t.id === "folder:personal")?.reachable).toBe(false);
    expect(await hasTask(a, "from-b")).toBe(true);

    // The app keeps working locally while the folder is away.
    await a.repo.createTask({ id: "local", title: "Local", bucket: "inbox" });
    const publish = await a.engine.publish();
    expect(publish.counterAdvanced).toBe(false);
    expect(publish.domains.find((d) => d.domain === "gtd")?.outcome).toBe("published");
    expect(publish.domains.find((d) => d.domain === "personal")?.outcome).toBe("failed");
    expect(publish.issues.some((issue) => issue.code === "transport_unreachable")).toBe(true);
    const during = await a.repo.getSyncStatus();
    expect(during.supported && during.pendingChanges).toBeGreaterThan(0);
    expect(world.folders.filesOf("personal")).toEqual(before);

    world.folders.setMode("personal", "up");
    const retried = await a.engine.syncNow();
    expect(retried.pull.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(retried.publish.counterAdvanced).toBe(true);
    const after = await a.repo.getSyncStatus();
    expect(after.supported && after.pendingChanges).toBe(0);
    await b.engine.syncNow();
    expect(await hasTask(b, "local")).toBe(true);
  });

  it("a timeout is its own warning; a folder that never answers is cut off by the engine's backstop", async () => {
    const { world, b } = await pair();
    world.folders.setMode("gtd", "timeout");
    const timedOut = await b.engine.pull();
    expect(issuesOf(timedOut, "transport_timeout")).toHaveLength(1);

    world.folders.setMode("gtd", "hang");
    const hanging = await createEngineWorldWithTimeout(world);
    const started = Date.now();
    const report = await hanging.engine.pull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(issuesOf(report, "transport_timeout")).not.toHaveLength(0);
    expect(report.complete).toBe(true);
  });

  it("any other transport exception is a transport_failed error, isolated to that folder", async () => {
    const { world, a } = await pair();
    await publishedByB(world);
    world.folders.onOperation("personal", "listPeers", () => {
      throw new Error("disk exploded");
    });
    const report = await a.engine.pull();
    expect(issuesOf(report, "transport_failed")).toMatchObject([
      { severity: "error", detail: "disk exploded" },
    ]);
    expect(await hasTask(a, "from-b")).toBe(true);
  });
});

/** A fresh engine for A with a short backstop, over the same folders. */
const createEngineWorldWithTimeout = async (world: EngineWorld) => {
  const a = world.device("A");
  const engine = createSyncEngine({
    repo: a.repo,
    transports: a.transports,
    profile: "personal",
    now: a.clock.read,
    transportTimeoutMs: 50,
  });
  return { engine };
};

describe("a bundle that is not ready or not valid", () => {
  it("a partial or unverified bundle is 'not yet': nothing changes, then it is retried", async () => {
    const { world, a } = await pair();
    await publishedByB(world);
    const b = world.device("B");
    const original = world.folders.bundleText("gtd", b.deviceId, "gtd");

    for (const kind of ["partial", "unverified"] as const) {
      world.folders.damageBundle("gtd", b.deviceId, "gtd", kind);
      const report = await a.engine.pull();
      expect(report.peers.find((p) => p.transport === "folder:gtd")?.domains[0]?.outcome).toBe(
        "not_ready",
      );
      expect(issuesOf(report, "bundle_not_ready")).toHaveLength(1);
      expect(await hasTask(a, "from-b")).toBe(false);
      const status = await a.repo.getSyncStatus();
      expect(
        status.supported && status.peers.flatMap((p) => Object.keys(p.lastAppliedShaByDomain)),
      ).not.toContain("gtd");
      world.folders.restoreBundle("gtd", b.deviceId, "gtd", original);
      if (kind === "partial") continue;
    }
    const finished = await a.engine.pull();
    expect(finished.totals.bundlesApplied).toBeGreaterThan(0);
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("keeps the previous state when a newer generation is not ready", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world, "first");
    await a.engine.pull();
    const before = await a.repo.getSyncStatus();

    await b.repo.createTask({ id: "second", title: "second", bucket: "inbox" });
    await b.engine.publish();
    world.folders.damageBundle("gtd", b.deviceId, "gtd", "partial");
    const report = await a.engine.pull();
    expect(report.peers.find((p) => p.transport === "folder:gtd")?.domains[0]?.outcome).toBe(
      "not_ready",
    );
    expect(await hasTask(a, "second")).toBe(false);
    expect(await hasTask(a, "first")).toBe(true);
    const after = await a.repo.getSyncStatus();
    expect(after).toEqual(before);
  });

  it("rejects a corrupt bundle as a whole with the peer's name, and still applies the other peer", async () => {
    const { world, a, b, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();
    const original = world.folders.bundleText("gtd", b.deviceId, "gtd");

    for (const kind of ["not-json", "bad-shape"] as const) {
      world.folders.damageBundle("gtd", b.deviceId, "gtd", kind);
      const report = await a.engine.pull();
      const invalid = issuesOf(report, "bundle_invalid");
      expect(invalid).toHaveLength(1);
      expect(invalid[0]).toMatchObject({ severity: "error", peerName: "B", peerId: b.deviceId });
      expect(invalid[0]?.message).toContain("B");
      expect(await hasTask(a, "from-b")).toBe(false);
      expect(await hasTask(a, "from-c")).toBe(true);
      // Nothing about B was remembered as applied, so a repaired bundle is picked up.
      const status = await a.repo.getSyncStatus();
      const peerB = status.supported
        ? status.peers.find((p) => p.peerId === b.deviceId)
        : undefined;
      expect(peerB?.lastAppliedShaByDomain.gtd).toBeUndefined();
    }

    // Once the bundle is fixed the next pull reads it again and applies it.
    world.folders.restoreBundle("gtd", b.deviceId, "gtd", original);
    world.folders.resetCalls();
    const repaired = await a.engine.pull();
    expect(world.folders.calls(a.deviceId, "gtd").readBundle).toBeGreaterThan(0);
    expect(repaired.totals.bundlesApplied).toBeGreaterThan(0);
    expect(await hasTask(a, "from-b")).toBe(true);
    const after = await a.repo.getSyncStatus();
    expect(
      after.supported &&
        after.peers.find((p) => p.peerId === b.deviceId)?.lastAppliedShaByDomain.gtd,
    ).toBe(world.folders.manifestFor("gtd", b.deviceId)?.domains.gtd?.sha256);
  });

  it("a bundle the repository refuses (schema newer than the database) is reported and isolated", async () => {
    const { world, a, b, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();
    // B's file claims a schema this database has not reached; the manifest is consistent with it.
    const forged = JSON.parse(world.folders.bundleText("gtd", b.deviceId, "gtd")) as SyncChangeSet;
    forged.schemaVersion = 999;
    world.folders.plantBundle("gtd", b.deviceId, "gtd", forged);

    const report = await a.engine.pull();
    expect(issuesOf(report, "bundle_rejected")).toMatchObject([
      { peerName: "B", detail: "schema_newer_than_local" },
    ]);
    expect(await hasTask(a, "from-b")).toBe(false);
    expect(await hasTask(a, "from-c")).toBe(true);

    // The refusal is not remembered as applied: once B publishes a bundle this database accepts,
    // the next pull reads and applies it.
    const status = await a.repo.getSyncStatus();
    const peerB = status.supported ? status.peers.find((p) => p.peerId === b.deviceId) : undefined;
    expect(peerB?.lastAppliedShaByDomain.gtd).toBeUndefined();
    forged.schemaVersion = (await b.repo.listSyncChanges("gtd")).schemaVersion;
    world.folders.plantBundle("gtd", b.deviceId, "gtd", forged);
    world.folders.resetCalls();
    const repaired = await a.engine.pull();
    expect(world.folders.calls(a.deviceId, "gtd").readBundle).toBeGreaterThan(0);
    expect(issuesOf(repaired, "bundle_rejected")).toEqual([]);
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("a bundle written by another device than its manifest names is never applied", async () => {
    const { world, a, b, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();
    // C's gtd bundle copied behind B's manifest entry.
    const cBundle = JSON.parse(world.folders.bundleText("gtd", c.deviceId, "gtd")) as SyncChangeSet;
    world.folders.plantBundle("gtd", b.deviceId, "gtd", cBundle);
    const report = await a.engine.pull();
    expect(issuesOf(report, "bundle_device_mismatch")).toHaveLength(1);
    expect(await hasTask(a, "from-b")).toBe(false);
    expect(await hasTask(a, "from-c")).toBe(true);
  });

  it("a crash between the bundle file and the manifest leaves readers on the old generation", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world, "first");
    await a.engine.pull();
    await b.repo.createTask({ id: "second", title: "second", bucket: "inbox" });
    world.folders.crashNextPublishes("gtd");
    const crashed = await b.engine.publish();
    expect(crashed.domains.find((d) => d.domain === "gtd")?.outcome).toBe("failed");
    expect(crashed.counterAdvanced).toBe(false);
    const pending = await b.repo.getSyncStatus();
    expect(pending.supported && pending.pendingChanges).toBeGreaterThan(0);

    const report = await a.engine.pull();
    expect(report.totals.bundlesApplied).toBe(0);
    expect(await hasTask(a, "second")).toBe(false);

    const retried = await b.engine.publish();
    expect(retried.counterAdvanced).toBe(true);
    await a.engine.pull();
    expect(await hasTask(a, "second")).toBe(true);
  });
});

describe("what a manifest may claim", () => {
  it("ignores Drive conflict copies and stray files", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    world.folders.plantConflictCopy("gtd", b.deviceId);
    const report = await a.engine.pull();
    expect(report.peers.filter((p) => p.transport === "folder:gtd")).toHaveLength(1);
    expect(report.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("refuses a domain the folder never carries, naming the writer, and still applies the rest", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    // B (or a bug) put a personal bundle behind the shared GTD folder's manifest.
    const personal = await b.repo.listSyncChanges("personal");
    world.folders.plantBundle("gtd", b.deviceId, "personal", personal);
    const report = await a.engine.pull();
    const refused = issuesOf(report, "domain_not_allowed");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ severity: "error", peerName: "B", domain: "personal" });
    expect(await hasTask(a, "from-b")).toBe(true);
    // Not a single bundle of the personal domain was taken from the GTD folder.
    const fromGtdFolder = report.peers.find((peer) => peer.transport === "folder:gtd");
    expect(fromGtdFolder?.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["personal", "refused"],
      ["gtd", "applied"],
    ]);
  });

  it("refuses a GTD manifest entry whose bundle holds another domain", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    const personal = await b.repo.listSyncChanges("personal");
    world.folders.plantBundle("gtd", b.deviceId, "gtd", personal);
    const report = await a.engine.pull();
    expect(issuesOf(report, "wrong_domain_bundle")).toMatchObject([
      { severity: "error", peerName: "B", detail: "personal" },
    ]);
    expect(await hasTask(a, "from-b")).toBe(false);
  });

  it("refuses a work peer that lists a domain a work device may not publish", async () => {
    const world = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: ["gtd"] },
    ]);
    const a = world.device("A");
    const w = world.device("W");
    await w.repo.createTask({ id: "from-w", title: "From W", bucket: "inbox" });
    await w.engine.publish();
    // Lying about itself: a personal bundle in the personal folder under a work manifest.
    const forged = await a.repo.listSyncChanges("personal");
    world.folders.plantBundle("gtd", w.deviceId, "personal", {
      ...forged,
      deviceId: w.deviceId,
    });
    const report = await a.engine.pull();
    expect(issuesOf(report, "domain_not_allowed")).toHaveLength(1);
    expect(await hasTask(a, "from-w")).toBe(true);
  });

  it("skips a manifest of a format it does not know, and a malformed one, without touching the rest", async () => {
    const { world, a, b, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();
    world.folders.patchManifest("gtd", b.deviceId, { formatVersion: 2 });
    const report = await a.engine.pull();
    expect(issuesOf(report, "format_version_unsupported")).toMatchObject([
      { severity: "warning", peerName: "B" },
    ]);
    expect(report.peers.find((p) => p.peerId === b.deviceId)?.status).toBe("format_unsupported");
    expect(await hasTask(a, "from-b")).toBe(false);
    expect(await hasTask(a, "from-c")).toBe(true);

    world.folders.patchManifest("gtd", b.deviceId, {
      formatVersion: 1,
      deviceName: 42 as unknown as string,
    });
    const malformed = await a.engine.pull();
    expect(issuesOf(malformed, "manifest_invalid")).toHaveLength(1);
    expect(await hasTask(a, "from-b")).toBe(false);
  });
});

describe("schema skew", () => {
  it("skips a peer with a newer schema ('update TrackDidia'), keeps publishing, merges an older one", async () => {
    const { world, a, b, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();
    world.folders.patchManifest("gtd", b.deviceId, { schemaVersion: 999 });

    a.calls.length = 0;
    const report = await a.engine.syncNow();
    const update = issuesOf(report.pull, "update_required");
    expect(update).toHaveLength(1);
    expect(update[0]?.message).toContain("Update TrackDidia to sync with B");
    expect(report.pull.peers.find((p) => p.peerId === b.deviceId)?.status).toBe("update_required");
    expect(await hasTask(a, "from-b")).toBe(false);
    expect(await hasTask(a, "from-c")).toBe(true);
    // B's bundle was not even read; our own state still goes out.
    expect(world.folders.calls(a.deviceId, "gtd").readBundle).toBe(1);
    expect(report.publish.domains.every((d) => d.outcome === "published")).toBe(true);
    expect((await a.engine.getStatus()).peers.find((p) => p.peerId === b.deviceId)).toMatchObject({
      state: "update_required",
    });
  });

  it("merges a peer whose schema is older than ours", async () => {
    const world = await createEngineWorld([
      { name: "A", engine: { localSchemaVersion: 50 } },
      { name: "B" },
    ]);
    const [a] = [world.device("A")];
    await publishedByB(world, "from-b");
    const report = await a.engine.pull();
    expect(issuesOf(report, "update_required")).toEqual([]);
    expect(await hasTask(a, "from-b")).toBe(true);
    // A peer on another schema counts as skew: the safety backup reason says so.
    expect(report.safetyBackup.reasons).toContain("schema_skew");
  });
});

describe("a peer that has been away too long", () => {
  it("refuses a peer last written more than 90 days ago, without applying anything", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    world.folders.patchManifest("gtd", b.deviceId, {
      writtenAt: new Date(a.clock.now - STALE_PEER_MS - 1).toISOString(),
    });
    const report = await a.engine.pull();
    const stale = issuesOf(report, "stale_peer");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ detail: "peer_written_long_ago", peerName: "B" });
    expect(stale[0]?.message).toContain("offline too long");
    expect(report.peers.find((p) => p.transport === "folder:gtd")?.status).toBe("stale");
    expect(applies(a).filter((call) => call.domain === "gtd")).toEqual([]);
    expect(await hasTask(a, "from-b")).toBe(false);
    expect((await a.engine.getStatus()).peers).toEqual([
      expect.objectContaining({ peerId: b.deviceId, state: "stale" }),
    ]);

    // Exactly 90 days is still fine.
    world.folders.patchManifest("gtd", b.deviceId, {
      writtenAt: new Date(a.clock.now - STALE_PEER_MS).toISOString(),
    });
    expect((await a.engine.pull()).totals.bundlesApplied).toBeGreaterThan(0);
  });

  it("refuses to merge after not pulling from a peer for more than 90 days; the user can approve", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world, "early");
    await a.engine.pull();

    // Both laptops are idle for 100 days; then B writes again.
    a.clock.advance(100 * DAY);
    b.clock.advance(100 * DAY);
    await b.repo.createTask({ id: "late", title: "late", bucket: "inbox" });
    await b.engine.publish();

    a.calls.length = 0;
    const refused = await a.engine.pull();
    // One warning per folder the peer is in.
    expect(issuesOf(refused, "stale_peer").map((issue) => issue.detail)).toEqual([
      "not_pulled_recently",
      "not_pulled_recently",
    ]);
    expect(applies(a)).toEqual([]);
    expect(await hasTask(a, "late")).toBe(false);
    expect((await a.engine.getStatus()).peers).toEqual([
      expect.objectContaining({ peerId: b.deviceId, state: "stale" }),
    ]);

    const approved = await a.engine.pull({ approveStalePeers: [b.deviceId] });
    expect(issuesOf(approved, "stale_peer")).toEqual([]);
    expect(await hasTask(a, "late")).toBe(true);
    // Merging refreshed the contact: the next pull is ordinary again.
    b.clock.advance(60_000);
    await b.repo.createTask({ id: "later", title: "later", bucket: "inbox" });
    await b.engine.publish();
    const next = await a.engine.pull();
    expect(issuesOf(next, "stale_peer")).toEqual([]);
    expect(await hasTask(a, "later")).toBe(true);
  });

  it("a peer that is polled regularly never counts as 'not pulled for 90 days'", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.engine.pull();
    // B publishes nothing for 80 days, but A keeps reading its (unchanged) manifest.
    for (let step = 0; step < 8; step += 1) {
      a.clock.advance(10 * DAY);
      b.clock.advance(10 * DAY);
      await a.engine.pull();
    }
    a.clock.advance(20 * DAY);
    b.clock.advance(20 * DAY);
    await b.repo.createTask({ id: "after-a-quiet-spell", title: "x", bucket: "inbox" });
    await b.engine.publish();
    const report = await a.engine.pull();
    expect(issuesOf(report, "stale_peer")).toEqual([]);
    expect(await hasTask(a, "after-a-quiet-spell")).toBe(true);
  });
});

describe("a transport that returns garbage", () => {
  it("skips unusable manifests and survives a listing that is not a list", async () => {
    const { world, a } = await pair();
    await publishedByB(world);
    const [gtd] = a.transports;
    if (!gtd) throw new Error("no transport");
    const garbage = [null, "text", 42, {}, ...(await gtd.listPeers())];
    const engine = createSyncEngine({
      repo: a.repo,
      transports: [
        {
          ...gtd,
          id: gtd.id,
          domains: gtd.domains,
          listPeers: async () => garbage as never,
          readBundle: gtd.readBundle.bind(gtd),
          publish: gtd.publish.bind(gtd),
          ownGeneration: gtd.ownGeneration.bind(gtd),
        },
      ],
      profile: "personal",
      now: a.clock.read,
      beforeFirstMerge: async () => undefined,
    });
    const report = await engine.pull();
    // null, text and a number are not manifests; {} has no format version at all.
    expect(issuesOf(report, "manifest_invalid")).toHaveLength(3);
    expect(issuesOf(report, "format_version_unsupported")).toHaveLength(1);
    expect(await hasTask(a, "from-b")).toBe(true);

    const notAList = createSyncEngine({
      repo: a.repo,
      transports: [
        {
          ...gtd,
          id: gtd.id,
          domains: gtd.domains,
          listPeers: async () => ({}) as never,
          readBundle: gtd.readBundle.bind(gtd),
          publish: gtd.publish.bind(gtd),
          ownGeneration: gtd.ownGeneration.bind(gtd),
        },
      ],
      profile: "personal",
      now: a.clock.read,
    });
    expect(issuesOf(await notAList.pull(), "transport_failed")).toHaveLength(1);
  });
});

describe("recording contact with a peer", () => {
  it("a stray domain entry in a manifest does not stop the contact being recorded", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.engine.pull();
    const personal = await b.repo.listSyncChanges("personal");
    world.folders.plantBundle("gtd", b.deviceId, "personal", personal);
    a.clock.advance(3 * DAY);
    b.clock.advance(3 * DAY);
    await a.engine.pull();
    const status = await a.repo.getSyncStatus();
    const peer = status.supported ? status.peers[0] : undefined;
    expect(peer?.lastSyncedAt).toBe(new Date(a.clock.now).toISOString());
  });
});

describe("a peer whose clock is ahead", () => {
  it("warns above five minutes and still merges", async () => {
    const { world, a, b } = await pair();
    b.clock.advance(10 * 60_000);
    await publishedByB(world);
    const report = await a.engine.pull();
    const skew = issuesOf(report, "clock_skew");
    expect(skew).toHaveLength(1);
    expect(skew[0]).toMatchObject({ severity: "warning", peerName: "B" });
    expect(report.peers.find((p) => p.transport === "folder:gtd")?.clockSkewMs).toBeGreaterThan(
      5 * 60_000,
    );
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("is quiet at five minutes", async () => {
    const { world, a, b } = await pair();
    b.clock.advance(5 * 60_000 - 1_000);
    await publishedByB(world);
    expect(issuesOf(await a.engine.pull(), "clock_skew")).toEqual([]);
  });

  it("a clock more than 24 hours ahead is rejected by the repository, not merged", async () => {
    const { world, a, b } = await pair();
    b.clock.advance(3 * DAY);
    await publishedByB(world);
    const report = await a.engine.pull();
    expect(issuesOf(report, "clock_skew")).toHaveLength(1);
    expect(issuesOf(report, "bundle_rejected")).toMatchObject([{ detail: "remote_too_far_ahead" }]);
    expect(await hasTask(a, "from-b")).toBe(false);
  });
});

describe("the safety backup before the first merge", () => {
  const twoWithHook = async (hook: (reasons: readonly string[]) => Promise<undefined>) => {
    const world = await createEngineWorld([
      { name: "A", engine: { beforeFirstMerge: hook as never } },
      { name: "B" },
    ]);
    return { world, a: world.device("A"), b: world.device("B") };
  };

  it("runs once, before the first apply, and not again on later merges", async () => {
    const events: string[] = [];
    let a!: EngineDevice;
    const { world, ...devices } = await twoWithHook(async (reasons) => {
      events.push(`backup(${reasons.join("+")}) after ${applies(a).length} applies`);
      return undefined;
    });
    a = devices.a;
    await publishedByB(world, "one");
    await a.repo.createTask({ id: "mine", title: "Mine", bucket: "inbox" });

    const first = await a.engine.pull();
    expect(events).toEqual(["backup(first_merge) after 0 applies"]);
    expect(first.safetyBackup).toMatchObject({ status: "taken", reasons: ["first_merge"] });
    expect(applies(a).length).toBeGreaterThan(0);

    await devices.b.repo.createTask({ id: "two", title: "two", bucket: "inbox" });
    await devices.b.engine.publish();
    const second = await a.engine.pull();
    expect(second.totals.bundlesApplied).toBeGreaterThan(0);
    expect(second.safetyBackup.status).toBe("not_needed");
    expect(events).toHaveLength(1);
  });

  it("is not taken when a pull has nothing to apply", async () => {
    const events: string[] = [];
    const { a } = await twoWithHook(async () => {
      events.push("backup");
      return undefined;
    });
    const report = await a.engine.pull();
    expect(events).toEqual([]);
    expect(report.safetyBackup.status).toBe("not_needed");
  });

  it("refuses to merge anything when the backup cannot be made, then recovers", async () => {
    let fail = true;
    const { world, a, b } = await twoWithHook(async () => {
      if (fail) throw new Error("backup folder is not mounted");
      return undefined;
    });
    await publishedByB(world);
    await a.repo.createTask({ id: "mine", title: "Mine", bucket: "inbox" });
    const before = await a.repo.getSyncStatus();

    const report = await a.engine.pull();
    expect(applies(a)).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.safetyBackup.status).toBe("failed");
    expect(issuesOf(report, "safety_backup_required")).toMatchObject([
      { severity: "error", detail: "backup folder is not mounted" },
    ]);
    expect(report.remaining.length).toBeGreaterThan(0);
    expect(await taskIds(a)).toEqual(["mine"]);
    expect(await a.repo.getSyncStatus()).toEqual(before);

    fail = false;
    const retried = await a.engine.pull();
    expect(retried.complete).toBe(true);
    expect(await hasTask(a, "from-b")).toBe(true);
    void b;
  });

  it("refuses to merge when there is no backup hook at all", async () => {
    const world = await createEngineWorld([
      { name: "A", engine: { beforeFirstMerge: undefined } },
      { name: "B" },
    ]);
    const a = world.device("A");
    await publishedByB(world);
    const report = await a.engine.pull();
    expect(applies(a)).toEqual([]);
    expect(issuesOf(report, "safety_backup_required")).toHaveLength(1);
    expect(report.complete).toBe(false);
  });

  it("a verified empty joiner skips the backup, and the skip is recorded", async () => {
    const world = await createEngineWorld([
      { name: "A", engine: { beforeFirstMerge: undefined } },
      { name: "B" },
    ]);
    const a = world.device("A");
    await publishedByB(world);
    const report = await a.engine.pull({ verifiedEmptyJoiner: true });
    expect(report.safetyBackup).toMatchObject({
      status: "skipped_empty_joiner",
      reasons: ["first_merge"],
    });
    expect(await hasTask(a, "from-b")).toBe(true);
  });

  it("a peer whose schema differs triggers one after the first merge, then not again", async () => {
    const reasonsSeen: string[][] = [];
    const { world, a, b } = await twoWithHook(async (reasons) => {
      reasonsSeen.push([...reasons]);
      return undefined;
    });
    await publishedByB(world, "one");
    await a.engine.pull();
    expect(reasonsSeen).toEqual([["first_merge"]]);

    // B now reports an older schema than A's with fresh content.
    await b.repo.createTask({ id: "two", title: "two", bucket: "inbox" });
    await b.engine.publish();
    world.folders.patchManifest("gtd", b.deviceId, { schemaVersion: 42 });
    await a.engine.pull();
    expect(reasonsSeen).toEqual([["first_merge"], ["schema_skew"]]);

    await b.repo.createTask({ id: "three", title: "three", bucket: "inbox" });
    await b.engine.publish();
    world.folders.patchManifest("gtd", b.deviceId, { schemaVersion: 42 });
    await a.engine.pull();
    expect(reasonsSeen).toHaveLength(2);
    expect(await hasTask(a, "three")).toBe(true);
  });
});

describe("the safety backup after a LOCAL upgrade", () => {
  it("asks again when this laptop's schema moved since the last merge with the peer", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
    const [a, b] = [world.device("A"), world.device("B")];
    const reasonsSeen: string[][] = [];
    const upgraded = createSyncEngine({
      repo: a.repo,
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
      localSchemaVersion: LATEST_MIGRATION_ID + 1,
      beforeFirstMerge: async (reasons) => {
        reasonsSeen.push([...reasons]);
        return undefined;
      },
    });
    await publishedByB(world, "one");
    await a.engine.pull(); // merged at the current schema (the harness hook takes the backup)

    await b.repo.createTask({ id: "two", title: "two", bucket: "inbox" });
    await b.engine.publish();
    // A's app is upgraded: same peer, same peer schema, a different pair.
    const report = await upgraded.pull();
    expect(reasonsSeen).toEqual([["schema_skew"]]);
    expect(report.safetyBackup).toMatchObject({ status: "taken", reasons: ["schema_skew"] });
    expect(await hasTask(a, "two")).toBe(true);

    // Recorded now: the same pair does not ask again.
    await b.repo.createTask({ id: "three", title: "three", bucket: "inbox" });
    await b.engine.publish();
    await upgraded.pull();
    expect(reasonsSeen).toHaveLength(1);
  });

  it("a contact that merged nothing does not hide a later local upgrade", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
    const [a, b] = [world.device("A"), world.device("B")];
    const reasonsSeen: string[][] = [];
    await publishedByB(world, "one");
    await a.engine.pull();
    a.clock.advance(3 * DAY);
    b.clock.advance(3 * DAY);
    await a.engine.pull(); // unchanged manifests: a contact record only
    const upgraded = createSyncEngine({
      repo: a.repo,
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
      localSchemaVersion: LATEST_MIGRATION_ID + 1,
      beforeFirstMerge: async (reasons) => {
        reasonsSeen.push([...reasons]);
        return undefined;
      },
    });
    await b.repo.createTask({ id: "two", title: "two", bucket: "inbox" });
    await b.engine.publish();
    await upgraded.pull();
    expect(reasonsSeen).toEqual([["schema_skew"]]);
  });
});

describe("what a failed domain does and does not record", () => {
  it("a peer with a domain that is not ready keeps its old contact time; the other domain is remembered", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.engine.pull();
    const before = await a.repo.getSyncStatus();
    const contact = before.supported ? before.peers[0]?.lastSyncedAt : undefined;
    expect(contact).toBeTruthy();

    a.clock.advance(3 * DAY);
    b.clock.advance(3 * DAY);
    await b.repo.createTask({ id: "later", title: "later", bucket: "inbox" });
    const entry = createEmptyDailyEntry("2026-10-03");
    entry.morningIntention = "changed";
    await b.repo.saveDailyEntry(entry);
    await b.engine.publish();
    world.folders.damageBundle("gtd", b.deviceId, "gtd", "partial");
    const report = await a.engine.pull();

    // The personal and finance bundles of B changed and were applied; the gtd one is not ready.
    expect(report.totals.bundlesApplied).toBeGreaterThan(0);
    expect(issuesOf(report, "bundle_not_ready")).toHaveLength(1);
    const after = await a.repo.getSyncStatus();
    const peer = after.supported ? after.peers[0] : undefined;
    expect(peer?.lastSyncedAt).toBe(contact);
    expect(peer?.lastAppliedShaByDomain.personal).toBe(
      world.folders.manifestFor("personal", b.deviceId)?.domains.personal?.sha256,
    );
  });

  it("a peer with a rejected domain does not get its contact refreshed either", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.engine.pull();
    const before = await a.repo.getSyncStatus();
    const contact = before.supported ? before.peers[0]?.lastSyncedAt : undefined;

    a.clock.advance(3 * DAY);
    b.clock.advance(3 * DAY);
    await b.repo.createTask({ id: "later", title: "later", bucket: "inbox" });
    await b.engine.publish();
    world.folders.damageBundle("gtd", b.deviceId, "gtd", "not-json");
    const report = await a.engine.pull();
    expect(issuesOf(report, "bundle_invalid")).toHaveLength(1);
    const after = await a.repo.getSyncStatus();
    expect(after.supported && after.peers[0]?.lastSyncedAt).toBe(contact);
  });

  it("a healthy contact does refresh it", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.engine.pull();
    a.clock.advance(3 * DAY);
    b.clock.advance(3 * DAY);
    await b.repo.createTask({ id: "later", title: "later", bucket: "inbox" });
    await b.engine.publish();
    await a.engine.pull();
    const after = await a.repo.getSyncStatus();
    expect(after.supported && after.peers[0]?.lastSyncedAt).toBe(
      new Date(a.clock.now).toISOString(),
    );
  });
});

describe("a transport that lists this device itself", () => {
  it("is ignored: no report entry, no read, nothing applied from our own bundle", async () => {
    const { world, a, b } = await pair();
    await publishedByB(world);
    await a.repo.createTask({ id: "mine", title: "mine", bucket: "inbox" });
    await a.engine.publish();
    const [gtd] = a.transports;
    if (!gtd) throw new Error("no transport");
    // A transport that forgot to exclude us: it lists every manifest in the folder.
    const everyone = world.folders.attach(b.deviceId, "gtd");
    const sloppy = {
      id: gtd.id,
      domains: gtd.domains,
      listPeers: async () => [...(await gtd.listPeers()), ...(await everyone.listPeers())],
      readBundle: gtd.readBundle.bind(gtd),
      publish: gtd.publish.bind(gtd),
      ownGeneration: gtd.ownGeneration.bind(gtd),
    };
    const reads: string[] = [];
    world.folders.onOperation("gtd", "readBundle", () => {
      reads.push("read");
    });
    const engine = createSyncEngine({
      repo: a.repo,
      transports: [sloppy],
      profile: "personal",
      now: a.clock.read,
      beforeFirstMerge: async () => undefined,
    });
    const report = await engine.pull();
    expect(report.peers.map((peer) => peer.peerId)).toEqual([b.deviceId]);
    expect(reads).toHaveLength(1);
  });
});

describe("a transport that never answers", () => {
  it("is cut off after the engine's default limit, so the run slot is released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const world = await createEngineWorld([{ name: "A" }]);
      const a = world.device("A");
      const never = {
        id: "folder:never",
        domains: ["gtd"] as const,
        listPeers: () => new Promise<never>(() => undefined),
        readBundle: () => new Promise<never>(() => undefined),
        publish: () => new Promise<never>(() => undefined),
        ownGeneration: () => new Promise<never>(() => undefined),
      };
      const engine = createSyncEngine({
        repo: a.repo,
        transports: [never],
        profile: "personal",
        now: a.clock.read,
      });
      const run = engine.syncNow();
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TRANSPORT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(engine.running).toBe("syncNow");
      await vi.advanceTimersByTimeAsync(2 * DEFAULT_TRANSPORT_TIMEOUT_MS);
      const report = await run;
      expect(issuesOf(report.pull, "transport_timeout")).toHaveLength(1);
      expect(report.publish.issues.some((issue) => issue.code === "transport_timeout")).toBe(true);
      expect(engine.running).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the time budget", () => {
  it("stops starting new work once exceeded, never applies half a bundle, and a second pull finishes", async () => {
    const { world, a, c } = await trio();
    await publishedByB(world, "from-b");
    await c.repo.createTask({ id: "from-c", title: "from-c", bucket: "inbox" });
    await c.engine.publish();

    // Every bundle read costs 2 s on A's clock.
    world.folders.onOperation("gtd", "readBundle", () => a.clock.advance(2_000));
    world.folders.onOperation("personal", "readBundle", () => a.clock.advance(2_000));

    const first = await a.engine.pull({ budgetMs: 1_000 });
    expect(first.complete).toBe(false);
    expect(first.totals.bundlesApplied).toBe(1);
    expect(first.remaining.length).toBeGreaterThan(0);
    // The first peer's gtd bundle (B) is whole; the second peer's (C) did not start.
    expect(await hasTask(a, "from-b")).toBe(true);
    expect(await hasTask(a, "from-c")).toBe(false);
    expect(first.remaining[0]).toMatchObject({ domain: "gtd", peerId: c.deviceId, peerName: "C" });
    for (const peer of first.peers) {
      for (const result of peer.domains) {
        expect(["applied", "deferred", "unchanged"]).toContain(result.outcome);
      }
    }

    world.folders.onOperation("gtd", "readBundle", undefined);
    world.folders.onOperation("personal", "readBundle", undefined);
    const second = await a.engine.pull();
    expect(second.complete).toBe(true);
    expect(second.remaining).toEqual([]);
    expect(await hasTask(a, "from-c")).toBe(true);
  });

  it("a budget of zero lists every readable transport as remaining and touches nothing", async () => {
    const { world, a } = await pair();
    await publishedByB(world);
    world.folders.resetCalls();
    const report = await a.engine.pull({ budgetMs: 0 });
    expect(report.complete).toBe(false);
    expect(report.remaining.map((item) => [item.transport, item.domain, item.peerId])).toEqual([
      ["folder:gtd", "gtd", null],
      ["folder:personal", "personal", null],
      ["folder:personal", "finance", null],
    ]);
    expect(world.folders.calls(a.deviceId, "gtd").listPeers).toBe(0);
    expect(applies(a)).toEqual([]);
  });
});

describe("a database that cannot sync", () => {
  it("reports sync_not_ready for browser preview and for a database without identity", async () => {
    const folders = createMemoryFolders();
    const transport = folders.attach("dev:00000000-0000-4000-8000-0000000000aa", "gtd");
    const engine = createSyncEngine({
      repo: new MemoryRepository(),
      transports: [transport],
      profile: "personal",
    });
    const pull = await engine.pull();
    expect(issuesOf(pull, "sync_not_ready")).toHaveLength(1);
    expect(pull.complete).toBe(true);
    const publish = await engine.publish();
    expect(publish.issues.map((issue) => issue.code)).toEqual(["publish_skipped"]);
    expect((await engine.getStatus()).ready).toBe(false);
  });

  it("rejects transports that declare the same domain twice", async () => {
    const folders = createMemoryFolders();
    const id = "dev:00000000-0000-4000-8000-0000000000bb";
    const first = folders.attach(id, "gtd");
    const second = folders.attach(id, "gtd");
    expect(() =>
      createSyncEngine({
        repo: new MemoryRepository(),
        transports: [first, second],
        profile: "personal",
      }),
    ).toThrow(/both declare the "gtd" domain/);
  });
});

describe("transports are tested for their own errors", () => {
  it("a typed transport error carries its code", () => {
    expect(new SyncTransportError("timeout", "slow").code).toBe("timeout");
  });
});
