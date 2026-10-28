// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { createSyncEngine } from "./sync-engine";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
} from "./test-support/engine-harness";

/**
 * Two ways a publish can end up not reaching the other laptops although the engine believes it did:
 * a folder that is missing for a while, and a publish that times out and then completes late.
 */

const engineOver = (world: EngineWorld, device: EngineDevice, roles: ("gtd" | "personal")[]) =>
  createSyncEngine({
    repo: device.repo,
    transports: roles.map((role) => world.folders.attach(device.deviceId, role)),
    profile: "personal",
    now: device.clock.read,
  });

const pending = async (device: EngineDevice): Promise<number> => {
  const status = await device.repo.getSyncStatus();
  return status.supported ? status.pendingChanges : -1;
};

const gtdBundle = (world: EngineWorld, device: EngineDevice): string =>
  world.folders.bundleText("gtd", device.deviceId, "gtd");

describe("a folder that is disconnected for a while", () => {
  it("keeps the changes made in its absence pending, and publishes them when it is reconnected", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
    const [a, b] = [world.device("A"), world.device("B")];
    await a.engine.publish();
    await b.engine.syncNow();
    expect(await pending(a)).toBe(0);

    // The personal folder is not connected: an engine with the GTD folder only.
    const gtdOnly = engineOver(world, a, ["gtd"]);
    const entry = createEmptyDailyEntry("2026-10-03");
    entry.morningIntention = "written while the personal folder was away";
    await a.repo.saveDailyEntry(entry);
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const away = await gtdOnly.publish();
    expect(away.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "published"],
      ["personal", "no_transport"],
      ["finance", "no_transport"],
    ]);
    expect(away.counterAdvanced).toBe(false);
    expect(away.issues).toContainEqual(
      expect.objectContaining({ code: "pending_unpublished_domain", severity: "info" }),
    );
    expect(await pending(a)).toBeGreaterThan(0);

    // Publishing again while it is still away does not rewrite the GTD bundle each time.
    const generation = world.folders.manifestFor("gtd", a.deviceId)?.domains.gtd?.generation;
    await gtdOnly.publish();
    expect(world.folders.manifestFor("gtd", a.deviceId)?.domains.gtd?.generation).toBe(generation);

    // Reconnected: its manifest says a bundle exists (ownGeneration is not null), yet the entry is
    // published because the changes were never marked as published.
    const reconnected = engineOver(world, a, ["gtd", "personal"]);
    const back = await reconnected.publish();
    expect(back.domains.find((d) => d.domain === "personal")?.outcome).toBe("published");
    expect(await pending(a)).toBe(0);
    await b.engine.syncNow();
    expect((await b.repo.getDailyEntry("2026-10-03"))?.morningIntention).toBe(
      "written while the personal folder was away",
    );
  });

  it("a work device, which publishes only gtd, never has anything left pending for want of a folder", async () => {
    const world = await createEngineWorld([{ name: "W", profile: "work", roles: ["gtd"] }]);
    const w = world.device("W");
    await w.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const report = await w.engine.publish();
    expect(report.counterAdvanced).toBe(true);
    expect(report.issues).toEqual([]);
    expect(await pending(w)).toBe(0);
  });
});

describe("a publish that times out and completes late", () => {
  /** A gtd publish that is held open until `release()`; later ones go through. */
  const holdFirstGtdPublish = (world: EngineWorld) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    world.folders.onOperation("gtd", "publish", () => {
      if (held) return undefined;
      held = true;
      return gate;
    });
    return {
      release: async () => {
        release();
        // Let the abandoned operation run to its end.
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    };
  };

  const scenario = async (fencing: boolean) => {
    const world = await createEngineWorld([{ name: "A", engine: { transportTimeoutMs: 30 } }]);
    const a = world.device("A");
    world.folders.setFencing(fencing);
    await a.repo.createTask({ id: "old", title: "Old", bucket: "inbox" });
    const hold = holdFirstGtdPublish(world);

    const timedOut = await a.engine.publish();
    expect(timedOut.domains.find((d) => d.domain === "gtd")?.outcome).toBe("failed");
    expect(timedOut.issues.some((issue) => issue.code === "transport_timeout")).toBe(true);

    await a.repo.createTask({ id: "new", title: "New", bucket: "inbox" });
    const retried = await a.engine.publish();
    expect(retried.domains.find((d) => d.domain === "gtd")?.outcome).toBe("published");
    expect(gtdBundle(world, a)).toContain('"new"');
    return { world, a, hold };
  };

  it("a transport that fences the commit refuses the old operation: the newest snapshot stays", async () => {
    const { world, a, hold } = await scenario(true);
    await hold.release();
    expect(gtdBundle(world, a)).toContain('"new"');
    const next = await a.engine.publish();
    expect(gtdBundle(world, a)).toContain('"new"');
    expect(next.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
  });

  it("a transport that does not fence: the late commit rolls the folder back, and the next publish repairs it", async () => {
    const { world, a, hold } = await scenario(false);
    await hold.release();
    // The old operation committed its old snapshot over the newer one ...
    expect(gtdBundle(world, a)).not.toContain('"new"');
    // ... the engine noticed it settle late and owes a republish, durably.
    expect(await pending(a)).toBeGreaterThan(0);
    const repair = await a.engine.publish();
    expect(repair.domains.find((d) => d.domain === "gtd")?.outcome).toBe("published");
    expect(gtdBundle(world, a)).toContain('"new"');
    expect(await pending(a)).toBe(0);
  });

  it("a publish that fails late is repaired the same way", async () => {
    const world = await createEngineWorld([{ name: "A", engine: { transportTimeoutMs: 30 } }]);
    const a = world.device("A");
    world.folders.setFencing(false);
    await a.repo.createTask({ id: "old", title: "Old", bucket: "inbox" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    world.folders.onOperation("gtd", "publish", () => {
      if (held) return undefined;
      held = true;
      return gate.then(() => {
        throw new Error("the folder went away mid-write");
      });
    });
    await a.engine.publish();
    await a.repo.createTask({ id: "new", title: "New", bucket: "inbox" });
    await a.engine.publish();
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await pending(a)).toBeGreaterThan(0);
    await a.engine.publish();
    expect(gtdBundle(world, a)).toContain('"new"');
  });
});
