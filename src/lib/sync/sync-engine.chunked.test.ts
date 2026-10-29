// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEngineWorld, type EngineDevice } from "./test-support/engine-harness";

/**
 * A large incoming bundle goes through the engine as several writer slots: the peer's hash is
 * recorded only after the LAST one, a failure or a budget stop in the middle keeps a valid database
 * and the next pull finishes the job, the safety backup precedes the first piece only.
 */

const LIMITS = { maxEntities: 5, maxUnionRows: 5, maxAliases: 5, maxSidecarRows: 5 };

const world = async (events?: string[]) => {
  const w = await createEngineWorld([
    {
      name: "A",
      engine: {
        applyLimits: LIMITS,
        yieldBetweenChunks: async () => undefined,
        beforeFirstMerge: async () => {
          events?.push("backup");
          return { path: "memory://backup/A" };
        },
      },
    },
    { name: "B" },
  ]);
  const a = w.device("A");
  const b = w.device("B");
  for (let i = 0; i < 24; i += 1) {
    await b.repo.createTask({
      id: `b-${String(i).padStart(2, "0")}`,
      title: `B${i}`,
      bucket: "inbox",
    });
  }
  await b.engine.publish();
  return { w, a, b };
};

const taskCount = async (device: EngineDevice) =>
  (await device.repo.listTasks({ includeCompleted: true })).filter((task) =>
    task.id.startsWith("b-"),
  ).length;

const appliedShas = async (device: EngineDevice, peerId: string) => {
  const status = await device.repo.getSyncStatus();
  return status.supported
    ? (status.peers.find((peer) => peer.peerId === peerId)?.lastAppliedShaByDomain ?? {})
    : {};
};

const applyCalls = (device: EngineDevice) =>
  device.calls.filter((call) => call.method === "applySyncBundle" && call.domain === "gtd").length;

describe("a large bundle through the engine", () => {
  it("applies it as several slots and reports them, recording the hash once", async () => {
    const { a, b } = await world();
    const pull = await a.engine.pull();
    expect(pull.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(pull.complete).toBe(true);
    expect(await taskCount(a)).toBe(24);
    const gtd = pull.peers[0]?.domains.find((domain) => domain.domain === "gtd");
    expect(gtd?.outcome).toBe("applied");
    expect(gtd?.chunks?.total).toBeGreaterThan(3);
    expect(gtd?.chunks?.applied).toBe(gtd?.chunks?.total);
    expect(pull.totals.chunksApplied).toBeGreaterThanOrEqual(gtd?.chunks?.total ?? 0);
    expect(pull.totals.bundlesApplied).toBe(
      pull.peers.flatMap((peer) => peer.domains).filter((d) => d.outcome === "applied").length,
    );
    expect(Object.keys(await appliedShas(a, b.deviceId))).toContain("gtd");
    // The same bundle again is the cheap path: nothing is read, nothing applied.
    const before = applyCalls(a);
    await a.engine.pull();
    expect(applyCalls(a)).toBe(before);
  });

  it("applies a small bundle in a single call, as before", async () => {
    const { a, b } = await world();
    await b.repo.createTask({ id: "small", title: "small", bucket: "inbox" });
    const a2 = await createEngineWorld([{ name: "X" }, { name: "Y" }]);
    const y = a2.device("Y");
    await y.repo.createTask({ id: "only", title: "only", bucket: "inbox" });
    await y.engine.publish();
    const x = a2.device("X");
    await x.engine.pull();
    expect(applyCalls(x)).toBe(1);
    expect(a).toBeDefined();
  });

  it("keeps a valid state when a piece fails, records nothing, and finishes on the next pull", async () => {
    const { a, b } = await world();
    const original = a.repo.applySyncBundle.bind(a.repo);
    let calls = 0;
    let failing = true;
    a.repo.applySyncBundle = async (...args) => {
      calls += 1;
      if (failing && calls === 3) throw new Error("disk full");
      return original(...args);
    };
    const first = await a.engine.pull();
    const gtd = first.peers[0]?.domains.find((domain) => domain.domain === "gtd");
    expect(gtd?.outcome).toBe("rejected");
    const issue = first.issues.find((item) => item.domain === "gtd");
    expect(issue?.code).toBe("bundle_partially_merged");
    expect(issue?.progress).toEqual({ kept: 2, total: expect.any(Number) });
    expect(gtd?.partial).toEqual({ kept: 2, total: issue?.progress?.total });
    expect(gtd?.chunks?.applied).toBe(2);
    expect(issue?.message).toMatch(/part 3 of \d+/);
    expect(issue?.message).toMatch(/2 earlier part\(s\) were kept/);
    // Two pieces are in; the hash of the bundle is NOT recorded; the database is consistent.
    expect(await taskCount(a)).toBeGreaterThan(0);
    expect(await taskCount(a)).toBeLessThan(24);
    expect(Object.keys(await appliedShas(a, b.deviceId))).not.toContain("gtd");
    expect(await a.db.select("PRAGMA foreign_key_check")).toEqual([]);
    // Only the personal and finance bundles (one piece each) counted as applied; gtd did not.
    expect(first.totals.bundlesApplied).toBe(2);
    expect(first.totals.chunksApplied).toBe(2 + 2);

    failing = false;
    const second = await a.engine.pull();
    expect(second.issues.filter((item) => item.severity === "error")).toEqual([]);
    expect(await taskCount(a)).toBe(24);
    expect(Object.keys(await appliedShas(a, b.deviceId))).toContain("gtd");
  });

  it("does not record the hash while any piece is left, even when the last one is the one that fails", async () => {
    const { a, b } = await world();
    const original = a.repo.applySyncBundle.bind(a.repo);
    const plan = await b.repo.listSyncChanges("gtd");
    const total = Math.ceil(plan.entities.length / LIMITS.maxEntities);
    expect(total).toBeGreaterThan(3);
    let calls = 0;
    a.repo.applySyncBundle = async (domain, changeSet, options) => {
      calls += 1;
      if (domain === "gtd" && calls >= 4 && changeSet.entities.length > 0 && calls > 4) {
        throw new Error("late failure");
      }
      return original(domain, changeSet, options);
    };
    const pull = await a.engine.pull();
    expect(pull.complete).toBe(true); // nothing deferred: it failed, not out of budget
    expect(pull.peers[0]?.domains.find((d) => d.domain === "gtd")?.outcome).toBe("rejected");
    expect(Object.keys(await appliedShas(a, b.deviceId))).not.toContain("gtd");
  });

  it("stops between pieces when the budget runs out, keeps them, and the next pull continues from there", async () => {
    const { w, a } = await world();
    const original = a.repo.applySyncBundle.bind(a.repo);
    let applyCallsSoFar = 0;
    a.repo.applySyncBundle = async (...args) => {
      applyCallsSoFar += 1;
      const result = await original(...args);
      // Each piece "takes" two seconds on the engine's clock.
      a.clock.advance(2_000);
      return result;
    };
    // The read itself takes no time; the budget (5 s) is spent after three pieces.
    const first = await a.engine.pull({ budgetMs: 5_000 });
    const gtd = first.peers[0]?.domains.find((domain) => domain.domain === "gtd");
    expect(gtd?.outcome).toBe("deferred");
    expect(first.complete).toBe(false);
    expect(first.remaining.some((item) => item.domain === "gtd")).toBe(true);
    expect(gtd?.chunks?.applied).toBe(3);
    expect(await taskCount(a)).toBeLessThan(24);
    // A bundle cut between its chunks is a peer that still has work for us, never "synced".
    const status = await a.engine.getStatus();
    expect(status.peers.find((peer) => peer.peerId === w.device("B").deviceId)?.state).toBe(
      "pending",
    );
    expect(Object.keys(await appliedShas(a, w.device("B").deviceId))).not.toContain("gtd");

    // The (local, bundle) schema pair is recorded with the hash, i.e. not before the last chunk.
    const schemas = async () => {
      const read = await a.repo.getSyncStatus();
      const manifest = read.supported
        ? read.peers.find((peer) => peer.peerId === w.device("B").deviceId)?.lastManifest
        : null;
      return (manifest?.mergedSchemas ?? {}) as Record<string, unknown>;
    };
    expect(Object.keys(await schemas())).not.toContain("gtd");

    const total = gtd?.chunks?.total ?? 0;
    const callsBefore = applyCalls(a);
    const second = await a.engine.pull();
    expect(second.complete).toBe(true);
    // It resumed after the three pieces done, it did not start over.
    expect(applyCalls(a) - callsBefore).toBeLessThan(total);
    expect(await taskCount(a)).toBe(24);
    expect(Object.keys(await appliedShas(a, w.device("B").deviceId))).toContain("gtd");
    expect(Object.keys(await schemas())).toContain("gtd");
    expect(applyCallsSoFar).toBeGreaterThan(total);
  });

  it("applies at least one piece per pull however tight the budget, so it always finishes", async () => {
    const { w, a } = await world();
    // The folder read takes longer than the whole budget.
    w.folders.onOperation("gtd", "readBundle", () => a.clock.advance(10_000));
    let pulls = 0;
    for (; pulls < 40; pulls += 1) {
      const pull = await a.engine.pull({ budgetMs: 1_000 });
      if (pull.complete) break;
      expect(pull.totals.chunksApplied).toBeGreaterThanOrEqual(1);
    }
    expect(pulls).toBeGreaterThan(1);
    expect(pulls).toBeLessThan(40);
    expect(await taskCount(a)).toBe(24);
  });

  it("takes the safety backup once, before the first piece", async () => {
    const events: string[] = [];
    const { a } = await world(events);
    const original = a.repo.applySyncBundle.bind(a.repo);
    a.repo.applySyncBundle = async (...args) => {
      events.push("apply");
      return original(...args);
    };
    const pull = await a.engine.pull();
    expect(pull.safetyBackup.status).toBe("taken");
    expect(events.filter((event) => event === "backup")).toHaveLength(1);
    expect(events[0]).toBe("backup");
    expect(events.filter((event) => event === "apply").length).toBeGreaterThan(3);
  });
});
