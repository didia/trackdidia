// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, RecurringTaskTemplate, Task } from "../../domain/types";
import { toLocalDateString } from "../date";
import { readIdentity, syncState } from "./capture-test-utils";
import {
  createSyncHarness,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * GTD task semantics through the real repository methods of simulated laptops (real SQLite with
 * foreign keys on, real capture triggers): the lifecycle tuple, normalization, the Planned queue and
 * recurring occurrences. The pure rules are in `merge-task.test.ts`.
 */

const findTask = async (device: SyncDevice, id: string): Promise<Task> => {
  const found = (await device.repo.listTasks({ includeCompleted: true })).find(
    (task) => task.id === id,
  );
  if (!found) throw new Error(`task ${id} not found on ${device.name}`);
  return found;
};

const maybeTask = async (device: SyncDevice, id: string): Promise<Task | undefined> =>
  (await device.repo.listTasks({ includeCompleted: true })).find((task) => task.id === id);

const twoDevices = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  return { sim, a: sim.device("A"), b: sim.device("B") };
};

const kinds = async (device: SyncDevice, kind: string) =>
  (await readConflicts(device)).filter((row) => row.kind === kind);

const project = (id: string): Project => ({
  id,
  title: `Project ${id}`,
  status: "active",
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("lifecycle tuple through the repository", () => {
  it("a completion beats a concurrent move on the other laptop, which logs its dropped move", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");

    a.clock.advance(1_000);
    await a.repo.completeTask("t1", "2026-10-02T10:00:00.000Z");
    b.clock.advance(60_000); // the move is LATER, but made without seeing the completion
    await b.repo.moveTask("t1", "waiting_for", []);
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await findTask(device, "t1")).toMatchObject({
        status: "completed",
        bucket: "next_action",
        completedAt: "2026-10-02T10:00:00.000Z",
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });
    expect(await kinds(a, "terminal_divergence")).toEqual([]);
    const lost = await kinds(b, "overwritten_edit");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ entity_type: "gtd_tasks", entity_id: "t1" });
    expect(String(lost[0]?.local_json)).toContain("waiting_for");
    expect(await kinds(a, "overwritten_edit")).toEqual([]);
  });

  it("the same completion on both laptops is no conflict at all", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");
    await a.repo.completeTask("t1", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5_000);
    await b.repo.completeTask("t1", "2026-10-02T10:05:00.000Z");
    await sim.syncAll("gtd");
    expect(await readConflicts(a)).toEqual([]);
    expect(await readConflicts(b)).toEqual([]);
    expect((await findTask(a, "t1")).status).toBe("completed");
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("complete vs cancel reports one divergence per laptop and does not duplicate it on re-apply", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await a.repo.completeTask("t1", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5_000);
    await b.repo.cancelTask("t1");
    await sim.syncAll("gtd");
    await sim.syncAll("gtd");
    await sim.exchange(a, b, "gtd");
    await sim.exchange(b, a, "gtd");
    for (const device of [a, b]) {
      expect(await kinds(device, "terminal_divergence")).toHaveLength(1);
    }
    expect((await kinds(a, "terminal_divergence"))[0]?.id).toBe(
      (await kinds(b, "terminal_divergence"))[0]?.id,
    );
  });

  it("two active buckets merge as a whole tuple, never mixing a date into another bucket", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await a.repo.saveTask({
      ...(await findTask(a, "t1")),
      bucket: "scheduled",
      scheduledFor: "2026-11-03T12:00:00.000Z",
    });
    b.clock.advance(60_000);
    await b.repo.moveTask("t1", "waiting_for", []);
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect(await findTask(device, "t1")).toMatchObject({
        bucket: "waiting_for",
        scheduledFor: null,
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("a planned task whose project was deleted elsewhere is demoted like the desktop does, on both laptops", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveProject(project("p1"));
    await a.repo.createTask({
      id: "keep",
      title: "Keeper",
      bucket: "next_action",
      projectId: "p1",
    });
    await a.repo.createTask({ id: "t1", title: "Planned", bucket: "planned", projectId: "p1" });
    await sim.syncAll("gtd");
    expect(await findTask(b, "t1")).toMatchObject({ bucket: "planned", plannedOrder: 0 });

    // The project goes away on B only (nothing in the app deletes projects yet; a later build may).
    b.clock.advance(1_000);
    await b.db.execute("DELETE FROM gtd_projects WHERE id = 'p1'");
    await b.stamp();
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await findTask(device, "t1")).toMatchObject({
        bucket: "next_action",
        plannedOrder: null,
        scheduledFor: null,
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });

    // The normalized rows carry snapshots: a verifying scan restamps nothing.
    for (const device of [a, b]) {
      const before = await syncState(device.db);
      await device.stamp();
      expect(await syncState(device.db)).toEqual(before);
    }
  });
});

describe("apply order", () => {
  it("a single apply already demotes a planned task whose project the same bundle deletes (projects first)", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveProject(project("p1"));
    await a.repo.createTask({
      id: "keep",
      title: "Keeper",
      bucket: "next_action",
      projectId: "p1",
    });
    await a.repo.createTask({ id: "t1", title: "Planned", bucket: "planned", projectId: "p1" });
    await sim.syncAll("gtd");

    b.clock.advance(1_000);
    await b.db.execute("DELETE FROM gtd_projects WHERE id = 'p1'");
    await b.stamp();
    // ONE exchange, not syncAll: the tombstone and the task arrive in the same bundle, and the task
    // must see the tombstone, so the demotion cannot wait for a second apply.
    await sim.exchange(b, a, "gtd");
    expect(await findTask(a, "t1")).toMatchObject({ bucket: "next_action", plannedOrder: null });
    expect((await a.repo.listProjects({})).map((p) => p.id)).toEqual([]);
  });
});

describe("the Planned queue", () => {
  const seedQueue = async (sim: Awaited<ReturnType<typeof twoDevices>>["sim"], a: SyncDevice) => {
    await a.repo.saveProject(project("p1"));
    await a.repo.createTask({
      id: "keep",
      title: "Keeper",
      bucket: "next_action",
      projectId: "p1",
    });
    for (const id of ["x", "y", "z"]) {
      a.clock.advance(10);
      await a.repo.createTask({ id, title: id, bucket: "planned", projectId: "p1" });
    }
    await sim.syncAll("gtd");
  };
  const orders = async (device: SyncDevice) =>
    Object.fromEntries(
      (await device.repo.listTasks({ bucket: "planned" })).map((task) => [
        task.id,
        task.plannedOrder,
      ]),
    );

  it("reordering on both laptops resolves without a prompt and leaves a dense order", async () => {
    const { sim, a, b } = await twoDevices();
    await seedQueue(sim, a);
    expect(await orders(b)).toEqual({ x: 0, y: 1, z: 2 });

    a.clock.advance(1_000);
    await a.repo.movePlannedTask("z", "up"); // x y z -> x z y
    b.clock.advance(2_000);
    await b.repo.movePlannedTask("x", "down"); // x y z -> y x z
    await sim.syncAll("gtd");
    await sim.syncAll("gtd");

    const merged = await orders(a);
    expect(Object.values(merged).sort()).toEqual([0, 1, 2]);
    expect(await orders(b)).toEqual(merged);
    await sim.expectConverged("gtd", { snapshots: true });
    for (const device of [a, b]) {
      expect(await kinds(device, "terminal_divergence")).toEqual([]);
      // A drag is never worth a row.
      expect(await kinds(device, "overwritten_edit")).toEqual([]);
    }
  });

  it("two laptops appending to the same queue end with distinct dense orders", async () => {
    const { sim, a, b } = await twoDevices();
    await seedQueue(sim, a);
    a.clock.advance(1_000);
    await a.repo.createTask({ id: "from-a", title: "A", bucket: "planned", projectId: "p1" });
    b.clock.advance(2_000);
    await b.repo.createTask({ id: "from-b", title: "B", bucket: "planned", projectId: "p1" });
    await sim.syncAll("gtd");
    await sim.syncAll("gtd");
    const merged = await orders(a);
    expect(Object.keys(merged).sort()).toEqual(["from-a", "from-b", "x", "y", "z"]);
    expect(Object.values(merged).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(await orders(b)).toEqual(merged);
    await sim.expectConverged("gtd", { snapshots: true });
  });
});

describe("task events", () => {
  it("a completion on B counts in A's daily statistics after the exchange", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await sim.syncAll("gtd");
    const completedAt = "2026-10-05T10:00:00.000Z";
    const day = toLocalDateString(completedAt);
    const before = await a.repo.computeDailyTaskStats(day);
    b.clock.advance(1_000);
    await b.repo.completeTask("t1", completedAt);
    await sim.syncAll("gtd");
    const after = await a.repo.computeDailyTaskStats(day);
    expect(after.tasksCompleted).toBe(before.tasksCompleted + 1);
    expect(after).toEqual(await b.repo.computeDailyTaskStats(day));
  });
});

// -----------------------------------------------------------------------------------------------
// Recurring occurrences
// -----------------------------------------------------------------------------------------------

const TEMPLATE_ID = "recurring-template:water";
const INSTANCE_ID = `recurring-task:${TEMPLATE_ID}`;

const template = (overrides: Partial<RecurringTaskTemplate> = {}): RecurringTaskTemplate => ({
  id: TEMPLATE_ID,
  title: "Water the plants",
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
  startDate: "2026-03-15",
  status: "active",
  lastGeneratedForDate: null,
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-03-01T00:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  ...overrides,
});

const occurrences = async (device: SyncDevice) =>
  Object.fromEntries(
    (
      await device.db.select<{ due_date: string; outcome: string }[]>(
        "SELECT due_date, outcome FROM sync_recurrence_occurrences ORDER BY due_date",
      )
    ).map((row) => [row.due_date, row.outcome]),
  );

/** Both laptops hold the Mar 15 instance, in sync. */
const recurringPair = async () => {
  const { sim, a, b } = await twoDevices();
  await a.repo.saveRecurringTaskTemplate(template());
  await a.repo.generateDueRecurringTasks("2026-03-15");
  await sim.syncAll("gtd");
  expect(await occurrences(a)).toEqual({ "2026-03-15": "active" });
  expect(await occurrences(b)).toEqual({ "2026-03-15": "active" });
  return { sim, a, b };
};

const assertWorkedExample = async (
  sim: Awaited<ReturnType<typeof twoDevices>>["sim"],
  a: SyncDevice,
  b: SyncDevice,
) => {
  for (const device of [a, b]) {
    expect(await occurrences(device)).toEqual({
      "2026-03-15": "completed",
      "2026-03-16": "active",
    });
    expect(await findTask(device, INSTANCE_ID)).toMatchObject({
      status: "active",
      recurrenceDueDate: "2026-03-16",
      pendingPastRecurrences: 0,
      completedAt: null,
    });
    const templates = await device.repo.listRecurringTaskTemplates();
    expect(templates[0]?.lastGeneratedForDate).toBe("2026-03-16");
  }
  await sim.expectConverged("gtd", { snapshots: true });
  // Nothing more is generated, and the idle generators write nothing.
  for (const device of [a, b]) {
    const before = await syncState(device.db);
    expect(await device.repo.generateDueRecurringTasks("2026-03-16")).toBe(0);
    expect(await device.repo.promoteDueScheduledTasks("2026-03-16")).toBe(0);
    expect(await syncState(device.db)).toEqual(before);
  }
  // A's completion is in the daily statistics of both laptops.
  const day = (await a.repo.listTaskEvents({ types: ["task_completed"] }))[0]?.eventDate ?? "";
  expect(day).not.toBe("");
  for (const device of [a, b]) {
    expect((await device.repo.computeDailyTaskStats(day)).tasksCompleted).toBe(1);
  }
};

describe("recurring occurrences", () => {
  it("captures the occurrences of every advance of the instance row", async () => {
    const { a } = await recurringPair();
    const before = await readIdentity(a.db);
    a.clock.advance(1_000);
    await a.repo.generateDueRecurringTasks("2026-03-18"); // 16 and 17 passed over
    expect(await occurrences(a)).toEqual({
      "2026-03-15": "missed",
      "2026-03-16": "missed",
      "2026-03-17": "missed",
      "2026-03-18": "active",
    });
    // One stamped entity per touched row (instance + template), not one per sidecar row.
    const after = await readIdentity(a.db);
    expect((after?.change_counter ?? 0) - (before?.change_counter ?? 0)).toBeLessThanOrEqual(2);
    expect(await findTask(a, INSTANCE_ID)).toMatchObject({ pendingPastRecurrences: 3 });

    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-18T09:00:00.000Z");
    expect((await occurrences(a))["2026-03-18"]).toBe("completed");

    // Leaving a terminal state acknowledges the older backlog; only the new gap counts.
    a.clock.advance(1_000);
    await a.repo.generateDueRecurringTasks("2026-03-20");
    expect(await findTask(a, INSTANCE_ID)).toMatchObject({
      recurrenceDueDate: "2026-03-20",
      pendingPastRecurrences: 1,
    });
    const cleared = await a.db.select<{ cleared_through_date: string }[]>(
      "SELECT cleared_through_date FROM sync_recurrence_clears",
    );
    expect(cleared).toEqual([{ cleared_through_date: "2026-03-18" }]);
  });

  it("worked example, A receives B: A completes Mar 15 while B generates Mar 16", async () => {
    const { sim, a, b } = await recurringPair();
    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-15T20:00:00.000Z");
    b.clock.advance(60_000);
    await b.repo.generateDueRecurringTasks("2026-03-16");
    expect(await occurrences(b)).toEqual({ "2026-03-15": "missed", "2026-03-16": "active" });
    await sim.exchange(b, a, "gtd");
    await sim.exchange(a, b, "gtd");
    await sim.syncAll("gtd");
    await assertWorkedExample(sim, a, b);
  });

  it("worked example, B receives A first", async () => {
    const { sim, a, b } = await recurringPair();
    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-15T20:00:00.000Z");
    b.clock.advance(60_000);
    await b.repo.generateDueRecurringTasks("2026-03-16");
    await sim.exchange(a, b, "gtd");
    await sim.exchange(b, a, "gtd");
    await sim.syncAll("gtd");
    await assertWorkedExample(sim, a, b);
  });

  it("a backlog cleared on A stays cleared when B republishes an unrelated edit with its old count", async () => {
    const { sim, a, b } = await recurringPair();
    b.clock.advance(1_000);
    await b.repo.generateDueRecurringTasks("2026-03-18");
    await sim.syncAll("gtd");
    expect((await findTask(a, INSTANCE_ID)).pendingPastRecurrences).toBe(3);

    a.clock.advance(60_000);
    await a.repo.clearPastRecurrences(INSTANCE_ID);
    expect((await findTask(a, INSTANCE_ID)).pendingPastRecurrences).toBe(0);

    b.clock.advance(120_000); // B never saw the clear and edits something else
    await b.repo.saveTask({ ...(await findTask(b, INSTANCE_ID)), notes: "unrelated" });
    await sim.exchange(b, a, "gtd");
    await sim.exchange(a, b, "gtd");
    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await findTask(device, INSTANCE_ID)).toMatchObject({
        pendingPastRecurrences: 0,
        notes: "unrelated",
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("the clear watermark only moves forward: an older clear arriving later changes nothing", async () => {
    const { sim, a, b } = await recurringPair();
    b.clock.advance(1_000);
    await b.repo.generateDueRecurringTasks("2026-03-19");
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await a.repo.clearPastRecurrences(INSTANCE_ID); // through 2026-03-18
    const clears = () =>
      a.db.select<{ cleared_through_date: string }[]>(
        "SELECT cleared_through_date FROM sync_recurrence_clears",
      );
    expect(await clears()).toEqual([{ cleared_through_date: "2026-03-18" }]);

    const stale = JSON.parse(JSON.stringify(await b.repo.listSyncChanges("gtd")));
    stale.recurrence.clears = [{ template_id: TEMPLATE_ID, cleared_through_date: "2026-03-16" }];
    await a.repo.applySyncBundle("gtd", stale);
    expect(await clears()).toEqual([{ cleared_through_date: "2026-03-18" }]);
    expect(await findTask(a, INSTANCE_ID)).toMatchObject({ pendingPastRecurrences: 0 });
    // A newer one does move it.
    stale.recurrence.clears = [{ template_id: TEMPLATE_ID, cleared_through_date: "2026-03-19" }];
    await a.repo.applySyncBundle("gtd", stale);
    expect(await clears()).toEqual([{ cleared_through_date: "2026-03-19" }]);
  });

  it("a stale template card that nulled the watermark does not turn the user's cancel into a pull-back", async () => {
    const { sim, a, b } = await recurringPair();
    // The card was loaded before the first generation, so it still holds `lastGeneratedForDate: null`.
    a.clock.advance(1_000);
    await a.repo.saveRecurringTaskTemplate(template({ title: "Water (edited)" }));
    expect((await a.repo.listRecurringTaskTemplates())[0]?.lastGeneratedForDate).toBeNull();

    a.clock.advance(1_000);
    await a.repo.cancelTask(INSTANCE_ID);
    expect(await occurrences(a)).toEqual({ "2026-03-15": "cancelled" });

    await sim.syncAll("gtd");
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect(await occurrences(device)).toEqual({ "2026-03-15": "cancelled" });
      expect(await findTask(device, INSTANCE_ID)).toMatchObject({ status: "cancelled" });
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("complete against missed for one occurrence: the user's outcome wins whatever the clocks", async () => {
    const { sim, a, b } = await recurringPair();
    b.clock.advance(120_000); // B's generation carries the LATER clock
    await b.repo.generateDueRecurringTasks("2026-03-16");
    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-15T20:00:00.000Z");
    await sim.syncAll("gtd");
    expect((await occurrences(a))["2026-03-15"]).toBe("completed");
    expect((await occurrences(b))["2026-03-15"]).toBe("completed");
  });

  it("complete against cancel for one occurrence raises a terminal_divergence conflict and still converges", async () => {
    const { sim, a, b } = await recurringPair();
    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-15T20:00:00.000Z");
    b.clock.advance(60_000);
    await b.repo.cancelTask(INSTANCE_ID);
    await sim.syncAll("gtd");
    await sim.syncAll("gtd");
    expect(await occurrences(a)).toEqual({ "2026-03-15": "cancelled" });
    expect(await findTask(a, INSTANCE_ID)).toMatchObject({
      status: "cancelled",
      completedAt: null,
    });
    for (const device of [a, b]) {
      const found = await kinds(device, "terminal_divergence");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ entity_type: "gtd_tasks", entity_id: INSTANCE_ID });
    }
    expect((await kinds(a, "terminal_divergence"))[0]?.id).toBe(
      (await kinds(b, "terminal_divergence"))[0]?.id,
    );
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("both laptops generating the same day converge on one occurrence and one instance, then stay idle", async () => {
    const { sim, a, b } = await recurringPair();
    a.clock.advance(1_000);
    b.clock.advance(2_000);
    for (const device of [a, b]) {
      expect(await device.repo.generateDueRecurringTasks("2026-03-17")).toBe(1);
      expect(await device.repo.promoteDueScheduledTasks("2026-03-17")).toBe(0);
    }
    await sim.syncAll("gtd");
    await sim.expectConverged("gtd", { snapshots: true });
    expect(await occurrences(a)).toEqual({
      "2026-03-15": "missed",
      "2026-03-16": "missed",
      "2026-03-17": "active",
    });
    const instances = (await a.repo.listTasks({ includeCompleted: true })).filter(
      (task) => task.isRecurringInstance,
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      recurrenceDueDate: "2026-03-17",
      pendingPastRecurrences: 2,
    });
    for (const device of [a, b]) {
      const before = await syncState(device.db);
      expect(await device.repo.generateDueRecurringTasks("2026-03-17")).toBe(0);
      expect(await device.repo.promoteDueScheduledTasks("2026-03-17")).toBe(0);
      expect(await syncState(device.db)).toEqual(before);
    }
  });

  it("an applied instance row and template carry snapshots: a verifying scan restamps nothing", async () => {
    const { sim, a, b } = await recurringPair();
    a.clock.advance(1_000);
    await a.repo.completeTask(INSTANCE_ID, "2026-03-15T20:00:00.000Z");
    b.clock.advance(60_000);
    await b.repo.generateDueRecurringTasks("2026-03-16");
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      const before = await syncState(device.db);
      const sidecars = await occurrences(device);
      await device.stamp();
      expect(await syncState(device.db)).toEqual(before);
      expect(await occurrences(device)).toEqual(sidecars);
    }
  });

  it("the baseline pass records the occurrence of an instance that was stamped before the sidecars existed", async () => {
    const { a } = await recurringPair();
    await a.db.execute("DELETE FROM sync_recurrence_occurrences");
    expect(await occurrences(a)).toEqual({});
    const before = await readIdentity(a.db);
    await a.stamp();
    expect(await occurrences(a)).toEqual({ "2026-03-15": "active" });
    expect((await readIdentity(a.db))?.change_counter).toBe((before?.change_counter ?? 0) + 1);
    const settled = await syncState(a.db);
    await a.stamp();
    expect(await syncState(a.db)).toEqual(settled);
  });

  it("publishes the sidecars in the gtd change set only", async () => {
    const { a } = await recurringPair();
    const gtd = await a.repo.listSyncChanges("gtd");
    expect(gtd.recurrence.occurrences).toHaveLength(1);
    expect((await a.repo.listSyncChanges("personal")).recurrence).toEqual({
      occurrences: [],
      clears: [],
    });
    expect(await maybeTask(a, INSTANCE_ID)).toBeDefined();
  });
});

describe("time zones: a laptop whose local day is behind", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("its generator pull-back of a premature instance is not propagated as a cancellation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sim, a: y, b: x } = await twoDevices();
    // Laptop Y is ahead (local day Oct 21), laptop X still on Oct 20.
    vi.setSystemTime(new Date(2026, 9, 21, 1, 0, 0));
    await y.repo.saveRecurringTaskTemplate(template({ startDate: "2026-10-21" }));
    await sim.syncAll("gtd");
    y.clock.advance(1_000);
    expect(await y.repo.generateDueRecurringTasks("2026-10-21")).toBe(1);
    await sim.exchange(y, x, "gtd");
    expect(await findTask(x, INSTANCE_ID)).toMatchObject({
      recurrenceDueDate: "2026-10-21",
      status: "active",
    });

    // X's generator sees an instance from the future with nothing earlier to fall back to, cancels it
    // and clears the template watermark: bookkeeping, not a decision of the user.
    vi.setSystemTime(new Date(2026, 9, 20, 23, 0, 0));
    x.clock.advance(60_000);
    await x.repo.generateDueRecurringTasks("2026-10-20");
    expect(await findTask(x, INSTANCE_ID)).toMatchObject({ status: "cancelled" });
    expect((await x.repo.listRecurringTaskTemplates())[0]?.lastGeneratedForDate).toBeNull();
    expect(await occurrences(x)).toEqual({ "2026-10-21": "active" });

    await sim.syncAll("gtd");
    await sim.syncAll("gtd");

    for (const device of [y, x]) {
      expect(await occurrences(device)).toEqual({ "2026-10-21": "active" });
      expect(await findTask(device, INSTANCE_ID)).toMatchObject({
        status: "active",
        recurrenceDueDate: "2026-10-21",
        completedAt: null,
      });
      expect((await device.repo.listRecurringTaskTemplates())[0]?.lastGeneratedForDate).toBe(
        "2026-10-21",
      );
      expect(await kinds(device, "terminal_divergence")).toEqual([]);
    }
    await sim.expectConverged("gtd", { snapshots: true });

    // X's next morning: the occurrence is active on both, and nothing needs regenerating.
    vi.setSystemTime(new Date(2026, 9, 21, 7, 0, 0));
    x.clock.advance(60_000);
    for (const device of [y, x]) {
      expect(await device.repo.generateDueRecurringTasks("2026-10-21")).toBe(0);
    }
    await sim.syncAll("gtd");
    for (const device of [y, x]) {
      expect(await findTask(device, INSTANCE_ID)).toMatchObject({
        status: "active",
        recurrenceDueDate: "2026-10-21",
      });
    }
  });

  it("generating forward from the pull-back residue on a later day does not turn the date into a user cancel", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sim, a: y, b: x } = await twoDevices();
    vi.setSystemTime(new Date(2026, 9, 21, 1, 0, 0));
    await y.repo.saveRecurringTaskTemplate(template({ startDate: "2026-10-21" }));
    await sim.syncAll("gtd");
    y.clock.advance(1_000);
    await y.repo.generateDueRecurringTasks("2026-10-21");
    await sim.exchange(y, x, "gtd");

    // X pulls the premature instance back and does NOT sync again ...
    vi.setSystemTime(new Date(2026, 9, 20, 23, 0, 0));
    x.clock.advance(60_000);
    await x.repo.generateDueRecurringTasks("2026-10-20");
    expect(await findTask(x, INSTANCE_ID)).toMatchObject({ status: "cancelled" });
    // ... Y completes the occurrence meanwhile ...
    y.clock.advance(120_000);
    await y.repo.completeTask(INSTANCE_ID, "2026-10-21T09:00:00.000Z");
    // ... and two days later X's generator builds the next instance on the same row id.
    vi.setSystemTime(new Date(2026, 9, 22, 7, 0, 0));
    x.clock.advance(600_000); // X's clocks are the later ones
    await x.repo.generateDueRecurringTasks("2026-10-22");
    expect(await findTask(x, INSTANCE_ID)).toMatchObject({
      status: "active",
      recurrenceDueDate: "2026-10-22",
    });
    expect(await occurrences(x)).toEqual({ "2026-10-21": "missed", "2026-10-22": "active" });

    await sim.syncAll("gtd");
    await sim.syncAll("gtd");
    for (const device of [y, x]) {
      // The completion survives: X's residue never became a cancel that could outrank it.
      expect(await occurrences(device)).toEqual({
        "2026-10-21": "completed",
        "2026-10-22": "active",
      });
      expect(await kinds(device, "terminal_divergence")).toEqual([]);
      expect(await findTask(device, INSTANCE_ID)).toMatchObject({
        status: "active",
        recurrenceDueDate: "2026-10-22",
      });
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("a pull-back to an earlier due date adds one event, not one per exchange", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sim, a: y, b: x } = await twoDevices();
    vi.setSystemTime(new Date(2026, 9, 21, 1, 0, 0));
    await y.repo.saveRecurringTaskTemplate(template({ startDate: "2026-10-15" }));
    await sim.syncAll("gtd");
    y.clock.advance(1_000);
    await y.repo.generateDueRecurringTasks("2026-10-21");
    await sim.syncAll("gtd");
    const opened = async (device: SyncDevice) =>
      (await device.repo.listTaskEvents({ types: ["task_moved_to_next_action"] })).filter(
        (event) => event.taskId === INSTANCE_ID,
      );
    const baseline = (await opened(x)).length;

    // X is still on Oct 20: its generator pulls the instance back to Oct 20, over and over as every
    // exchange restores Oct 21.
    vi.setSystemTime(new Date(2026, 9, 20, 23, 0, 0));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      x.clock.advance(60_000);
      await x.repo.generateDueRecurringTasks("2026-10-20");
      expect(await findTask(x, INSTANCE_ID)).toMatchObject({ recurrenceDueDate: "2026-10-20" });
      await sim.syncAll("gtd");
    }
    for (const device of [y, x]) {
      expect(await opened(device)).toHaveLength(baseline + 1);
    }
    expect((await opened(x)).filter((event) => event.eventDate === "2026-10-20")).toHaveLength(1);
  });
});
