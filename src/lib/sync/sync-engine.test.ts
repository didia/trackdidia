// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { RecurringTaskTemplate, Task } from "../../domain/types";
import { readIdentity, syncState } from "./capture-test-utils";
import { createSyncEngine } from "./sync-engine";
import { type EngineDevice, createEngineWorld, settleWorld } from "./test-support/engine-harness";
import { aiMessage } from "./test-support/personal-fixtures";
import { readConflicts } from "./test-support/two-device-harness";

/**
 * The spec's engine scenarios ("Verification", `sync-engine.test.ts`), run through the real engine,
 * the real repositories (in-memory SQLite, real capture triggers, foreign keys on) and the in-memory
 * folders. Faults, gates, budgets and isolation have their own files.
 */

const findTask = async (device: EngineDevice, id: string): Promise<Task> => {
  const found = (await device.repo.listTasks({ includeCompleted: true })).find(
    (task) => task.id === id,
  );
  if (!found) throw new Error(`task ${id} not found on ${device.name}`);
  return found;
};

const taskIds = async (device: EngineDevice): Promise<string[]> =>
  (await device.repo.listTasks({ includeCompleted: true })).map((task) => task.id).sort();

const editTask = async (device: EngineDevice, id: string, patch: Partial<Task>) =>
  device.repo.saveTask({ ...(await findTask(device, id)), ...patch });

const twoDevices = async () => {
  const world = await createEngineWorld([{ name: "A" }, { name: "B" }]);
  return { world, a: world.device("A"), b: world.device("B") };
};

const settle = settleWorld;

const template: RecurringTaskTemplate = {
  id: "recurring-template:daily",
  title: "Daily habit",
  notes: "",
  targetBucket: "next_action",
  contextIds: [],
  projectId: null,
  ruleType: "daily",
  dailyInterval: 1,
  weeklyInterval: 1,
  weeklyDays: [0],
  monthlyMode: "day_of_month",
  dayOfMonth: 1,
  nthWeek: 1,
  weekday: 6,
  scheduledTime: null,
  startDate: "2026-10-01",
  status: "active",
  lastGeneratedForDate: null,
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("edits across the folder", () => {
  it("an edit made on B while A is closed reaches A when A pulls at start", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);

    // A is closed from here on.
    b.clock.advance(60_000);
    await editTask(b, "t1", { title: "Plan v2" });
    await b.repo.createTask({ id: "t2", title: "From B", bucket: "next_action" });
    await b.engine.syncNow();

    // A starts: its pull comes first.
    a.clock.advance(120_000);
    const pull = await a.engine.pull();
    expect(pull.complete).toBe(true);
    expect(pull.totals.bundlesApplied).toBeGreaterThan(0);
    expect((await findTask(a, "t1")).title).toBe("Plan v2");
    expect(await taskIds(a)).toEqual(["t1", "t2"]);
    expect(await readConflicts(a)).toEqual([]);
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("concurrent edits to different fields of one task both survive", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", notes: "", bucket: "inbox" });
    await settle(world);

    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "Title from A" });
    b.clock.advance(2_000);
    await editTask(b, "t1", { notes: "Notes from B" });
    await settle(world);

    for (const device of [a, b]) {
      expect(await findTask(device, "t1")).toMatchObject({
        title: "Title from A",
        notes: "Notes from B",
      });
      expect(await readConflicts(device)).toEqual([]);
    }
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("an edit of the same field on both: the later wins and the loser is logged", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);

    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "From A" });
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "From B (later)" });
    await settle(world);

    for (const device of [a, b])
      expect((await findTask(device, "t1")).title).toBe("From B (later)");
    const lost = (await readConflicts(a)).filter((row) => row.kind === "overwritten_edit");
    expect(lost).toHaveLength(1);
    expect(String(lost[0]?.local_json)).toContain("From A");
    expect((await readConflicts(b)).filter((row) => row.kind === "overwritten_edit")).toEqual([]);
  });

  it("delete on A and edit on B: the edit resurrects the task", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);

    a.clock.advance(1_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    await a.stamp();
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "Edited after the delete" });
    await settle(world);

    for (const device of [a, b]) {
      expect(await taskIds(device)).toEqual(["t1"]);
      expect((await findTask(device, "t1")).title).toBe("Edited after the delete");
    }
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("delete on A, then B pulls: the task is gone", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await a.repo.createTask({ id: "t2", title: "Keep", bucket: "inbox" });
    await settle(world);

    a.clock.advance(1_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    await a.stamp();
    await a.engine.publish();
    b.clock.advance(2_000);
    await b.engine.pull();

    expect(await taskIds(b)).toEqual(["t2"]);
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("complete on A and cancel on B: a terminal_divergence conflict for the user", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await settle(world);

    a.clock.advance(1_000);
    await a.repo.completeTask("t1", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5_000);
    await b.repo.cancelTask("t1");
    await settle(world);

    const statuses = [(await findTask(a, "t1")).status, (await findTask(b, "t1")).status];
    expect(statuses[0]).toBe(statuses[1]);
    for (const device of [a, b]) {
      const divergences = (await readConflicts(device)).filter(
        (row) => row.kind === "terminal_divergence",
      );
      expect(divergences).toHaveLength(1);
      expect(divergences[0]).toMatchObject({ entity_type: "gtd_tasks", entity_id: "t1" });
    }
    await world.sim.expectConverged("gtd", { snapshots: true });
  });
});

describe("generators on several laptops", () => {
  it("both laptops generate today's recurrence and draw: no duplicates after the sync", async () => {
    const { world, a, b } = await twoDevices();
    for (const device of [a, b]) {
      await device.repo.updateSettings((current) => ({
        ...current,
        relationshipDrawsEnabled: true,
        relationshipDrawChildrenActivities: ["jouer", "lire"],
        relationshipDrawSpouseActivities: ["diner", "marcher"],
      }));
    }
    await a.repo.saveRecurringTaskTemplate(template);
    await settle(world);

    // Offline day: both laptops run their startup generators for the same day.
    const today = "2026-10-05";
    for (const device of [a, b]) {
      device.clock.advance(60_000);
      await device.repo.generateDueRecurringTasks(today);
      await device.repo.generateDailyRelationshipTasks(today);
    }
    await settle(world);

    for (const device of [a, b]) {
      const tasks = await device.repo.listTasks({ includeCompleted: true });
      expect(tasks.filter((task) => task.recurringTemplateId === template.id)).toHaveLength(1);
      expect(
        tasks.filter((task) => task.sourceExternalId?.startsWith("relationship-draw:")),
      ).toHaveLength(2);
      const aliases = await device.db.select("SELECT * FROM sync_id_aliases");
      expect(aliases).toEqual([]);
    }
    await world.sim.expectConverged("gtd", { snapshots: true });
  });
});

describe("Pomodoro", () => {
  it("a running timer is never published, B's own timer is untouched, a finished session is shared", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await settle(world);

    const startedA = await a.repo.startPomodoro({ kind: "focus", taskId: "t1" });
    const sessionA = startedA.activeSession?.id as string;
    const startedB = await b.repo.startPomodoro({ kind: "focus", taskId: null });
    const sessionB = startedB.activeSession?.id as string;
    await a.engine.syncNow();
    await b.engine.syncNow();
    await a.engine.syncNow();

    // Neither running timer left its laptop, and each is still running where it started.
    for (const text of world.folders.filesOf("gtd").map((file) => file.content)) {
      expect(text).not.toContain(sessionA);
      expect(text).not.toContain(sessionB);
    }
    expect((await b.repo.getPomodoroState()).activeSession?.id).toBe(sessionB);
    expect((await a.repo.getPomodoroState()).activeSession?.id).toBe(sessionA);

    // Finishing A's session publishes it (and not B's).
    a.clock.advance(600_000);
    await a.repo.stopPomodoroSession(sessionA, "completed");
    await a.engine.syncNow();
    b.clock.advance(600_000);
    await b.engine.pull();
    expect((await b.repo.getPomodoroState()).activeSession?.id).toBe(sessionB);
    const known = (await b.db.select<{ id: string }[]>("SELECT id FROM pomodoro_sessions")).map(
      (session) => session.id,
    );
    expect(known).toContain(sessionA);
  });
});

describe("a long solo stretch", () => {
  it("three days of single-laptop use, then the other laptop merges everything", async () => {
    const { world, a, b } = await twoDevices();
    await settle(world);
    // Three days on A while B is closed.
    for (let day = 1; day <= 3; day += 1) {
      a.clock.advance(24 * 60 * 60_000);
      await a.repo.createTask({ id: `day${day}-a`, title: `Day ${day} A`, bucket: "next_action" });
      await a.repo.createTask({ id: `day${day}-b`, title: `Day ${day} B`, bucket: "inbox" });
      await a.repo.completeTask(`day${day}-a`, new Date(a.clock.now).toISOString());
      const entry = createEmptyDailyEntry(`2026-10-0${day + 1}`);
      entry.morningIntention = `Intention ${day}`;
      await a.repo.saveDailyEntry(entry);
      await a.engine.syncNow(); // debounced publishes along the way
    }
    b.clock.advance(3 * 24 * 60 * 60_000 + 60_000);
    const report = await b.engine.syncNow();
    expect(report.pull.complete).toBe(true);
    expect(await taskIds(b)).toEqual(await taskIds(a));
    expect((await b.repo.getDailyEntry("2026-10-03"))?.morningIntention).toBe("Intention 2");
    await world.sim.expectConverged("gtd", { snapshots: true });
    await world.sim.expectConverged("personal", { snapshots: true });
  });
});

describe("pulling and publishing only when something changed", () => {
  it("a pull of unchanged manifests reads no bundle and applies nothing", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);

    world.folders.resetCalls();
    b.calls.length = 0;
    const pull = await b.engine.pull();
    expect(pull.complete).toBe(true);
    expect(pull.totals.bundlesApplied).toBe(0);
    for (const role of ["gtd", "personal"] as const) {
      const counts = world.folders.calls(b.deviceId, role);
      expect(counts.readBundle).toBe(0);
      expect(counts.listPeers).toBe(1);
    }
    expect(b.calls.filter((call) => call.method === "applySyncBundle")).toEqual([]);
    for (const peer of pull.peers) {
      expect(peer.domains.every((domain) => domain.outcome === "unchanged")).toBe(true);
    }
  });

  it("publishes only when something changed; an edit made during the publish stays pending", async () => {
    const { world, a } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const first = await a.engine.publish();
    expect(first.domains.map((domain) => [domain.domain, domain.outcome])).toEqual([
      ["gtd", "published"],
      ["personal", "published"],
      ["finance", "published"],
    ]);
    expect(first.counterAdvanced).toBe(true);
    const status = await a.repo.getSyncStatus();
    expect(status.supported && status.pendingChanges).toBe(0);

    // Nothing changed: nothing is written.
    world.folders.resetCalls();
    a.calls.length = 0;
    const second = await a.engine.publish();
    expect(second.domains.every((domain) => domain.outcome === "clean")).toBe(true);
    expect(world.folders.calls(a.deviceId, "gtd").publish).toBe(0);
    expect(a.calls.filter((call) => call.method === "readSyncSnapshot")).toEqual([]);

    // An edit lands while the gtd bundle is being written.
    await a.repo.createTask({ id: "t2", title: "Before", bucket: "inbox" });
    world.folders.onOperation("gtd", "publish", async () => {
      world.folders.onOperation("gtd", "publish", undefined);
      await a.repo.createTask({ id: "t3", title: "During the publish", bucket: "inbox" });
    });
    const third = await a.engine.publish();
    expect(third.counterAdvanced).toBe(true);
    const during = await a.repo.getSyncStatus();
    expect(during.supported && during.pendingChanges).toBeGreaterThan(0);

    // The next publish carries it, and then the counter is clean.
    const fourth = await a.engine.publish();
    expect(fourth.domains.find((domain) => domain.domain === "gtd")?.outcome).toBe("published");
    const after = await a.repo.getSyncStatus();
    expect(after.supported && after.pendingChanges).toBe(0);
    const bundle = world.folders.bundleText("gtd", a.deviceId, "gtd");
    expect(bundle).toContain("During the publish");
  });

  it("repeated syncNow changes nothing: no rows, no clocks, no dirty marks, no new generation", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await b.repo.createTask({ id: "t2", title: "Other", bucket: "inbox" });
    await settle(world);

    const before = {
      a: await syncState(a.db),
      b: await syncState(b.db),
      generation: world.folders.manifestFor("gtd", a.deviceId)?.domains.gtd?.generation,
    };
    await settle(world);
    expect(await syncState(a.db)).toEqual(before.a);
    expect(await syncState(b.db)).toEqual(before.b);
    expect(world.folders.manifestFor("gtd", a.deviceId)?.domains.gtd?.generation).toBe(
      before.generation,
    );
    expect(await a.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
    expect((await readIdentity(a.db))?.change_counter).toBe(
      (before.a.identity as { change_counter: number }).change_counter,
    );
  });
});

describe("running one operation at a time", () => {
  it("the same kind of run coalesces; a different kind is refused with already_running", async () => {
    const { world, a } = await twoDevices();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.folders.onOperation("gtd", "listPeers", () => gate);

    const first = a.engine.pull();
    const second = a.engine.pull();
    expect(second).toBe(first);
    expect(a.engine.running).toBe("pull");
    await expect(a.engine.publish()).rejects.toMatchObject({ code: "already_running" });
    await expect(a.engine.syncNow()).rejects.toMatchObject({ code: "already_running" });
    release();
    await first;
    expect(a.engine.running).toBeNull();
    await expect(a.engine.publish()).resolves.toBeDefined();
  });
});

describe("status for the sync page", () => {
  it("summarizes each peer after a pull", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);
    const status = await b.engine.getStatus();
    expect(status.ready).toBe(true);
    expect(status.pendingChanges).toBe(0);
    expect(status.peers).toEqual([
      expect.objectContaining({
        peerId: a.deviceId,
        peerName: "A",
        state: "synced",
        schemaVersion: expect.any(Number),
        profile: "personal",
      }),
    ]);
    expect(status.issues).toEqual([]);
  });
});

describe("a merged state is published too", () => {
  const published = (report: { publish: { domains: { outcome: string }[] } }) =>
    report.publish.domains.filter((domain) => domain.outcome === "published").length;

  it("delete on A, edit on B, complete on W: all three agree without any further local edit", async () => {
    const world = await createEngineWorld([
      { name: "A" },
      { name: "B" },
      { name: "W", profile: "work", roles: ["gtd"] },
    ]);
    const [a, b, w] = [world.device("A"), world.device("B"), world.device("W")];
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await settleWorld(world);

    w.clock.advance(10_000);
    await w.repo.completeTask("t1", new Date(w.clock.now).toISOString());
    a.clock.advance(20_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    await a.stamp();
    b.clock.advance(30_000);
    await editTask(b, "t1", { notes: "edited on B" });

    await settleWorld(world, 5);
    const states = await Promise.all(
      world.devices.map(async (device) => {
        const task = (await device.repo.listTasks({ includeCompleted: true })).find(
          (candidate) => candidate.id === "t1",
        );
        return `${task?.status}/${task?.notes}`;
      }),
    );
    expect(new Set(states).size, states.join(" | ")).toBe(1);
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("publishes after an apply that changed rows, durably, and stops once nothing changes", async () => {
    const { world, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await settle(world);

    b.clock.advance(60_000);
    await editTask(b, "t1", { title: "From B" });
    await b.engine.syncNow();

    // A pulls and applies: the merged state is now pending, with nothing edited locally ...
    a.clock.advance(120_000);
    const pull = await a.engine.pull();
    expect(pull.totals.applied).toBeGreaterThan(0);
    const pending = await a.repo.getSyncStatus();
    expect(pending.supported && pending.pendingChanges).toBeGreaterThan(0);

    // ... and the obligation survives a restart (a fresh engine over the same database).
    const restarted = createSyncEngine({
      repo: a.repo,
      transports: a.transports,
      profile: "personal",
      now: a.clock.read,
    });
    expect((await restarted.publish()).domains.some((d) => d.outcome === "published")).toBe(true);

    // B applies A's merged bundle: identical content, so nothing changes and B stays quiet.
    const report = await b.engine.syncNow();
    expect(report.pull.totals.applied).toBe(0);
    expect(report.pull.totals.tombstonesApplied).toBe(0);
    expect(published(report)).toBe(0);
    const quiet = await b.repo.getSyncStatus();
    expect(quiet.supported && quiet.pendingChanges).toBe(0);
  });

  it("does not ping-pong: concurrent edits settle and then no laptop publishes again", async () => {
    const world = await createEngineWorld([{ name: "A" }, { name: "B" }, { name: "C" }]);
    const [a, b, c] = [world.device("A"), world.device("B"), world.device("C")];
    await a.repo.createTask({ id: "t1", title: "Plan", notes: "", bucket: "inbox" });
    await a.repo.createTask({ id: "t2", title: "Other", notes: "", bucket: "inbox" });
    await settle(world);

    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "A title" });
    b.clock.advance(2_000);
    await editTask(b, "t1", { notes: "B notes" });
    c.clock.advance(3_000);
    await editTask(c, "t2", { title: "C title" });
    await c.repo.completeTask("t1", new Date(c.clock.now).toISOString());

    const perRound: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      let count = 0;
      for (const device of world.devices) count += published(await device.engine.syncNow());
      perRound.push(count);
    }
    expect(perRound.slice(-4)).toEqual([0, 0, 0, 0]);
    expect(perRound.reduce((sum, n) => sum + n, 0)).toBeLessThan(40);
    await world.sim.expectConverged("gtd", { snapshots: true });
  });

  it("re-applying identical content reports nothing changed and bumps nothing", async () => {
    const { a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const bundle = await a.repo.listSyncChanges("gtd");
    const first = await b.repo.applySyncBundle("gtd", bundle, { republish: true });
    expect(first.applied).toBeGreaterThan(0);
    const counter = (await readIdentity(b.db))?.change_counter;
    const again = await b.repo.applySyncBundle("gtd", bundle, { republish: true });
    expect(again).toMatchObject({ applied: 0, tombstonesApplied: 0 });
    expect((await readIdentity(b.db))?.change_counter).toBe(counter);
  });
});

describe("rows that only grow count as local changes", () => {
  it("an AI message saved alone is published, and the other laptop receives it", async () => {
    const { world, a, b } = await twoDevices();
    await settle(world);
    const before = await a.repo.getSyncStatus();
    await a.repo.saveAiMessage(aiMessage("only-message", "SENTINEL body"));
    const after = await a.repo.getSyncStatus();
    expect(after.supported && after.pendingChanges).toBeGreaterThan(
      before.supported ? before.pendingChanges : 0,
    );

    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(
      (await b.db.select<{ id: string }[]>("SELECT id FROM ai_messages")).map((row) => row.id),
    ).toEqual(["only-message"]);
  });
});
