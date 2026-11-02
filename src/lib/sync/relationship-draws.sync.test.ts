// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Task } from "../../domain/types";
import { syncState } from "./capture-test-utils";
import {
  createSyncHarness,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * Relationship draws on two personal laptops (spec: "Generators on several full peers"): new draws
 * are deterministic, so two laptops that draw the same day while offline create the IDENTICAL row and
 * merging it is a no-op; a draw made before the change keeps its random id and meets a deterministic
 * one through canonical identity.
 */

const DATE = "2026-10-03";
const SOURCE = `relationship-draw:children:${DATE}`;

const enableDraws = (device: SyncDevice) =>
  device.repo.updateSettings((current) => ({
    ...current,
    relationshipDrawsEnabled: true,
    relationshipDrawChildrenActivities: ["jouer", "lire", "dessiner", "cuisiner"],
    relationshipDrawSpouseActivities: ["diner", "marcher", "cinema"],
  }));

const drawTasks = async (device: SyncDevice): Promise<Task[]> =>
  (await device.repo.listTasks({ includeCompleted: true })).filter((task) =>
    task.sourceExternalId?.startsWith("relationship-draw:"),
  );

const aliases = (device: SyncDevice) => device.db.select("SELECT * FROM sync_id_aliases");

describe("two personal laptops draw the same day while offline", () => {
  it("create the identical rows, and merging them is a no-op: no alias, no conflict", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await enableDraws(a);
    await enableDraws(b);
    expect(await a.repo.generateDailyRelationshipTasks(DATE)).toBe(2);
    b.clock.advance(5_000);
    expect(await b.repo.generateDailyRelationshipTasks(DATE)).toBe(2);

    const [taskA, spouseA] = await drawTasks(a);
    const [taskB, spouseB] = await drawTasks(b);
    expect(taskA?.id).toBe(`task:${SOURCE}`);
    expect(taskA?.id).toBe(taskB?.id);
    expect(spouseA?.id).toBe(spouseB?.id);
    expect(taskA?.title).toBe(taskB?.title);
    expect(spouseA?.title).toBe(spouseB?.title);
    expect(taskA?.createdAt).toBe(`${DATE}T00:00:00.000Z`);

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await drawTasks(device)).toHaveLength(2);
      expect(await aliases(device)).toEqual([]);
      expect(
        (await readConflicts(device)).filter((row) => row.entity_type === "gtd_tasks"),
      ).toEqual([]);
      const before = await syncState(device.db);
      expect(await device.repo.enableSyncCapture()).toMatchObject({
        installed: false,
        backfilled: 0,
        backfillComplete: true,
      });
      expect(await syncState(device.db)).toEqual(before);
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("a completion made on either laptop survives", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await enableDraws(a);
    await enableDraws(b);
    await a.repo.generateDailyRelationshipTasks(DATE);
    b.clock.advance(5_000);
    await b.repo.generateDailyRelationshipTasks(DATE);
    a.clock.advance(60_000);
    await a.repo.completeTask(`task:${SOURCE}`, `${DATE}T20:00:00.000Z`);
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect(
        (await drawTasks(device)).find((task) => task.sourceExternalId === SOURCE),
      ).toMatchObject({
        status: "completed",
      });
    }
  });
});

describe("two laptops whose activity lists differ", () => {
  it("share the deterministic id: the rows merge by field clocks, the later title wins, no alias", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await enableDraws(a);
    await b.repo.updateSettings((current) => ({
      ...current,
      relationshipDrawsEnabled: true,
      relationshipDrawChildrenActivities: ["pique-nique"],
      relationshipDrawSpouseActivities: ["theatre"],
    }));
    await a.repo.generateDailyRelationshipTasks(DATE);
    b.clock.advance(60_000);
    await b.repo.generateDailyRelationshipTasks(DATE);

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      const draws = (await drawTasks(device)).filter((task) => task.sourceExternalId === SOURCE);
      expect(draws.map((task) => [task.id, task.title])).toEqual([
        [`task:${SOURCE}`, "Avec enfants : pique-nique"],
      ]);
      expect(await aliases(device)).toEqual([]);
    }
    const lost = (await readConflicts(a)).filter(
      (row) => row.kind === "overwritten_edit" && row.entity_type === "gtd_tasks",
    );
    expect(lost.length).toBeGreaterThan(0);
    await sim.expectConverged("gtd", { snapshots: true });
  });
});

describe("a draw made before the change meets a deterministic one", () => {
  it("collides on source_external_id and merges: the completion on the old copy survives", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await enableDraws(b);
    // Laptop A drew this day with the previous random id and has already done the activity.
    await a.repo.createTask({
      id: "task:0f3e7a52-8d1c-4b6e-9a47-2c5d19e8b0a1",
      title: "Avec enfants : jouer",
      notes: "old",
      bucket: "next_action",
      sourceExternalId: SOURCE,
      createdAt: `${DATE}T00:00:00.000Z`,
      updatedAt: `${DATE}T00:00:00.000Z`,
    });
    a.clock.advance(60_000);
    await a.repo.completeTask("task:0f3e7a52-8d1c-4b6e-9a47-2c5d19e8b0a1", `${DATE}T20:00:00.000Z`);
    await b.repo.generateDailyRelationshipTasks(DATE);

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      const draw = (await drawTasks(device)).filter((task) => task.sourceExternalId === SOURCE);
      expect(draw.map((task) => task.id)).toEqual(["task:0f3e7a52-8d1c-4b6e-9a47-2c5d19e8b0a1"]);
      expect(draw[0]).toMatchObject({ status: "completed" });
      expect(await aliases(device)).toEqual([
        expect.objectContaining({
          entity_type: "gtd_tasks",
          alias_id: `task:${SOURCE}`,
          canonical_id: "task:0f3e7a52-8d1c-4b6e-9a47-2c5d19e8b0a1",
        }),
      ]);
      // Its events follow the canonical id.
      expect(
        await device.db.select(`SELECT 1 FROM gtd_task_events WHERE task_id = 'task:${SOURCE}'`),
      ).toEqual([]);
      const before = await syncState(device.db);
      expect(await device.repo.enableSyncCapture()).toMatchObject({
        installed: false,
        backfilled: 0,
        backfillComplete: true,
      });
      expect(await syncState(device.db)).toEqual(before);
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });
});
