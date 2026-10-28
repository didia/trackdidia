// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { assertRouted, routeDomain } from "./engine-publish";
import { createSyncEngine, SyncEngineError } from "./sync-engine";
import { createEngineWorld, type EngineDevice } from "./test-support/engine-harness";
import type { SyncTransport } from "./transport";

/**
 * Which transport a domain goes to, and what a device profile may publish: a personal bundle is never
 * handed to the shared GTD folder's transport, a work device never even reads its personal tables for
 * publishing, and a folder configured later gets this device's bundles although nothing changed.
 */

const listed = (device: EngineDevice) =>
  device.calls.filter((call) => call.method === "listSyncChanges").map((call) => call.domain);

describe("routing", () => {
  it("routes a domain to the transport that declares it, and to no other", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const [gtd, personal] = (world.device("A") as EngineDevice).transports as [
      SyncTransport,
      SyncTransport,
    ];
    expect(routeDomain([gtd, personal], "gtd")).toBe(gtd);
    expect(routeDomain([gtd, personal], "personal")).toBe(personal);
    expect(routeDomain([gtd, personal], "finance")).toBe(personal);
    expect(routeDomain([gtd], "personal")).toBeUndefined();
  });

  it("refuses to hand a bundle to a transport that does not carry its domain", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    const [gtd] = a.transports as [SyncTransport];
    const personalBundle = await a.repo.listSyncChanges("personal");
    const gtdBundle = await a.repo.listSyncChanges("gtd");
    expect(() => assertRouted(gtd, "personal", personalBundle)).toThrow(SyncEngineError);
    expect(() => assertRouted(gtd, "gtd", personalBundle)).toThrow(
      /domain_routing_violation|Refusing/,
    );
    expect(() => assertRouted(gtd, "gtd", gtdBundle)).not.toThrow();
  });

  it("never publishes a bundle of the wrong domain, even if the repository returned one", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    // A repository bug: asked for gtd, it answers with the personal change set.
    const engine = createSyncEngine({
      repo: {
        getSyncStatus: () => a.repo.getSyncStatus(),
        applySyncBundle: (domain, changeSet) => a.repo.applySyncBundle(domain, changeSet),
        recordSyncPeerApplied: (input) => a.repo.recordSyncPeerApplied(input),
        markSyncPublished: (counter) => a.repo.markSyncPublished(counter),
        queueSyncRepublish: () => a.repo.queueSyncRepublish(),
        listSyncChanges: async (domain) =>
          domain === "gtd" ? a.repo.listSyncChanges("personal") : a.repo.listSyncChanges(domain),
      },
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    const report = await engine.publish();
    expect(report.domains.find((d) => d.domain === "gtd")).toMatchObject({ outcome: "failed" });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "publish_failed", detail: "domain_routing_violation" }),
    );
    expect(world.folders.filesOf("gtd")).toEqual([]);
    expect(report.counterAdvanced).toBe(false);
  });
});

describe("what a device profile publishes", () => {
  it("a work device with BOTH transports still publishes only gtd and reads only gtd", async () => {
    const world = await createEngineWorld([
      { name: "W", profile: "work", roles: ["gtd", "personal"] },
    ]);
    const w = world.device("W");
    await w.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    w.calls.length = 0;
    const report = await w.engine.publish({ force: true });
    expect(report.domains.map((d) => [d.domain, d.outcome])).toEqual([["gtd", "published"]]);
    expect(listed(w)).toEqual(["gtd"]);
    expect(world.folders.calls(w.deviceId, "personal").publish).toBe(0);
    expect(world.folders.filesOf("personal")).toEqual([]);
  });

  it("a personal device that only has the GTD folder never reads or sends personal data", async () => {
    const world = await createEngineWorld([{ name: "A", roles: ["gtd"] }]);
    const a = world.device("A");
    const entry = createEmptyDailyEntry("2026-10-01");
    entry.morningIntention = "PRIVATE";
    await a.repo.saveDailyEntry(entry);
    a.calls.length = 0;
    const report = await a.engine.publish({ force: true });
    expect(report.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "published"],
      ["personal", "no_transport"],
      ["finance", "no_transport"],
    ]);
    expect(listed(a)).toEqual(["gtd"]);
    expect(world.folders.filesOf("gtd").some((file) => file.content.includes("PRIVATE"))).toBe(
      false,
    );
    expect(world.folders.filesOf("personal")).toEqual([]);
  });

  it("a folder configured later receives this device's bundles: the changes stayed pending", async () => {
    const world = await createEngineWorld([{ name: "A", roles: ["gtd"] }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await a.engine.publish();
    expect((await a.engine.publish()).domains.map((d) => d.outcome)).toEqual([
      "clean",
      "no_transport",
      "no_transport",
    ]);
    // Nothing carried personal and finance, so what was published is not "everything".

    // The personal folder is set up afterwards: a new engine over both folders.
    const later = createSyncEngine({
      repo: a.repo,
      transports: [
        world.folders.attach(a.deviceId, "gtd"),
        world.folders.attach(a.deviceId, "personal"),
      ],
      profile: "personal",
      now: a.clock.read,
    });
    const status = await a.repo.getSyncStatus();
    expect(status.supported && status.pendingChanges).toBeGreaterThan(0);
    const report = await later.publish();
    expect(report.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "published"],
      ["personal", "published"],
      ["finance", "published"],
    ]);
    expect(report.counterAdvanced).toBe(true);
    expect(world.folders.manifestFor("personal", a.deviceId)?.domains).toHaveProperty("finance");
  });

  it("rejects an unknown device profile", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    expect(() =>
      createSyncEngine({
        repo: world.device("A").repo,
        transports: [],
        profile: "admin" as never,
      }),
    ).toThrow(/Unknown device profile/);
  });
});

describe("a broken settings reader", () => {
  it("does not stop a publish: the manifest says off and the report says why", async () => {
    const world = await createEngineWorld([
      {
        name: "A",
        engine: {
          calendarSyncEnabled: () => {
            throw new Error("settings unreadable");
          },
        },
      },
    ]);
    const a = world.device("A");
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const report = await a.engine.publish();
    expect(report.domains.some((d) => d.outcome === "published")).toBe(true);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "publish_skipped", detail: "settings unreadable" }),
    );
    expect(world.folders.manifestFor("gtd", a.deviceId)?.calendarSyncEnabled).toBe(false);
  });
});
