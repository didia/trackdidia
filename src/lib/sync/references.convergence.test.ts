// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WeeklyObjective, WeeklyObjectiveResult } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import {
  createSyncHarness,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Objective (parent) and result (child, ON DELETE CASCADE) through three simulated laptops with
 * foreign keys enforced, as production does. Each scenario ends with the three final bundles
 * applied to fresh replicas in all six orders, with a duplicate: every replica must hold the same
 * rows, clocks and snapshots, the foreign keys must hold, and the laptops themselves must converge
 * to the same state once they have exchanged everything.
 */

const W1 = "2026-10-04";
const W2 = "2026-10-11";
const W3 = "2026-10-18";

const objective = (id: string, overrides: Partial<WeeklyObjective> = {}): WeeklyObjective => ({
  id,
  title: `Objective ${id}`,
  kind: "manual",
  targetHours: null,
  rescuetimeKind: null,
  rescuetimeThing: null,
  sortOrder: 0,
  startsOnWeekStartDate: null,
  endsOnWeekStartDate: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const result = (objectiveId: string, week: string, achieved = false): WeeklyObjectiveResult => ({
  weekStartDate: week,
  objectiveId,
  achieved,
  updatedAt: "2026-10-05T00:00:00.000Z",
});

const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * The rows, clocks and snapshots of the two tables. With `maskTombstones` the clock of a tombstone
 * is hidden: a tombstone a replica had to invent (a child edited later than its parent's delete)
 * carries a clock of THAT replica, so replicas hold different, all valid, tombstone clocks until
 * they exchange (then tombstone-vs-tombstone max makes them identical).
 */
const scenarioState = async (
  sim: SyncHarness,
  device: SyncDevice,
  maskTombstones = false,
): Promise<string> => {
  const dump = await sim.dump(device, "personal", { snapshots: true, exact: true });
  const mine = (row: Record<string, unknown>) =>
    row.entity_type === "weekly_objectives" || row.entity_type === "weekly_objective_results";
  return JSON.stringify({
    objectives: dump.tables.weekly_objectives,
    results: dump.tables.weekly_objective_results,
    meta: dump.meta
      .filter(mine)
      .map((row) =>
        maskTombstones && row.deleted_at !== null
          ? { ...row, row_hlc: "<tombstone>", deleted_at: "<tombstone>" }
          : row,
      ),
    snapshots: (dump.snapshots ?? []).filter(mine),
  });
};

/** A tombstone is later than every clock it retains: an equal clock would keep the edit. */
const expectTombstonesOutrankClocks = async (device: SyncDevice): Promise<void> => {
  const metas = await device.db.select<
    { entity_type: string; entity_id: string; field_clocks_json: string; deleted_at: string }[]
  >(
    "SELECT entity_type, entity_id, field_clocks_json, deleted_at FROM sync_entity_meta WHERE deleted_at IS NOT NULL AND entity_type LIKE 'weekly%'",
  );
  for (const meta of metas) {
    for (const clock of Object.values(
      JSON.parse(meta.field_clocks_json) as Record<string, string>,
    )) {
      expect(
        meta.deleted_at > clock,
        `${device.name}: ${meta.entity_type} ${meta.entity_id} tombstone ${meta.deleted_at} vs retained ${clock}`,
      ).toBe(true);
    }
  }
};

const foreignKeyViolations = (device: SyncDevice) => device.db.select("PRAGMA foreign_key_check");

/** Applies the final bundles of the three laptops in every order and checks everything converged. */
const expectEveryOrderConverges = async (
  sim: SyncHarness,
  options: { settle?: boolean } = {},
): Promise<string> => {
  const bundles = await Promise.all(
    sim.devices.map(async (device) => jsonRoundTrip(await device.repo.listSyncChanges("personal"))),
  );
  const replicas = await createSyncHarness(ORDERS.length, { deviceIndexOffset: 10 });
  const states: string[] = [];
  for (const [index, order] of ORDERS.entries()) {
    const replica = replicas.devices[index] as SyncDevice;
    for (const position of [...order, order[0] as number]) {
      await replica.repo.applySyncBundle("personal", bundles[position] as SyncChangeSet);
    }
    expect(await foreignKeyViolations(replica), `order ${order.join("")}`).toEqual([]);
    expect(await replica.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
    const again = await replica.repo.applySyncBundle(
      "personal",
      bundles[order[0] as number] as SyncChangeSet,
    );
    expect(again, `order ${order.join("")}`).toMatchObject({ applied: 0, tombstonesApplied: 0 });
    states.push(await scenarioState(replicas, replica));
  }
  if (options.settle === true) {
    // The parent was deleted only transiently (a later parent edit brought it back): a child edit
    // applied inside that window is dropped by the replicas that saw that order (a tombstone later
    // than the edit), kept by the others. Replicas still converge once they exchange; the laptops
    // are not compared with the replicas here (the window can differ).
    await replicas.syncAll("personal");
    states.length = 0;
    for (const replica of replicas.devices) states.push(await scenarioState(replicas, replica));
    expect(new Set(states).size, "replicas after exchange").toBe(1);
    await sim.syncAll("personal");
    await sim.expectConverged("personal", { snapshots: true });
    for (const device of [...replicas.devices, ...sim.devices]) {
      expect(await foreignKeyViolations(device)).toEqual([]);
      await expectTombstonesOutrankClocks(device);
    }
    return states[0] as string;
  }
  // One pass: the same rows and live metadata in every order. A tombstone invented by a replica
  // has a clock of that replica, so those clocks are masked here ...
  const masked: string[] = [];
  for (const replica of replicas.devices) masked.push(await scenarioState(replicas, replica, true));
  expect(new Set(masked).size, "every application order").toBe(1);
  for (const replica of replicas.devices) await expectTombstonesOutrankClocks(replica);

  // ... and are identical once the replicas exchange (tombstone against tombstone: the later).
  await replicas.syncAll("personal");
  states.length = 0;
  for (const replica of replicas.devices) states.push(await scenarioState(replicas, replica));
  expect(new Set(states).size, "replicas after exchange").toBe(1);

  // The laptops themselves, after exchanging everything, hold the same rows and live metadata.
  await sim.syncAll("personal");
  await sim.expectConverged("personal", { snapshots: true });
  for (const device of sim.devices) {
    expect(await foreignKeyViolations(device)).toEqual([]);
    await expectTombstonesOutrankClocks(device);
  }
  expect(await scenarioState(sim, sim.devices[0] as SyncDevice, true)).toBe(masked[0]);
  return states[0] as string;
};

const base = async () => {
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  await a.repo.saveWeeklyObjective(objective("o1"));
  await a.repo.saveWeeklyObjectiveResult(result("o1", W1));
  await a.repo.saveWeeklyObjectiveResult(result("o1", W2));
  await sim.syncAll("personal");
  return { sim, a, b, c };
};

const rawResult = async (device: SyncDevice, week: string, sets: string) => {
  await device.db.execute(
    `UPDATE weekly_objective_results SET ${sets} WHERE week_start_date = $1`,
    [week],
  );
  await device.stamp();
};

const rows = async (device: SyncDevice) => ({
  objectives: (await device.repo.listWeeklyObjectives()).map((o) => o.id),
  results: (
    await device.db.select<{ week_start_date: string; achieved: number }[]>(
      "SELECT week_start_date, achieved FROM weekly_objective_results ORDER BY week_start_date",
    )
  ).map((r) => `${r.week_start_date}:${r.achieved}`),
});

describe("an objective deleted on A while B edits one of its results", () => {
  for (const [label, editDelayMs] of [
    ["the edit is later than the delete", 90_000],
    ["the edit is earlier than the delete", -500],
  ] as const) {
    it(`(${label}) the objective and every result are gone everywhere, in every order`, async () => {
      const { sim, a, b } = await base();
      b.clock.advance(Math.max(0, editDelayMs));
      a.clock.advance(1_000 + Math.max(0, -editDelayMs) + 1_000);
      await rawResult(b, W1, "achieved = 1");
      await a.repo.deleteWeeklyObjective("o1");
      await expectEveryOrderConverges(sim);
      for (const device of sim.devices) {
        expect(await rows(device)).toEqual({ objectives: [], results: [] });
      }
    });
  }

  it("a result edit never inserts a result under a deleted objective, and logs it", async () => {
    const { sim, a, b } = await base();
    a.clock.advance(1_000);
    await a.repo.deleteWeeklyObjective("o1");
    b.clock.advance(90_000);
    await rawResult(b, W1, "achieved = 1");
    // A receives B's edit for the objective it deleted: skipped as an orphan, bundle not aborted.
    await sim.exchange(b, a, "personal");
    expect(await rows(a)).toEqual({ objectives: [], results: [] });
    const logged = (await readConflicts(a)).filter((row) => row.kind === "orphaned_child");
    expect(logged.map((row) => row.entity_id)).toEqual([JSON.stringify([W1, "o1"])]);
    // B receives the parent tombstone: its result is tombstoned by the apply, not left as a ghost.
    await sim.exchange(a, b, "personal");
    expect(await rows(b)).toEqual({ objectives: [], results: [] });
    expect(await foreignKeyViolations(b)).toEqual([]);
    const meta = await b.db.select<{ entity_id: string; deleted_at: string | null }[]>(
      "SELECT entity_id, deleted_at FROM sync_entity_meta WHERE entity_type = 'weekly_objective_results' ORDER BY entity_id",
    );
    expect(meta).toHaveLength(2);
    expect(meta.every((row) => row.deleted_at !== null)).toBe(true);
    expect(
      await b.db.select(
        "SELECT 1 FROM sync_entity_snapshot WHERE entity_type = 'weekly_objective_results'",
      ),
    ).toEqual([]);
    await sim.syncAll("personal");
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("tombstones the results of a deleted parent that the bundle does not mention (a result only the receiver has)", async () => {
    const { sim, a, b } = await base();
    b.clock.advance(5_000);
    await b.repo.saveWeeklyObjectiveResult(result("o1", W3)); // A has never heard of this result
    a.clock.advance(60_000);
    await a.repo.deleteWeeklyObjective("o1");
    await sim.exchange(a, b, "personal");
    expect(await rows(b)).toEqual({ objectives: [], results: [] });
    const tombstone = (
      await b.db.select<{ deleted_at: string | null; row_hlc: string }[]>(
        "SELECT deleted_at, row_hlc FROM sync_entity_meta WHERE entity_type = 'weekly_objective_results' AND entity_id = $1",
        [JSON.stringify([W3, "o1"])],
      )
    )[0];
    // Dated with the parent's deletedAt (the child's own newest clock is older).
    const parent = (
      await b.db.select<{ deleted_at: string }[]>(
        "SELECT deleted_at FROM sync_entity_meta WHERE entity_type = 'weekly_objectives' AND entity_id = 'o1'",
      )
    )[0];
    expect(tombstone?.deleted_at).toBe(parent?.deleted_at);
    expect(tombstone?.row_hlc).toBe(parent?.deleted_at);
    await expectEveryOrderConverges(sim);
  });

  it("an objective edit later than the delete brings the parent back (edit wins over delete applies to the parent), with the results re-edited later", async () => {
    const { sim, a, b, c } = await base();
    a.clock.advance(1_000);
    await a.repo.deleteWeeklyObjective("o1");
    c.clock.advance(120_000);
    await c.repo.saveWeeklyObjective(objective("o1", { title: "Renamed on C" }));
    b.clock.advance(180_000);
    await rawResult(b, W1, "achieved = 1"); // later than the delete of the result
    await expectEveryOrderConverges(sim, { settle: true });
    for (const device of sim.devices) {
      expect((await rows(device)).objectives).toEqual(["o1"]);
      expect((await device.repo.listWeeklyObjectives())[0]?.title).toBe("Renamed on C");
      // The result of the other week was deleted with the objective and nobody edited it since.
      expect((await rows(device)).results.every((entry) => entry.startsWith(W1))).toBe(true);
    }
  });
});

describe("both laptops create results", () => {
  it("different weeks, the same week with different values, and a new result next to a deleted objective", async () => {
    const { sim, a, b, c } = await base();
    a.clock.advance(1_000);
    await a.repo.saveWeeklyObjectiveResult(result("o1", W3, false));
    b.clock.advance(2_000);
    await b.repo.saveWeeklyObjectiveResult(result("o1", W3, true)); // same key, later value
    c.clock.advance(3_000);
    await c.repo.saveWeeklyObjective(objective("o2"));
    await c.repo.saveWeeklyObjectiveResult(result("o2", W1, false));
    await expectEveryOrderConverges(sim);
    for (const device of sim.devices) {
      expect((await rows(device)).objectives).toEqual(["o1", "o2"]);
    }
    const w3 = (
      await b.db.select<{ achieved: number }[]>(
        "SELECT achieved FROM weekly_objective_results WHERE week_start_date = $1 AND objective_id = 'o1'",
        [W3],
      )
    )[0];
    expect(w3?.achieved).toBe(1);
  });

  it("a result created for an objective that is deleted elsewhere is tombstoned, not kept", async () => {
    const { sim, a, b } = await base();
    a.clock.advance(1_000);
    await a.repo.deleteWeeklyObjective("o1");
    b.clock.advance(2_000);
    await b.repo.saveWeeklyObjectiveResult(result("o1", W3, false));
    await expectEveryOrderConverges(sim);
    for (const device of sim.devices) {
      expect(await rows(device)).toEqual({ objectives: [], results: [] });
    }
  });
});

describe("concurrent edits of different fields", () => {
  it("keeps both: achieved from one laptop, updated_at from the other, and the objective's title from a third", async () => {
    const { sim, a, b, c } = await base();
    a.clock.advance(1_000);
    await rawResult(a, W1, "achieved = 1");
    b.clock.advance(2_000);
    await rawResult(b, W1, "updated_at = '2026-10-09T09:09:09.000Z'");
    c.clock.advance(3_000);
    await c.repo.saveWeeklyObjective(objective("o1", { title: "Renamed on C", sortOrder: 4 }));
    await expectEveryOrderConverges(sim);
    for (const device of sim.devices) {
      const row = (
        await device.db.select<{ achieved: number; updated_at: string }[]>(
          "SELECT achieved, updated_at FROM weekly_objective_results WHERE week_start_date = $1",
          [W1],
        )
      )[0];
      expect(row).toEqual({ achieved: 1, updated_at: "2026-10-09T09:09:09.000Z" });
      expect((await device.repo.listWeeklyObjectives())[0]).toMatchObject({
        title: "Renamed on C",
        sortOrder: 4,
      });
    }
  });
});
