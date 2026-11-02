// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { PUBLISH_HEARTBEAT_MS } from "./engine-publish";
import { createEngineWorld, type EngineDevice } from "./test-support/engine-harness";

/**
 * Per-domain change detection (migration 47) and the one-time first-merge backup: what an automatic
 * publish costs after a small edit, and that a first merge spread over several pulls is backed up once.
 */

const snapshotsRead = (device: EngineDevice): string[] =>
  device.calls
    .filter((call) => call.method === "readSyncSnapshot")
    .map((call) => String(call.domain));

const outcomes = (report: { domains: { domain: string; outcome: string }[] }) =>
  Object.fromEntries(report.domains.map((item) => [item.domain, item.outcome]));

const pending = async (device: EngineDevice): Promise<number> => {
  const status = await device.repo.getSyncStatus();
  return status.supported ? status.pendingChanges : -1;
};

const counters = async (device: EngineDevice) => {
  const read = await device.repo.readSyncPublishCounters();
  if (read === null) throw new Error("no identity");
  return read;
};

describe("per-domain change detection", () => {
  it("a task edit rebuilds the gtd bundle only, not personal or finance", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    expect(await pending(a)).toBe(0);
    a.calls.length = 0;

    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const report = await a.engine.publish();
    expect(snapshotsRead(a)).toEqual(["gtd"]);
    expect(outcomes(report)).toEqual({ gtd: "published", personal: "clean", finance: "clean" });
    expect(report.counterAdvanced).toBe(true);
    expect(await pending(a)).toBe(0);
  });

  it("a journal edit rebuilds the personal bundle only", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    a.calls.length = 0;

    const entry = createEmptyDailyEntry("2026-10-03");
    entry.morningIntention = "calm";
    await a.repo.saveDailyEntry(entry);
    const report = await a.engine.publish();
    expect(snapshotsRead(a)).toEqual(["personal"]);
    expect(outcomes(report)).toEqual({ gtd: "clean", personal: "published", finance: "clean" });
    expect(await pending(a)).toBe(0);
  });

  it("a grow-only event (union table) moves its own domain's counter", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await a.engine.publish();
    const before = await counters(a);
    // Completing a task writes a `gtd_task_events` row (union table, counted by its own trigger).
    await a.repo.completeTask("t1");
    const after = await counters(a);
    expect(after.changeCounter).toBeGreaterThan(before.changeCounter);
    expect(after.domainChangedAt.gtd).toBe(after.changeCounter);
    expect(after.domainChangedAt.personal).toBe(before.domainChangedAt.personal);
    expect(after.domainChangedAt.finance).toBe(before.domainChangedAt.finance);
  });

  it("every counter bump raises the changed domains to the new global counter", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const afterTask = await counters(a);
    expect(afterTask.domainChangedAt.gtd).toBe(afterTask.changeCounter);
    const entry = createEmptyDailyEntry("2026-10-03");
    entry.morningIntention = "x";
    await a.repo.saveDailyEntry(entry);
    const afterEntry = await counters(a);
    expect(afterEntry.domainChangedAt.personal).toBe(afterEntry.changeCounter);
    expect(afterEntry.domainChangedAt.gtd).toBe(afterTask.domainChangedAt.gtd);
  });

  it("a shared setting raises the counter of the domain its key belongs to; a device setting raises none", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    const before = await counters(a);

    await a.repo.updateSettings((current) => ({
      ...current,
      lastBackupAt: "2026-10-01T00:00:00Z",
    }));
    expect(await counters(a)).toEqual(before);

    await a.repo.updateSettings((current) => ({ ...current, aiModel: "another/model" }));
    const personal = await counters(a);
    expect(personal.changeCounter).toBeGreaterThan(before.changeCounter);
    expect(personal.domainChangedAt.personal).toBe(personal.changeCounter);
    expect(personal.domainChangedAt.gtd).toBe(before.domainChangedAt.gtd);

    await a.repo.updateSettings((current) => ({
      ...current,
      gtdImportDoneAt: "2026-10-01T00:00:00Z",
    }));
    const gtd = await counters(a);
    expect(gtd.domainChangedAt.gtd).toBe(gtd.changeCounter);
    expect(gtd.domainChangedAt.personal).toBe(personal.domainChangedAt.personal);
  });

  it("merging a peer's gtd bundle makes only gtd pending for the republish", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
    const [a, b] = [world.device("A"), world.device("B")];
    await a.engine.publish();
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(await pending(a)).toBe(0);

    await b.repo.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await b.engine.publish();
    a.calls.length = 0;
    await a.engine.pull();
    expect(await pending(a)).toBeGreaterThan(0);
    const published = await a.engine.publish();
    expect(snapshotsRead(a)).toEqual(["gtd"]);
    expect(outcomes(published).personal).toBe("clean");
    expect(outcomes(published).finance).toBe("clean");
    expect(await pending(a)).toBe(0);
  });

  it("queueSyncRepublish makes every domain pending again", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    await a.repo.queueSyncRepublish();
    a.calls.length = 0;
    await a.engine.publish();
    expect(snapshotsRead(a).sort()).toEqual(["finance", "gtd", "personal"]);
  });

  it("an unchanged domain still counts as covered, so the counter advances to the global value", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const before = await counters(a);
    await a.engine.publish();
    const after = await counters(a);
    expect(after.lastPublishCounter).toBe(before.changeCounter);
  });

  it("an engine that restarts publishes only what changed since the recorded publish", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    // A new engine instance has no memory of what the previous one wrote.
    const { createSyncEngine } = await import("./sync-engine");
    const restarted = createSyncEngine({
      repo: a.repo,
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    const spy: string[] = [];
    const original = a.repo.readSyncSnapshot.bind(a.repo);
    a.repo.readSyncSnapshot = (domain) => {
      spy.push(domain);
      return original(domain);
    };
    await restarted.publish();
    expect(spy).toEqual(["gtd"]);
  });
});

describe("the manifest heartbeat", () => {
  const DAY = 24 * 60 * 60_000;

  it("rewrites a folder's untouched manifest once it is older than the heartbeat, then leaves it", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.engine.publish();
    const writtenBefore = world.folders.manifestFor("personal", a.deviceId)?.writtenAt;

    a.clock.advance(PUBLISH_HEARTBEAT_MS + DAY);
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    a.calls.length = 0;
    await a.engine.publish();
    // The gtd bundle changed; the personal folder's manifest was a month old, so its first domain was
    // rewritten as a heartbeat (and only that one: they share the manifest).
    expect(snapshotsRead(a)).toEqual(["gtd", "personal"]);
    const writtenAfter = world.folders.manifestFor("personal", a.deviceId)?.writtenAt;
    expect(Date.parse(writtenAfter ?? "")).toBeGreaterThan(Date.parse(writtenBefore ?? ""));

    a.calls.length = 0;
    a.clock.advance(60_000);
    await a.repo.createTask({ id: "t2", title: "Again", bucket: "inbox" });
    await a.engine.publish();
    expect(snapshotsRead(a)).toEqual(["gtd"]);
  });
});

describe("the first-merge safety backup", () => {
  const LIMITS = { maxEntities: 5, maxUnionRows: 5, maxAliases: 5, maxSidecarRows: 5 };

  const seed = async (backups: string[], failFirst = false) => {
    let failed = !failFirst;
    const world = await createEngineWorld([
      {
        name: "A",
        engine: {
          applyLimits: LIMITS,
          yieldBetweenChunks: async () => undefined,
          beforeFirstMerge: async () => {
            if (!failed) {
              failed = true;
              throw new Error("backup folder missing");
            }
            backups.push("backup");
            return { path: `memory://backup/${backups.length}` };
          },
        },
      },
      { name: "B" },
    ]);
    const [a, b] = [world.device("A"), world.device("B")];
    for (let i = 0; i < 24; i += 1) {
      await b.repo.createTask({ id: `b-${i}`, title: `B${i}`, bucket: "inbox" });
    }
    await b.engine.publish();
    return { world, a, b };
  };

  it("is taken once over several budget-limited pulls, and remembered", async () => {
    const backups: string[] = [];
    const { world, a } = await seed(backups);
    world.folders.onOperation("gtd", "readBundle", () => a.clock.advance(10_000));
    let pulls = 0;
    for (; pulls < 40; pulls += 1) {
      const pull = await a.engine.pull({ budgetMs: 1_000 });
      if (pull.complete) break;
    }
    expect(pulls).toBeGreaterThan(1);
    expect(backups).toHaveLength(1);
    const status = await a.repo.getSyncStatus();
    expect(status.supported && status.firstMergeBackupPath).toBe("memory://backup/1");
  });

  it("is not taken again by a restarted engine while the first bundle is still incomplete", async () => {
    const backups: string[] = [];
    const { world, a } = await seed(backups);
    world.folders.onOperation("gtd", "readBundle", () => a.clock.advance(10_000));
    const first = await a.engine.pull({ budgetMs: 1_000 });
    expect(first.complete).toBe(false);
    expect(backups).toHaveLength(1);

    const { createSyncEngine } = await import("./sync-engine");
    const restarted = createSyncEngine({
      repo: a.repo,
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
      applyLimits: LIMITS,
      yieldBetweenChunks: async () => undefined,
      beforeFirstMerge: async () => {
        backups.push("backup");
        return { path: "memory://backup/again" };
      },
    });
    const second = await restarted.pull();
    expect(second.complete).toBe(true);
    expect(backups).toHaveLength(1);
    expect(second.safetyBackup.status).toBe("not_needed");
  });

  it("a backup that failed is not remembered: the next pull tries again, and merges nothing meanwhile", async () => {
    const backups: string[] = [];
    const { a } = await seed(backups, true);
    const first = await a.engine.pull();
    expect(first.safetyBackup.status).toBe("failed");
    expect(first.totals.bundlesApplied).toBe(0);
    const status = await a.repo.getSyncStatus();
    expect(status.supported && status.firstMergeBackupPath).toBeNull();
    const second = await a.engine.pull();
    expect(second.safetyBackup.status).toBe("taken");
    expect(backups).toHaveLength(1);
  });

  it("a verified empty joiner records nothing", async () => {
    const backups: string[] = [];
    const { a } = await seed(backups);
    const pull = await a.engine.pull({ verifiedEmptyJoiner: true });
    expect(pull.safetyBackup.status).toBe("skipped_empty_joiner");
    expect(backups).toEqual([]);
    const status = await a.repo.getSyncStatus();
    expect(status.supported && status.firstMergeBackupPath).toBeNull();
  });
});

describe("an idle automatic cycle writes nothing", () => {
  it("startup generators that find nothing to do leave every counter where it was", async () => {
    const world = await createEngineWorld([{ name: "A" }]);
    const a = world.device("A");
    await a.repo.reconcileDay("2026-11-02");
    await a.repo.generateDailyRelationshipTasks("2026-11-02");
    await a.engine.publish();
    const before = await counters(a);

    // The second day-start of the same day: due recurrences, promotion, carryover, draws.
    await a.repo.reconcileDay("2026-11-02");
    await a.repo.generateDailyRelationshipTasks("2026-11-02");
    await a.repo.generateDueRecurringTasks("2026-11-02");
    expect(await counters(a)).toEqual(before);
  });

  it("a pull of unchanged manifests and a publish with nothing pending write nothing", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
    const [a, b] = [world.device("A"), world.device("B")];
    await b.repo.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    await b.engine.syncNow();
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();
    const before = await counters(a);

    a.calls.length = 0;
    const pull = await a.engine.pull();
    const publish = await a.engine.publish();
    expect(pull.totals.bundlesApplied).toBe(0);
    expect(publish.domains.every((item) => item.outcome === "clean")).toBe(true);
    expect(a.calls).toEqual([]);
    expect(await counters(a)).toEqual(before);
  });
});
