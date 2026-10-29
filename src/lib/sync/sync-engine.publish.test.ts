// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { Database } from "../storage/sqlite-db";
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

/**
 * A write transaction whose COMMIT is held and then fails: while it is held, `change_counter` has
 * already been advanced INSIDE the transaction (capture runs before COMMIT) and the shared connection
 * shows that uncommitted value to any read made outside the writer queue; after the failure it rolls
 * back and the counter returns to its committed value.
 */
const holdAndFailCommit = (device: EngineDevice) => {
  const real = device.db;
  let reachedCommit: () => void = () => undefined;
  const atCommit = new Promise<void>((resolve) => {
    reachedCommit = resolve;
  });
  let failCommit: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    failCommit = resolve;
  });
  let armed = true;
  const patched: Database = {
    async execute(query, bindValues) {
      if (armed && query.trim().toUpperCase() === "COMMIT") {
        armed = false;
        reachedCommit();
        await gate;
        throw new Error("simulated COMMIT I/O failure");
      }
      return real.execute(query, bindValues);
    },
    select: (query, bindValues) => real.select(query, bindValues),
  };
  const repo = device.repo as unknown as { dbPromise: Promise<Database> | null };
  const original = repo.dbPromise;
  repo.dbPromise = Promise.resolve(patched);
  return {
    atCommit,
    failCommit,
    restore: () => {
      repo.dbPromise = original;
    },
  };
};

describe("a counter that another write has advanced but not committed", () => {
  it("never decides, caches or marks a publish: a failed overlapping write cannot hide the next edit", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    expect(await pending(a)).toBe(0);

    const hold = holdAndFailCommit(a);
    const failing = a.repo
      .createTask({ id: "rolled-back", title: "Rolled back", bucket: "inbox" })
      .then(
        () => "committed",
        (error: Error) => error.message,
      );
    await hold.atCommit;
    // The transaction has advanced the counter and not committed: a read outside the queue sees it ...
    const outside = await a.repo.getSyncStatus();
    expect(outside.supported && outside.pendingChanges).toBeGreaterThan(0);

    // ... and a publish started now must not act on it.
    const overlapping = a.engine.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold.failCommit();
    expect(await failing).toBe("simulated COMMIT I/O failure");
    hold.restore();
    const first = await overlapping;
    expect(first.domains.every((d) => d.outcome === "clean")).toBe(true);
    expect(await pending(a)).toBe(0);

    // A different task now commits, bringing the committed counter up to the value the rolled-back
    // write had shown: it must still be published.
    await a.repo.createTask({ id: "committed", title: "Committed", bucket: "inbox" });
    expect(await pending(a)).toBeGreaterThan(0);
    const second = await a.engine.publish();
    expect(second.domains.find((d) => d.domain === "gtd")?.outcome).toBe("published");
    expect(gtdBundle(world, a)).toContain('"committed"');
    expect(gtdBundle(world, a)).not.toContain('"rolled-back"');
    expect(await pending(a)).toBe(0);
  });

  it("the counters the engine reads wait for the writer and return the committed values", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    const committed = await a.repo.readSyncPublishCounters();
    const hold = holdAndFailCommit(a);
    const failing = a.repo
      .createTask({ id: "rolled-back", title: "Rolled back", bucket: "inbox" })
      .catch(() => "failed");
    await hold.atCommit;
    const counters = a.repo.readSyncPublishCounters();
    const snapshot = a.repo.readSyncSnapshot("gtd");
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold.failCommit();
    await failing;
    hold.restore();
    expect(await counters).toEqual(committed);
    const read = await snapshot;
    expect(read.changeCounter).toBe(committed?.changeCounter);
    expect(JSON.stringify(read.changeSet)).not.toContain("rolled-back");
  });

  it("an edit that commits while a bundle is written stays pending; the covered counter is the smallest", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "before", title: "Before", bucket: "inbox" });
    // The edit lands after the gtd snapshot was taken but before the personal one.
    world.folders.onOperation("gtd", "publish", async () => {
      world.folders.onOperation("gtd", "publish", undefined);
      await a.repo.createTask({ id: "during", title: "During", bucket: "inbox" });
    });
    const report = await a.engine.publish();
    expect(report.counterAdvanced).toBe(true);
    // gtd's snapshot does not contain it, so it must still be owed ...
    expect(gtdBundle(world, a)).not.toContain('"during"');
    expect(await pending(a)).toBeGreaterThan(0);
    // ... and the next publish carries it.
    await a.engine.publish();
    expect(gtdBundle(world, a)).toContain('"during"');
    expect(await pending(a)).toBe(0);
  });

  it("an edit that commits between the counters read and the snapshot is covered by the snapshot, exactly", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "before", title: "Before", bucket: "inbox" });
    let injected = false;
    const engine = createSyncEngine({
      repo: {
        getSyncStatus: () => a.repo.getSyncStatus(),
        readSyncSnapshot: (domain) => a.repo.readSyncSnapshot(domain),
        applySyncBundle: (domain, changeSet, options) =>
          a.repo.applySyncBundle(domain, changeSet, options),
        recordSyncPeerApplied: (input) => a.repo.recordSyncPeerApplied(input),
        markSyncPublished: (counter) => a.repo.markSyncPublished(counter),
        queueSyncRepublish: () => a.repo.queueSyncRepublish(),
        readSyncPublishCounters: async () => {
          const counters = await a.repo.readSyncPublishCounters();
          if (!injected) {
            injected = true;
            await a.repo.createTask({ id: "between", title: "Between", bucket: "inbox" });
          }
          return counters;
        },
      },
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    // The personal folder is away, so the first run is partial: gtd is written, the rest is not.
    world.folders.setMode("personal", "unreachable");
    const first = await engine.publish();
    expect(first.domains.find((d) => d.domain === "gtd")?.outcome).toBe("published");
    expect(gtdBundle(world, a)).toContain('"between"');
    expect(first.counterAdvanced).toBe(false);

    // The retry does not rewrite gtd: its snapshot covers the counter as it stands now.
    world.folders.setMode("personal", "up");
    const second = await engine.publish();
    expect(second.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "clean"],
      ["personal", "published"],
      ["finance", "published"],
    ]);
    // And what was published is recorded exactly: nothing spuriously left pending.
    expect(second.counterAdvanced).toBe(true);
    expect(await pending(a)).toBe(0);
  });

  it("records the covered counter when every domain succeeds: nothing is left pending for an edit the snapshot holds", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "before", title: "Before", bucket: "inbox" });
    let injected = false;
    const engine = createSyncEngine({
      repo: {
        getSyncStatus: () => a.repo.getSyncStatus(),
        readSyncSnapshot: (domain) => a.repo.readSyncSnapshot(domain),
        applySyncBundle: (domain, changeSet, options) =>
          a.repo.applySyncBundle(domain, changeSet, options),
        recordSyncPeerApplied: (input) => a.repo.recordSyncPeerApplied(input),
        markSyncPublished: (counter) => a.repo.markSyncPublished(counter),
        queueSyncRepublish: () => a.repo.queueSyncRepublish(),
        readSyncPublishCounters: async () => {
          const counters = await a.repo.readSyncPublishCounters();
          if (!injected) {
            injected = true;
            await a.repo.createTask({ id: "between", title: "Between", bucket: "inbox" });
          }
          return counters;
        },
      },
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    const report = await engine.publish();
    expect(report.counterAdvanced).toBe(true);
    expect(gtdBundle(world, a)).toContain('"between"');
    expect(await pending(a)).toBe(0);
  });

  it("a domain that is clean from the in-process cache still counts at its covered counter: an edit it lacks stays owed", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    let inject = false;
    const engine = createSyncEngine({
      repo: {
        getSyncStatus: () => a.repo.getSyncStatus(),
        readSyncPublishCounters: () => a.repo.readSyncPublishCounters(),
        // A gtd edit commits after the counters were read and gtd was found clean, but before the
        // personal snapshot is taken: the personal snapshot covers a newer counter than gtd's bundle.
        readSyncSnapshot: async (domain) => {
          if (inject && domain === "personal") {
            inject = false;
            await a.repo.createTask({ id: "sneaky", title: "Sneaky", bucket: "inbox" });
          }
          return a.repo.readSyncSnapshot(domain);
        },
        applySyncBundle: (domain, changeSet, options) =>
          a.repo.applySyncBundle(domain, changeSet, options),
        recordSyncPeerApplied: (input) => a.repo.recordSyncPeerApplied(input),
        markSyncPublished: (counter) => a.repo.markSyncPublished(counter),
        queueSyncRepublish: () => a.repo.queueSyncRepublish(),
      },
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    await a.repo.createTask({ id: "t0", title: "T0", bucket: "inbox" });
    // Run 1: gtd is published, the personal folder is away, so nothing is marked and gtd is cached.
    world.folders.setMode("personal", "unreachable");
    await engine.publish();
    world.folders.setMode("personal", "up");

    // Run 2: gtd is clean from the cache; personal and finance are published after the edit.
    inject = true;
    const second = await engine.publish();
    expect(second.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "clean"],
      ["personal", "published"],
      ["finance", "published"],
    ]);
    expect(gtdBundle(world, a)).not.toContain('"sneaky"');
    // The mark is the smallest covered counter (gtd's), so the gtd edit is still owed ...
    expect(await pending(a)).toBeGreaterThan(0);
    // ... and the next publish carries it.
    await engine.publish();
    expect(gtdBundle(world, a)).toContain('"sneaky"');
    expect(await pending(a)).toBe(0);
  });
});
