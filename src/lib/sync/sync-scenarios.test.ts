// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { AnnualGoal, Task } from "../../domain/types";
import { clocksOf, readIdentity, readMarks, readMetaOf, syncState } from "./capture-test-utils";
import { stampDirtyEntities } from "./capture-stamp";
import { compareHlc } from "./hlc";
import { supportedEntityTables, supportedUnionTables } from "./merge-strategies";
import { getTableRegistration } from "./registry";
import {
  createSyncHarness,
  dumpDomain,
  harnessDeviceId,
  HARNESS_START_MS,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * Required scenarios, driven through the real repository methods of two or three simulated laptops
 * (real in-memory SQLite, real capture triggers, independent fake clocks). Sync is not user-enabled
 * anywhere in the app; these tests are the only caller of `listSyncChanges` / `applySyncBundle`.
 */

const findTask = async (device: SyncDevice, id: string): Promise<Task> => {
  const found = (await device.repo.listTasks({ includeCompleted: true })).find(
    (task) => task.id === id,
  );
  if (!found) throw new Error(`task ${id} not found on ${device.name}`);
  return found;
};

const editTask = async (device: SyncDevice, id: string, patch: Partial<Task>): Promise<Task> =>
  device.repo.saveTask({ ...(await findTask(device, id)), ...patch });

const goal = (overrides: Partial<AnnualGoal> = {}): AnnualGoal => ({
  id: "goal-1",
  title: "Lire 24 livres",
  dimension: "intellectuelle",
  description: "",
  targetValue: 24,
  unit: "livres",
  sourceId: null,
  manualCurrentValue: null,
  evaluations: {},
  measurementType: "cumulative",
  status: "active",
  deadline: null,
  startingValue: null,
  direction: null,
  cadenceTarget: null,
  cadencePeriod: "week",
  principleKey: null,
  progressLog: {},
  milestones: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const milestone = (id: string, sortOrder: number, completedAt: string | null = null) => ({
  id,
  title: `Milestone ${id}`,
  completedAt,
  sortOrder,
});

/** `language` has a single legal value today; the merge does not care, so tests give it a second one. */
const EN = "en" as unknown as "fr";

const HARNESS_DEVICE_B = harnessDeviceId(1);

const twoDevices = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  return { sim, a: sim.device("A"), b: sim.device("B") };
};

describe("an edit on one laptop while the other is idle", () => {
  it("reaches the idle laptop without a conflict and without re-dirtying it", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");

    b.clock.advance();
    await editTask(b, "t1", { title: "Plan v2" });

    const before = await readIdentity(a.db);
    const result = await sim.exchange(b, a, "gtd");

    expect((await findTask(a, "t1")).title).toBe("Plan v2");
    expect(result.applied).toBeGreaterThan(0);
    expect(result.conflictsLogged).toBe(0);
    expect(await readConflicts(a)).toEqual([]);
    expect((await readIdentity(a.db)).change_counter).toBe(before?.change_counter);
    expect(await readMarks(a.db)).toEqual([]);
    expect(await stampDirtyEntities(a.db, a.clock.now)).toBe(0);
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("a second pull of the same bundle changes nothing at all", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox", contextIds: ["home"] });
    await sim.exchange(b, a, "gtd");
    const state = await syncState(a.db);
    const again = await sim.exchange(b, a, "gtd");
    expect(again).toMatchObject({
      applied: 0,
      tombstonesApplied: 0,
      conflictsLogged: 0,
      hlcAdvanced: false,
    });
    expect(again.skipped).toBeGreaterThan(0);
    expect(await syncState(a.db)).toEqual(state);
  });

  it("only the edited field gets a new clock on the next local edit after a merge", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", notes: "n", bucket: "inbox" });
    await sim.exchange(b, a, "gtd");

    const merged = await readMetaOf(a.db, "gtd_tasks", "t1");
    a.clock.advance();
    await editTask(a, "t1", { notes: "changed on A" });
    const after = await readMetaOf(a.db, "gtd_tasks", "t1");

    const changed = Object.keys(clocksOf(after)).filter(
      (key) => clocksOf(after)[key] !== clocksOf(merged)[key],
    );
    expect(changed.sort()).toEqual(["notes", "updated_at"]);
  });
});

describe("concurrent edits of different fields both survive", () => {
  it("on a task", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "Title from A" });
    b.clock.advance(2_000);
    await editTask(b, "t1", { notes: "Notes from B" });
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await findTask(device, "t1")).toMatchObject({
        title: "Title from A",
        notes: "Notes from B",
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("on a project", async () => {
    const { sim, a, b } = await twoDevices();
    const base = await a.repo.saveProject({
      id: "p1",
      title: "Project",
      status: "active",
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      statusChangedAt: null,
    } as never);
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await a.repo.saveProject({ ...base, title: "Project (A)" });
    b.clock.advance(2_000);
    await b.repo.saveProject({ ...base, notes: "Notes (B)" });
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect((await device.repo.listProjects({})).find((p) => p.id === "p1")).toMatchObject({
        title: "Project (A)",
        notes: "Notes (B)",
      });
    }
    await sim.expectConverged("gtd");
  });

  it("on a daily entry", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-04"));
    await sim.syncAll("personal");

    a.clock.advance(1_000);
    const entryA = (await a.repo.getDailyEntry("2026-10-04")) as ReturnType<
      typeof createEmptyDailyEntry
    >;
    await a.repo.saveDailyEntry({ ...entryA, morningIntention: "Intention from A" });
    b.clock.advance(2_000);
    const entryB = (await b.repo.getDailyEntry("2026-10-04")) as ReturnType<
      typeof createEmptyDailyEntry
    >;
    await b.repo.saveDailyEntry({ ...entryB, nightReflection: "Reflection from B" });
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      expect(await device.repo.getDailyEntry("2026-10-04")).toMatchObject({
        morningIntention: "Intention from A",
        nightReflection: "Reflection from B",
      });
    }
    await sim.expectConverged("personal", { snapshots: true });
  });
});

describe("concurrent edits of the same field", () => {
  it("the later clock wins and the loser lands in sync_conflicts on the device that lost", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "A's title" });
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "B's title" });
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect((await findTask(device, "t1")).title).toBe("B's title");
    }
    const lost = await readConflicts(a);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      entity_type: "gtd_tasks",
      entity_id: "t1",
      kind: "overwritten_edit",
    });
    const local = JSON.parse(lost[0]?.local_json as string) as {
      title: { value: string; clock: string };
    };
    const remote = JSON.parse(lost[0]?.remote_json as string) as {
      title: { value: string; clock: string };
    };
    expect(local.title.value).toBe("A's title");
    expect(remote.title.value).toBe("B's title");
    expect(compareHlc(local.title.clock, remote.title.clock)).toBe(-1);
    expect(lost[0]?.resolved_at).toBeNull();
    // The winner has nothing to report: its value was never replaced.
    expect(await readConflicts(b)).toEqual([]);
  });

  it("logs the overwrite once, however often the bundles are exchanged again", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "A's title" });
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "B's title" });
    await sim.syncAll("gtd");
    const first = await readConflicts(a);
    await sim.syncAll("gtd");
    await sim.exchange(b, a, "gtd");
    expect(await readConflicts(a)).toEqual(first);
  });

  it("a JSON-map key edited on both laptops logs that key", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-04"));
    await sim.syncAll("personal");
    const edit = async (device: SyncDevice, course: number) => {
      const entry = (await device.repo.getDailyEntry("2026-10-04")) as ReturnType<
        typeof createEmptyDailyEntry
      >;
      await device.repo.saveDailyEntry({ ...entry, metrics: { ...entry.metrics, course } });
    };
    a.clock.advance(1_000);
    await edit(a, 5);
    b.clock.advance(5_000);
    await edit(b, 9);
    await sim.syncAll("personal");

    expect((await a.repo.getDailyEntry("2026-10-04"))?.metrics.course).toBe(9);
    const conflicts = await readConflicts(a);
    expect(conflicts).toHaveLength(1);
    expect(JSON.parse(conflicts[0]?.local_json as string)).toMatchObject({
      "metrics_json.course": { value: 5 },
    });
  });
});

describe("context id lists (OR-set)", () => {
  it("keeps both contexts added concurrently to one task", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox", contextIds: ["home"] });
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await editTask(a, "t1", { contextIds: ["home", "work"] });
    b.clock.advance(2_000);
    await editTask(b, "t1", { contextIds: ["home", "phone"] });
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect([...(await findTask(device, "t1")).contextIds].sort()).toEqual([
        "home",
        "phone",
        "work",
      ]);
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("resolves an add against a remove by clock", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({
      id: "t1",
      title: "Plan",
      bucket: "inbox",
      contextIds: ["home", "work"],
    });
    await sim.syncAll("gtd");

    // B removes "work" first, A removes "home" later: both removals stand.
    b.clock.advance(1_000);
    await editTask(b, "t1", { contextIds: ["home"] });
    a.clock.advance(2_000);
    await editTask(a, "t1", { contextIds: ["work"] });
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect((await findTask(device, "t1")).contextIds).toEqual([]);
    }

    // B re-adds "home" later than anything A did: the add wins everywhere.
    b.clock.advance(60_000);
    await editTask(b, "t1", { contextIds: ["home"] });
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect((await findTask(device, "t1")).contextIds).toEqual(["home"]);
    }
  });
});

describe("deletes", () => {
  const seedGoal = async () => {
    const harness = await twoDevices();
    await harness.a.repo.saveAnnualGoal(goal({ milestones: [milestone("m1", 0)] }));
    await harness.sim.syncAll("personal");
    return harness;
  };
  const goalIds = async (device: SyncDevice) =>
    (await device.repo.listAnnualGoals()).map((g) => g.id);

  it("a delete on A reaches B: the row is gone and the tombstone is kept", async () => {
    const { sim, a, b } = await seedGoal();
    expect(await goalIds(b)).toEqual(["goal-1"]);
    a.clock.advance(1_000);
    await a.repo.deleteAnnualGoal("goal-1");

    const result = await sim.exchange(a, b, "personal");

    expect(await goalIds(b)).toEqual([]);
    expect(result.tombstonesApplied).toBe(1);
    expect(await readMetaOf(b.db, "annual_goals", "goal-1")).toMatchObject({
      deleted_at: expect.any(String),
    });
    expect(
      await b.db.select("SELECT * FROM sync_entity_snapshot WHERE entity_type = 'annual_goals'"),
    ).toEqual([]);
    expect(await readMarks(b.db)).toEqual([]);
    await sim.syncAll("personal");
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("a delete on A and a later edit on B: the edit wins and the goal comes back on A", async () => {
    const { sim, a, b } = await seedGoal();
    a.clock.advance(1_000);
    await a.repo.deleteAnnualGoal("goal-1");
    b.clock.advance(60_000);
    const current = (await b.repo.listAnnualGoals())[0] as AnnualGoal;
    await b.repo.saveAnnualGoal({ ...current, title: "Edited after the delete" });

    await sim.syncAll("personal");

    for (const device of [a, b]) {
      expect((await device.repo.listAnnualGoals()).map((g) => g.title)).toEqual([
        "Edited after the delete",
      ]);
      expect((await readMetaOf(device.db, "annual_goals", "goal-1"))?.deleted_at).toBeNull();
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("an edit on B that is older than the delete on A loses to the delete", async () => {
    const { sim, a, b } = await seedGoal();
    b.clock.advance(1_000);
    const current = (await b.repo.listAnnualGoals())[0] as AnnualGoal;
    await b.repo.saveAnnualGoal({ ...current, title: "Edited early" });
    a.clock.advance(60_000);
    await a.repo.deleteAnnualGoal("goal-1");

    await sim.syncAll("personal");

    expect(await goalIds(a)).toEqual([]);
    expect(await goalIds(b)).toEqual([]);
    await sim.expectConverged("personal", { snapshots: true });
  });

  describe("a delete racing two different editors (the tombstone keeps clocks, not values)", () => {
    // B edits the title at +2s, A deletes at +3s, C edits the description at +4s. Each device
    // publishes its final state; a fresh replica receives them in different orders.
    const race = async () => {
      const sim = await createSyncHarness(["A", "B", "C"]);
      const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
      await a.repo.saveAnnualGoal(goal({ title: "Original title", description: "Original text" }));
      await sim.syncAll("personal");
      const current = async (device: SyncDevice) =>
        (await device.repo.listAnnualGoals())[0] as AnnualGoal;
      b.clock.advance(2_000);
      await b.repo.saveAnnualGoal({ ...(await current(b)), title: "Title edited on B" });
      a.clock.advance(3_000);
      await a.repo.deleteAnnualGoal("goal-1");
      c.clock.advance(4_000);
      await c.repo.saveAnnualGoal({
        ...(await current(c)),
        description: "Description edited on C",
      });
      const bundles = Object.fromEntries(
        await Promise.all(
          [a, b, c].map(async (device) => [
            device.name,
            await device.repo.listSyncChanges("personal"),
          ]),
        ),
      );
      const replicaOf = async () =>
        (
          await createSyncHarness(1, {
            deviceIndexOffset: 10,
            startMs: HARNESS_START_MS - 3_600_000,
          })
        ).devices[0] as SyncDevice;
      return { bundles, replicaOf };
    };
    const feed = async (replica: SyncDevice, order: string[], bundles: Record<string, never>) => {
      for (const name of order) {
        await replica.repo.applySyncBundle("personal", JSON.parse(JSON.stringify(bundles[name])));
      }
    };

    it("order B, A, C: the goal is resurrected without B's title, and B's lost edit is logged", async () => {
      const { bundles, replicaOf } = await race();
      const replica = await replicaOf();
      await feed(replica, ["B", "A", "C"], bundles as never);

      const [goalNow] = await replica.repo.listAnnualGoals();
      expect(goalNow).toMatchObject({
        title: "Original title",
        description: "Description edited on C",
      });
      const lost = await readConflicts(replica);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({
        entity_type: "annual_goals",
        entity_id: "goal-1",
        kind: "overwritten_edit",
      });
      const local = JSON.parse(lost[0]?.local_json as string) as Record<
        string,
        { unknown?: boolean; clock: string }
      >;
      expect(Object.keys(local)).toEqual(["title"]);
      expect(local.title?.unknown).toBe(true);
      expect(local.title?.clock).toContain(HARNESS_DEVICE_B);
      expect(JSON.parse(lost[0]?.remote_json as string)).toMatchObject({
        title: { value: "Original title" },
      });
    });

    it("order B, C, A: B's title survives and nothing is logged (the documented non-join)", async () => {
      const { bundles, replicaOf } = await race();
      const replica = await replicaOf();
      await feed(replica, ["B", "C", "A"], bundles as never);
      const [goalNow] = await replica.repo.listAnnualGoals();
      expect(goalNow).toMatchObject({
        title: "Title edited on B",
        description: "Description edited on C",
      });
      expect(await readConflicts(replica)).toEqual([]);
    });

    it("re-applying the same bundles never logs the loss twice", async () => {
      const { bundles, replicaOf } = await race();
      const replica = await replicaOf();
      await feed(replica, ["B", "A", "C", "B", "A", "C"], bundles as never);
      expect(await readConflicts(replica)).toHaveLength(1);
    });
  });

  it("a tombstone for a row the receiver never had is recorded as metadata only", async () => {
    const { sim, a, b } = await seedGoal();
    // B creates and deletes a goal A has never seen.
    b.clock.advance(1_000);
    await b.repo.saveAnnualGoal(goal({ id: "goal-ghost" }));
    b.clock.advance(1_000);
    await b.repo.deleteAnnualGoal("goal-ghost");

    const result = await sim.exchange(b, a, "personal");

    expect(result.tombstonesApplied).toBe(1);
    expect(await goalIds(a)).toEqual(["goal-1"]);
    expect(await readMetaOf(a.db, "annual_goals", "goal-ghost")).toMatchObject({
      deleted_at: expect.any(String),
    });
    expect(await a.db.select("SELECT * FROM annual_goals WHERE id = 'goal-ghost'")).toEqual([]);
    expect(await readMarks(a.db)).toEqual([]);
  });

  it("a task deleted outside the repository writers is tombstoned by the scan and then synced", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Doomed", bucket: "inbox" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = $1", ["t1"]);
    await a.stamp();

    await sim.syncAll("gtd");

    expect((await b.repo.listTasks({})).map((t) => t.id)).toEqual([]);
    expect((await readMetaOf(b.db, "gtd_tasks", "t1"))?.deleted_at).not.toBeNull();
  });
});

describe("JSON-map columns merge per key", () => {
  it("metrics of a daily entry: different metrics edited on two laptops both survive", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-04"));
    await sim.syncAll("personal");

    const set = async (device: SyncDevice, patch: Record<string, number>) => {
      const entry = (await device.repo.getDailyEntry("2026-10-04")) as ReturnType<
        typeof createEmptyDailyEntry
      >;
      await device.repo.saveDailyEntry({ ...entry, metrics: { ...entry.metrics, ...patch } });
    };
    a.clock.advance(1_000);
    await set(a, { course: 5, pushups: 20 });
    b.clock.advance(2_000);
    await set(b, { marche: 8, pushups: 30 });
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      expect((await device.repo.getDailyEntry("2026-10-04"))?.metrics).toMatchObject({
        course: 5,
        marche: 8,
        pushups: 30,
      });
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("milestones of an annual goal: a milestone completed on A and one added on B both survive", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveAnnualGoal(goal({ milestones: [milestone("m1", 0), milestone("m2", 1)] }));
    await sim.syncAll("personal");

    a.clock.advance(1_000);
    const onA = (await a.repo.listAnnualGoals())[0] as AnnualGoal;
    await a.repo.saveAnnualGoal({
      ...onA,
      milestones: onA.milestones.map((m) =>
        m.id === "m1" ? { ...m, completedAt: "2026-10-04" } : m,
      ),
    });
    b.clock.advance(2_000);
    const onB = (await b.repo.listAnnualGoals())[0] as AnnualGoal;
    await b.repo.saveAnnualGoal({ ...onB, milestones: [...onB.milestones, milestone("m3", 2)] });
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      const merged = (await device.repo.listAnnualGoals())[0] as AnnualGoal;
      expect(merged.milestones.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(merged.milestones.find((m) => m.id === "m1")?.completedAt).toBe("2026-10-04");
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("a milestone removed on one laptop is removed on the other unless it was edited later", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveAnnualGoal(goal({ milestones: [milestone("m1", 0), milestone("m2", 1)] }));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    const onA = (await a.repo.listAnnualGoals())[0] as AnnualGoal;
    await a.repo.saveAnnualGoal({
      ...onA,
      milestones: onA.milestones.filter((m) => m.id !== "m2"),
    });
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(
        ((await device.repo.listAnnualGoals())[0] as AnnualGoal).milestones.map((m) => m.id),
      ).toEqual(["m1"]);
    }
  });
});

describe("grow-only union tables", () => {
  it("task events merge as a set union", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "ta", title: "On A", bucket: "inbox" });
    await b.repo.createTask({ id: "tb", title: "On B", bucket: "inbox" });
    a.clock.advance();
    await a.repo.completeTask("ta");
    const eventsA = (await a.repo.listTaskEvents({})).map((event) => event.id);
    const eventsB = (await b.repo.listTaskEvents({})).map((event) => event.id);

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      const ids = (await device.repo.listTaskEvents({})).map((event) => event.id).sort();
      expect(ids).toEqual([...new Set([...eventsA, ...eventsB])].sort());
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });
});

describe("synced settings", () => {
  it("converges a gtd key and a personal key, by clock", async () => {
    const { sim, a, b } = await twoDevices();
    a.clock.advance(1_000);
    await a.repo.updateSettings((current) => ({
      ...current,
      language: EN,
      aiModel: "vendor/from-a",
    }));
    b.clock.advance(5_000);
    await b.repo.updateSettings((current) => ({ ...current, aiModel: "vendor/from-b" }));

    await sim.syncAll("gtd");
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      const settings = await device.repo.getSettings();
      expect(settings.language).toBe(EN);
      expect(settings.aiModel).toBe("vendor/from-b");
    }
    await sim.expectConverged("gtd");
    await sim.expectConverged("personal");
  });

  it("never moves a device key or a secret, in any domain", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.updateSettings((current) => ({
      ...current,
      aiApiKey: "sk-only-on-a",
      rescuetimeApiKey: "rt-only-on-a",
      llmBridgeToken: "bridge-only-on-a",
      backupDestinationDir: "/Users/a/Drive/backups",
      runInTray: true,
      language: EN,
    }));
    for (const domain of ["gtd", "personal", "finance"] as const) {
      await sim.syncAll(domain);
    }
    const onB = await b.repo.getSettings();
    expect(onB.language).toBe(EN);
    expect(onB.aiApiKey).toBe("");
    expect(onB.rescuetimeApiKey).toBe("");
    expect(onB.llmBridgeToken).toBe("");
    expect(onB.backupDestinationDir).not.toBe("/Users/a/Drive/backups");
    expect(onB.runInTray).toBe(false);
    // And B's own device keys survive a merge that rewrites the settings blob.
    await b.repo.updateSettings((current) => ({ ...current, aiApiKey: "sk-only-on-b" }));
    a.clock.advance(60_000);
    await a.repo.updateSettings((current) => ({ ...current, language: "fr" }));
    await sim.syncAll("gtd");
    expect(await b.repo.getSettings()).toMatchObject({ language: "fr", aiApiKey: "sk-only-on-b" });
  });
});

describe("three replicas converge in any exchange order", () => {
  const orders: [number, number][][] = [
    [
      [0, 1],
      [1, 2],
      [2, 0],
      [0, 1],
      [1, 2],
    ],
    [
      [2, 1],
      [1, 0],
      [0, 2],
      [2, 1],
      [1, 0],
    ],
    [
      [0, 2],
      [2, 1],
      [1, 0],
      [0, 2],
      [2, 1],
      [1, 0],
    ],
    [
      [1, 0],
      [0, 2],
      [2, 1],
      [1, 0],
      [0, 2],
      [2, 1],
    ],
  ];

  const populate = async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    // gtd
    await a.repo.createTask({ id: "t1", title: "Shared", bucket: "inbox", contextIds: ["home"] });
    await b.repo.createTask({ id: "t2", title: "Only B", bucket: "inbox" });
    await c.repo.saveContext({ id: "ctx-c", name: "From C", createdAt: "", updatedAt: "" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await editTask(a, "t1", { title: "A title", contextIds: ["home", "work"] });
    b.clock.advance(2_000);
    await editTask(b, "t1", { notes: "B notes", contextIds: ["home", "phone"] });
    c.clock.advance(3_000);
    await editTask(c, "t1", { title: "C title" });
    await c.repo.completeTask("t2");
    // personal
    await a.repo.saveAnnualGoal(goal({ milestones: [milestone("m1", 0)] }));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    await a.repo.updateSettings((current) => ({ ...current, aiModel: "vendor/a" }));
    b.clock.advance(2_000);
    await b.repo.saveAnnualGoal({
      ...((await b.repo.listAnnualGoals())[0] as AnnualGoal),
      milestones: [milestone("m1", 0, "2026-10-04"), milestone("m2", 1)],
    });
    c.clock.advance(3_000);
    await c.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-05"));
    await c.repo.updateSettings((current) => ({ ...current, aiModel: "vendor/c" }));
    return { sim, devices: [a, b, c] as const };
  };

  for (const [index, order] of orders.entries()) {
    it(`order #${index + 1}`, async () => {
      const { sim, devices } = await populate();
      for (const domain of ["gtd", "personal"] as const) {
        for (const [from, to] of order) {
          await sim.exchange(devices[from] as SyncDevice, devices[to] as SyncDevice, domain);
        }
        await sim.syncAll(domain); // finish the job whatever the order left over
        await sim.expectConverged(domain, { snapshots: true });
      }
      const dump = await sim.dump(devices[0], "gtd");
      expect(dump.tables.gtd_tasks?.map((row) => row.title)).toContain("C title");
      expect(devices[0] && (await devices[0].repo.getSettings()).aiModel).toBe("vendor/c");
    });
  }

  it("reaches the same state whichever order the orders are tried in", async () => {
    const finals: string[] = [];
    for (const order of orders) {
      const { sim, devices } = await populate();
      for (const domain of ["gtd", "personal"] as const) {
        for (const [from, to] of order) {
          await sim.exchange(devices[from] as SyncDevice, devices[to] as SyncDevice, domain);
        }
        await sim.syncAll(domain);
      }
      const dump = await sim.dump(devices[0], "gtd");
      const personal = await sim.dump(devices[0], "personal");
      finals.push(
        JSON.stringify([
          dump.tables.gtd_tasks?.map((row) => [
            row.id,
            row.title,
            row.notes,
            row.status,
            row.context_ids_json,
          ]),
          personal.tables.annual_goals?.map((row) => [row.id, row.milestones_json]),
          personal.settings.aiModel,
          personal.settings.previousDayReviewDoneDate,
        ]),
      );
    }
    expect(new Set(finals).size).toBe(1);
  });
});

describe("domain isolation", () => {
  /** Rows and clock metadata of every domain except `domain`. */
  const outsideOf = async (device: SyncDevice, domain: "gtd" | "personal") => {
    const state: Record<string, unknown> = {};
    for (const other of (["gtd", "personal", "finance"] as const).filter((d) => d !== domain)) {
      const dump = await dumpDomain(device, other, { exact: true });
      state[other] = { tables: dump.tables, meta: dump.meta };
    }
    return state;
  };

  it("applying a gtd bundle changes nothing outside the gtd domain, and vice versa", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "From A", bucket: "inbox" });
    await a.repo.saveAnnualGoal(goal());
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-04"));
    await b.repo.saveDailyEntry({
      ...createEmptyDailyEntry("2026-10-06"),
      morningIntention: "B only",
    });

    const beforeGtdApply = await outsideOf(b, "gtd");
    await sim.exchange(a, b, "gtd");
    expect(await outsideOf(b, "gtd")).toEqual(beforeGtdApply);
    expect((await b.repo.listTasks({})).map((t) => t.id)).toEqual(["t1"]);

    const beforePersonalApply = await outsideOf(b, "personal");
    await sim.exchange(a, b, "personal");
    expect(await outsideOf(b, "personal")).toEqual(beforePersonalApply);
    expect((await b.repo.listAnnualGoals()).map((g) => g.id)).toEqual(["goal-1"]);
    expect((await b.repo.listTasks({})).map((t) => t.id)).toEqual(["t1"]);
  });

  it("browsing and listing never dirty anything", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "From A", bucket: "inbox", contextIds: ["home"] });
    await a.repo.saveAnnualGoal(goal());
    await sim.syncAll("gtd");
    await sim.syncAll("personal");

    const states = [await syncState(a.db), await syncState(b.db)];
    for (const device of [a, b]) {
      await device.repo.listTasks({});
      await device.repo.listProjects({});
      await device.repo.listContexts();
      await device.repo.listAnnualGoals();
      await device.repo.getSettings();
      await device.repo.getSyncStatus();
      await device.repo.listSyncChanges("gtd");
      await device.repo.listSyncChanges("personal");
      await device.repo.listSyncChanges("finance");
      await device.repo.listTaskEvents({});
    }
    expect([await syncState(a.db), await syncState(b.db)]).toEqual(states);
  });
});

describe("a resurrection removes the memberships the tombstone knew and the row omits", () => {
  /**
   * A and D hold task t1 with context `work` at T1 (A created it, D synced it). B created its own
   * t1 without `work` and never removed it, so B has no clock for it. A deletes t1 at T5 (the
   * tombstone keeps `context_ids_json.work` at T1); B edits notes at T10, which beats the delete.
   * A fresh replica receives the three final states in every order.
   */
  const build = async (offsets: { create: number; remove: number; edit: number }) => {
    // Absolute offsets from the start: B's edit lands at `edit`, after A's delete at create + remove.
    expect(offsets.edit).toBeGreaterThan(offsets.create + offsets.remove);
    const sim = await createSyncHarness(["A", "B", "D"]);
    const [a, b, d] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    a.clock.advance(offsets.create);
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox", contextIds: ["work"] });
    await sim.exchange(a, d, "gtd");
    b.clock.advance(offsets.create / 2);
    await b.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox", contextIds: [] });
    a.clock.advance(offsets.remove);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    await a.stamp();
    b.clock.set(HARNESS_START_MS + offsets.edit);
    await editTask(b, "t1", { notes: "Edited after the delete" });
    const bundles = {
      A: await a.repo.listSyncChanges("gtd"),
      B: await b.repo.listSyncChanges("gtd"),
      D: await d.repo.listSyncChanges("gtd"),
    };
    return bundles;
  };
  const permutations = [
    ["A", "B", "D"],
    ["A", "D", "B"],
    ["B", "A", "D"],
    ["D", "A", "B"],
    ["B", "D", "A"],
    ["D", "B", "A"],
  ] as const;

  const runOrders = async (bundles: Awaited<ReturnType<typeof build>>) => {
    const replicas = await createSyncHarness(permutations.length, {
      deviceIndexOffset: 10,
      startMs: HARNESS_START_MS - 3_600_000,
    });
    const results: { order: readonly string[]; contexts: string[]; dump: string }[] = [];
    for (const [index, order] of permutations.entries()) {
      const replica = replicas.devices[index] as SyncDevice;
      for (const name of [...order, ...order]) {
        await replica.repo.applySyncBundle(
          "gtd",
          JSON.parse(JSON.stringify(bundles[name as "A" | "B" | "D"])),
        );
      }
      const task = (await replica.repo.listTasks({ includeCompleted: true })).find(
        (t) => t.id === "t1",
      );
      results.push({
        order,
        contexts: task?.contextIds ?? ["<task missing>"],
        dump: JSON.stringify(await replicas.dump(replica, "gtd", { snapshots: true, exact: true })),
      });
    }
    return results;
  };

  it("an older replica holding the omitted id cannot put it back, whenever the tombstone arrives before both live replicas have merged", async () => {
    const results = await runOrders(await build({ create: 1_000, remove: 4_000, edit: 9_000 }));
    const tombstoneFirst = results.filter(({ order }) => order[2] !== "A");
    expect(tombstoneFirst).toHaveLength(4);
    for (const { order, contexts } of tombstoneFirst) {
      expect(contexts, order.join(",")).toEqual([]);
    }
    // Byte-identical state (rows, clocks, snapshots), including the removal clock.
    expect(new Set(tombstoneFirst.map(({ dump }) => dump)).size).toBe(1);
  });

  it("the residual non-join: if both live replicas merged before the older tombstone arrived, the id stays", async () => {
    // A live row that already merged D's add holds `work` at T1, and the tombstone only knows T1: it
    // cannot tell "B omitted it" from "B kept it". Documented in the storage docs.
    const results = await runOrders(await build({ create: 1_000, remove: 4_000, edit: 9_000 }));
    for (const { order, contexts } of results.filter(({ order }) => order[2] === "A")) {
      expect(contexts, order.join(",")).toEqual(["work"]);
    }
  });

  for (const [create, remove, edit] of [
    [500, 2_000, 30_000],
    [7_000, 100, 7_101],
    [60_000, 3_600, 63_601],
  ] as const) {
    it(`holds for other timings (${create}/${remove}/${edit})`, async () => {
      const results = await runOrders(await build({ create, remove, edit }));
      const tombstoneFirst = results.filter(({ order }) => order[2] !== "A");
      for (const { contexts } of tombstoneFirst) expect(contexts).toEqual([]);
      expect(new Set(tombstoneFirst.map(({ dump }) => dump)).size).toBe(1);
    });
  }
});

describe("foreign keys are enforced (as in production)", () => {
  const objective = (id: string) => ({
    id,
    title: `Objective ${id}`,
    kind: "manual" as const,
    targetHours: null,
    rescuetimeKind: null,
    rescuetimeThing: null,
    sortOrder: 0,
    startsOnWeekStartDate: null,
    endsOnWeekStartDate: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const result = (objectiveId: string, achieved: boolean) => ({
    weekStartDate: "2026-10-04",
    objectiveId,
    achieved,
    updatedAt: "2026-10-05T00:00:00.000Z",
  });

  it("runs every simulated laptop with foreign keys on", async () => {
    const { a } = await twoDevices();
    expect(
      (await a.db.select<{ foreign_keys: number }[]>("PRAGMA foreign_keys"))[0]?.foreign_keys,
    ).toBe(1);
    await expect(
      a.db.execute(
        "INSERT INTO weekly_objective_results (week_start_date, objective_id, achieved, updated_at) VALUES ('2026-10-04', 'missing-parent', 1, 't')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("an objective deleted on A and its result edited later on B cannot abort a merge, in either direction", async () => {
    // The objective and its results merge now (apply-references.ts): the parent tombstone reaches B
    // and removes the result there with a tombstone of its own; the result edit arriving at A for a
    // deleted objective is kept off the table instead of aborting the bundle. The full matrix
    // (every order, three replicas) is in references.convergence.test.ts.
    const { sim, a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("obj-1"));
    await a.repo.saveWeeklyObjectiveResult(result("obj-1", false));
    await b.repo.saveWeeklyObjective(objective("obj-1"));
    await b.repo.saveWeeklyObjectiveResult(result("obj-1", false));
    await a.repo.saveAnnualGoal(goal());
    await sim.syncAll("personal");

    a.clock.advance(1_000);
    await a.repo.deleteWeeklyObjective("obj-1"); // cascades to A's result, captured by A's triggers
    b.clock.advance(60_000);
    // A raw edit: saving an achieved result through the repository also ends a manual objective,
    // which would be an edit of the PARENT (and resurrect it, as it should).
    await b.db.execute("UPDATE weekly_objective_results SET achieved = 1");
    await b.stamp();

    await sim.exchange(a, b, "personal");
    await sim.exchange(b, a, "personal");
    await sim.syncAll("personal");

    expect((await b.repo.listAnnualGoals()).map((g) => g.id)).toEqual(["goal-1"]);
    for (const device of [a, b]) {
      expect(await device.repo.listWeeklyObjectives()).toEqual([]);
      expect(await device.repo.getWeeklyObjectiveResults("2026-10-04")).toEqual([]);
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("every foreign key of a synced table is covered by a reference rule", async () => {
    const { a } = await twoDevices();
    const keys = await a.db.select<{ table: string; on_delete: string }[]>(
      `SELECT m.name AS child, f."table" AS "table", f.on_delete AS on_delete
       FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`,
    );
    for (const key of keys) {
      expect(key.on_delete).toBe("CASCADE");
      expect(supportedEntityTables("personal").concat(supportedUnionTables("personal"))).toContain(
        key.table,
      );
    }
  });
});

describe("gtd_tasks lifecycle: complete on one laptop, cancel on the other", () => {
  // This was the labelled KNOWN LIMITATION of the generic merge (a cancelled task that still had a
  // completion date). The lifecycle tuple merges as one unit now: the full rules are in
  // gtd-semantics.scenarios.test.ts.
  it("is no longer flagged: the task and template merge by their own rules", () => {
    for (const table of ["gtd_tasks", "recurring_task_templates"]) {
      expect(Object.keys(getTableRegistration(table))).not.toContain("lifecycleMergePending");
    }
  });

  it("yields one deterministic winner, a terminal_divergence conflict and a consistent completed_at", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await a.repo.completeTask("t1", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5_000);
    await b.repo.cancelTask("t1");
    await sim.syncAll("gtd");

    // The later decision (B's cancel) is the provisional winner on both laptops ...
    for (const device of [a, b]) {
      const merged = await findTask(device, "t1");
      expect(merged.status).toBe("cancelled");
      expect(merged.completedAt).toBeNull(); // ... with a completion date that agrees with it
    }
    await sim.expectConverged("gtd", { snapshots: true });

    // ... and the user is asked, on both, with the same conflict and both sides' tuples.
    const [onA, onB] = await Promise.all(
      [a, b].map(async (device) =>
        (await readConflicts(device)).filter((row) => row.kind === "terminal_divergence"),
      ),
    );
    expect(onA).toHaveLength(1);
    expect(onB).toHaveLength(1);
    expect(onA?.[0]?.id).toBe(onB?.[0]?.id);
    expect(onA?.[0]).toMatchObject({
      entity_type: "gtd_tasks",
      entity_id: "t1",
      resolved_at: null,
    });
    const sides = [onA?.[0]?.local_json, onA?.[0]?.remote_json].map((json) =>
      JSON.parse(String(json)),
    );
    expect(sides.map((side) => side.status).sort()).toEqual(["cancelled", "completed"]);
  });
});
