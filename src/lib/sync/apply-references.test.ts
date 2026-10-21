// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WeeklyObjective } from "../../domain/types";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import { orderByReferences, readForeignKeyEdges, ReferenceGuard } from "./apply-references";
import { readIdentity, readMarks } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import { encodeHlc, parseHlc } from "./hlc";
import { SyncApplyError } from "./errors";
import {
  createSyncHarness,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON change sets
type Draft = Record<string, any>;

const objective = (id: string): WeeklyObjective => ({
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
});

const W1 = "2026-10-04";
const resultId = (objectiveId: string, week = W1) => JSON.stringify([week, objectiveId]);

describe("foreign key edges", () => {
  it("are read from the migrated schema, not listed per table", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    expect(await readForeignKeyEdges(db)).toEqual([
      {
        childTable: "ai_proposals",
        childColumn: "message_id",
        parentTable: "ai_messages",
        parentColumn: "id",
        onDelete: "CASCADE",
      },
      {
        childTable: "weekly_objective_results",
        childColumn: "objective_id",
        parentTable: "weekly_objectives",
        parentColumn: "id",
        onDelete: "CASCADE",
      },
    ]);
  });

  it("refuses a delete action the apply path has no rule for", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    // A synthetic key: SET NULL on a table whose parent sync can delete.
    await db.execute("PRAGMA foreign_keys = OFF");
    await db.execute("DROP TABLE weekly_objective_results");
    await db.execute(
      `CREATE TABLE weekly_objective_results (
         week_start_date TEXT NOT NULL, objective_id TEXT, achieved INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT NOT NULL, PRIMARY KEY (week_start_date, objective_id),
         FOREIGN KEY (objective_id) REFERENCES weekly_objectives(id) ON DELETE SET NULL)`,
    );
    await expect(ReferenceGuard.create(db, 1_800_000_000_000)).rejects.toMatchObject({
      name: "SyncApplyError",
      code: "unsupported_foreign_key",
    });
  });
});

describe("orderByReferences", () => {
  const edges = [
    {
      childTable: "c",
      childColumn: "p",
      parentTable: "p",
      parentColumn: "id",
      onDelete: "CASCADE",
    },
    {
      childTable: "g",
      childColumn: "c",
      parentTable: "c",
      parentColumn: "id",
      onDelete: "CASCADE",
    },
  ];

  it("puts parents before children, grandparents first, and leaves the rest in place", () => {
    expect(orderByReferences(["g", "x", "c", "p"], edges)).toEqual(["p", "c", "g", "x"]);
    expect(orderByReferences(["x", "p", "c"], edges)).toEqual(["x", "p", "c"]);
  });

  it("ignores a parent that is not in the list and does not loop on a cycle", () => {
    expect(orderByReferences(["c"], edges)).toEqual(["c"]);
    const cycle = [
      ...edges,
      {
        childTable: "p",
        childColumn: "g",
        parentTable: "g",
        parentColumn: "id",
        onDelete: "CASCADE",
      },
    ];
    expect(orderByReferences(["g", "c", "p"], cycle).sort()).toEqual(["c", "g", "p"]);
  });

  it("orders a union parent before the entity table that references it (messages, proposals)", () => {
    const real = [
      {
        childTable: "ai_proposals",
        childColumn: "message_id",
        parentTable: "ai_messages",
        parentColumn: "id",
        onDelete: "CASCADE",
      },
    ];
    expect(orderByReferences(["ai_proposals", "ai_messages"], real)).toEqual([
      "ai_messages",
      "ai_proposals",
    ]);
  });
});

describe("objectives and results through applySyncBundle (foreign keys on)", () => {
  const twoDevices = async () => {
    const sim = await createSyncHarness(["A", "B"]);
    return { sim, a: sim.device("A"), b: sim.device("B") };
  };

  const reversed = (changeSet: SyncChangeSet): SyncChangeSet => {
    const draft = jsonRoundTrip(changeSet) as unknown as Draft;
    draft.entities.sort((x: Draft, y: Draft) =>
      x.table < y.table ? 1 : x.table > y.table ? -1 : 0,
    );
    return draft as unknown as SyncChangeSet;
  };

  it("applies a result that comes before its objective in the same bundle", async () => {
    const { a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("o1"));
    await a.repo.saveWeeklyObjectiveResult({
      weekStartDate: W1,
      objectiveId: "o1",
      achieved: false,
      updatedAt: "",
    });
    const bundle = reversed(await a.repo.listSyncChanges("personal"));
    // Reversed registry order: the result is listed before its objective.
    expect(bundle.entities.map((e) => e.table)).toEqual([
      "weekly_objectives",
      "weekly_objective_results",
    ]);
    await b.repo.applySyncBundle("personal", bundle);
    expect((await b.repo.listWeeklyObjectives()).map((o) => o.id)).toEqual(["o1"]);
    expect(await b.repo.getWeeklyObjectiveResults(W1)).toHaveLength(1);
  });

  it("skips a result whose objective never arrives, applies the rest, and applies it with a later bundle", async () => {
    const { a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("o1"));
    await a.repo.saveWeeklyObjectiveResult({
      weekStartDate: W1,
      objectiveId: "o1",
      achieved: false,
      updatedAt: "",
    });
    await a.repo.saveAnnualGoal({
      id: "goal-1",
      title: "Goal",
      dimension: "intellectuelle",
      description: "",
      targetValue: 1,
      unit: "u",
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
    });
    const full = jsonRoundTrip(await a.repo.listSyncChanges("personal"));
    const withoutParent = jsonRoundTrip(full) as unknown as Draft;
    withoutParent.entities = withoutParent.entities.filter(
      (e: Draft) => e.table !== "weekly_objectives",
    );

    const result = await b.repo.applySyncBundle(
      "personal",
      withoutParent as unknown as SyncChangeSet,
    );
    expect(result.conflictsLogged).toBe(1);
    expect((await b.repo.listAnnualGoals()).map((g) => g.id)).toEqual(["goal-1"]); // the rest applied
    expect(await b.repo.getWeeklyObjectiveResults(W1)).toEqual([]);
    expect(
      await b.db.select(
        "SELECT 1 FROM sync_entity_meta WHERE entity_type = 'weekly_objective_results'",
      ),
    ).toEqual([]);
    const logged = await readConflicts(b);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "orphaned_child", entity_id: resultId("o1") });

    await b.repo.applySyncBundle("personal", full);
    expect(await b.repo.getWeeklyObjectiveResults(W1)).toHaveLength(1);
    expect(await b.repo.applySyncBundle("personal", full)).toMatchObject({
      applied: 0,
      conflictsLogged: 0,
    });
    expect(await b.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
  });

  it("a parent tombstone tombstones the cascaded children in the same transaction, with the parent's deletedAt", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("o1"));
    await a.repo.saveWeeklyObjectiveResult({
      weekStartDate: W1,
      objectiveId: "o1",
      achieved: false,
      updatedAt: "",
    });
    await sim.syncAll("personal");
    a.clock.advance(60_000);
    await a.repo.deleteWeeklyObjective("o1");
    // A bundle that carries ONLY the parent's tombstone (the sender never knew a result).
    const bundle = jsonRoundTrip(await a.repo.listSyncChanges("personal")) as unknown as Draft;
    const parentTomb = bundle.entities.find((e: Draft) => e.table === "weekly_objectives");
    bundle.entities = [parentTomb];
    const result = await b.repo.applySyncBundle("personal", bundle as unknown as SyncChangeSet);
    expect(result.tombstonesApplied).toBeGreaterThanOrEqual(2);
    const metas = await b.db.select<
      { entity_type: string; deleted_at: string | null; row_hlc: string }[]
    >(
      "SELECT entity_type, deleted_at, row_hlc FROM sync_entity_meta WHERE entity_type LIKE 'weekly%' ORDER BY entity_type",
    );
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      expect(meta.deleted_at).not.toBeNull();
      expect(meta.row_hlc).toBe(meta.deleted_at);
    }
    // No live meta without a row, no snapshot left, no dirty mark: apply left a clean state.
    expect(
      await b.db.select("SELECT 1 FROM sync_entity_snapshot WHERE entity_type LIKE 'weekly%'"),
    ).toEqual([]);
    expect(await b.db.select("SELECT 1 FROM sync_dirty")).toEqual([]);
    expect(await b.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
  });

  it("rolls everything back, including cascaded tombstones, when a later part of the bundle fails", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("o1"));
    await a.repo.saveWeeklyObjectiveResult({
      weekStartDate: W1,
      objectiveId: "o1",
      achieved: false,
      updatedAt: "",
    });
    await sim.syncAll("personal");
    a.clock.advance(60_000);
    await a.repo.deleteWeeklyObjective("o1");
    const bad = jsonRoundTrip(await a.repo.listSyncChanges("personal")) as unknown as Draft;
    bad.entities = bad.entities.filter((e: Draft) => e.table === "weekly_objectives");
    bad.entities.push({
      table: "annual_goals",
      entityId: "g-bad",
      row: { id: "g-bad", title: null },
      fieldClocks: {},
      rowHlc: bad.hlcHigh,
      deletedAt: null,
    });
    const failure = await b.repo
      .applySyncBundle("personal", bad as unknown as SyncChangeSet)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncApplyError);
    expect(await b.repo.getWeeklyObjectiveResults(W1)).toHaveLength(1);
    expect((await b.repo.listWeeklyObjectives()).map((o) => o.id)).toEqual(["o1"]);
    expect(
      await b.db.select(
        "SELECT deleted_at FROM sync_entity_meta WHERE entity_type LIKE 'weekly%' AND deleted_at IS NOT NULL",
      ),
    ).toEqual([]);
    expect(
      (await b.db.select<{ applying: number }[]>("SELECT applying FROM sync_identity"))[0]
        ?.applying,
    ).toBe(0);
  });

  it("deletes children before the parent: no foreign key violation, whatever the local data", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.saveWeeklyObjective(objective("o1"));
    for (const week of ["2026-10-04", "2026-10-11", "2026-10-18"]) {
      await a.repo.saveWeeklyObjectiveResult({
        weekStartDate: week,
        objectiveId: "o1",
        achieved: false,
        updatedAt: "",
      });
    }
    await sim.syncAll("personal");
    a.clock.advance(60_000);
    await a.repo.deleteWeeklyObjective("o1");
    await sim.exchange(a, b, "personal");
    expect(await (b as SyncDevice).db.select("PRAGMA foreign_key_check")).toEqual([]);
    expect(await b.db.select("SELECT 1 FROM weekly_objective_results")).toEqual([]);
  });

  describe("tombstones invented while applying are clocks of the applying device", () => {
    // B edits a result at B5, later than A's delete of its objective. C holds B's edit and receives
    // A's delete. The tombstone C must write has to be later than B5; it must not be a value derived
    // from B's clock (B6 = counter + 1 on B's id), which B itself issues for its next edit.
    const threeDevices = async () => {
      const sim = await createSyncHarness(["A", "B", "C"]);
      const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
      await a.repo.saveWeeklyObjective(objective("o1"));
      await a.repo.saveWeeklyObjectiveResult({
        weekStartDate: W1,
        objectiveId: "o1",
        achieved: false,
        updatedAt: "",
      });
      await sim.syncAll("personal");
      a.clock.advance(1_000);
      await a.repo.deleteWeeklyObjective("o1"); // A's delete, earlier than B's edit in clock time
      b.clock.advance(120_000);
      await b.db.execute("UPDATE weekly_objective_results SET achieved = 1");
      await b.stamp();
      await sim.exchange(b, c, "personal"); // C holds B's edit B5
      return { sim, a, b, c };
    };

    /** The clock its author issues right after `clock`: same device id, counter + 1. */
    const nextClockOf = (clock: string): string => {
      const parsed = parseHlc(clock);
      if (!parsed) throw new Error("bad clock");
      return encodeHlc(parsed.physicalMs, parsed.counter + 1, parsed.deviceId);
    };

    const newestClock = async (device: SyncDevice): Promise<string> =>
      Object.values(
        JSON.parse((await resultMeta(device))?.field_clocks_json as string) as Record<
          string,
          string
        >,
      )
        .sort()
        .at(-1) as string;

    const resultMeta = async (device: SyncDevice) =>
      (
        await device.db.select<{ deleted_at: string | null; field_clocks_json: string }[]>(
          "SELECT deleted_at, field_clocks_json FROM sync_entity_meta WHERE entity_type = 'weekly_objective_results'",
        )
      )[0];

    const expectOwnClock = async (
      device: SyncDevice,
      bEdit: string,
      before: Awaited<ReturnType<typeof readIdentity>>,
    ) => {
      const tombstone = (await resultMeta(device))?.deleted_at as string;
      expect(tombstone).not.toBeNull();
      expect(tombstone > bEdit).toBe(true);
      expect(parseHlc(tombstone)?.deviceId).toBe(device.deviceId);
      // Drawn from the applying device's clock store: its clock state moved past the tombstone,
      // and nothing else was stamped (no dirty mark, no change counter).
      const after = await readIdentity(device.db);
      expect(after?.change_counter).toBe(before?.change_counter);
      expect(await readMarks(device.db)).toEqual([]);
      // The clock was really drawn from this device's clock store and persisted: its stored state is
      // at or past the tombstone, so its next local tick is later than it.
      const persisted = encodeHlc(after?.physical_ms ?? 0, after?.counter ?? 0, device.deviceId);
      expect(persisted >= tombstone).toBe(true);
      const beforeState = encodeHlc(
        before?.physical_ms ?? 0,
        before?.counter ?? 0,
        device.deviceId,
      );
      expect(beforeState < tombstone).toBe(true);
      return tombstone;
    };

    it("a cascade of a child edited after the parent's delete (the bundle does not mention the child)", async () => {
      const { a, b, c } = await threeDevices();
      const bEdit = await newestClock(b);
      const bundle = jsonRoundTrip(await a.repo.listSyncChanges("personal")) as unknown as Draft;
      bundle.entities = bundle.entities.filter((e: Draft) => e.table === "weekly_objectives");
      const before = await readIdentity(c.db);
      await c.repo.applySyncBundle("personal", bundle as unknown as SyncChangeSet);
      const tombstone = await expectOwnClock(c, bEdit, before);
      expect(tombstone).not.toBe(nextClockOf(bEdit)); // B's next clock: B5 + 1 counter

      // Re-applying the same bundle issues nothing and changes nothing, `sync_identity` included.
      const settled = await readIdentity(c.db);
      const again = await c.repo.applySyncBundle("personal", bundle as unknown as SyncChangeSet);
      expect(again).toMatchObject({ applied: 0, tombstonesApplied: 0 });
      expect(await readIdentity(c.db)).toEqual(settled);
      expect((await resultMeta(c))?.deleted_at).toBe(tombstone);
    });

    it("a child edit meeting the parent's tombstone (the bundle carries the edited child)", async () => {
      const { sim, a, b } = await threeDevices();
      // A holds both tombstones (its own delete); B's whole bundle brings the edited result, which
      // the merge of that result itself must keep off the deleted objective with a tombstone later
      // than the edit.
      const bEdit = await newestClock(b);
      const before = await readIdentity(a.db);
      await sim.exchange(b, a, "personal");
      const tombstone = await expectOwnClock(a, bEdit, before);
      expect(tombstone).not.toBe(nextClockOf(bEdit));
      expect(await a.db.select("SELECT 1 FROM weekly_objective_results")).toEqual([]);

      const settled = await readIdentity(a.db);
      const again = await sim.exchange(b, a, "personal");
      expect(again).toMatchObject({ applied: 0, tombstonesApplied: 0 });
      expect(await readIdentity(a.db)).toEqual(settled);
      expect((await resultMeta(a))?.deleted_at).toBe(tombstone);
    });

    it("B ticking between the stamp and the apply cannot tie with the tombstone: everything ends deleted", async () => {
      const { sim, a, b, c } = await threeDevices();
      const bEditClock = await newestClock(b);
      // C applies A's delete and writes its tombstone ...
      await sim.exchange(a, c, "personal");
      const onC = (await resultMeta(c))?.deleted_at as string;
      // ... meanwhile B (which has not heard of the delete) edits the result again. Its next clock is
      // exactly "B5 + 1 counter", the value the old derivation gave the tombstone.
      await b.db.execute("UPDATE weekly_objective_results SET achieved = 0");
      await b.stamp();
      const bNext = await newestClock(b);
      expect(bNext).toBe(nextClockOf(bEditClock)); // B's next clock IS "B5 + 1 counter" ...
      expect(onC).not.toBe(bNext); // ... and the tombstone is not that value
      expect(parseHlc(onC)?.deviceId).toBe(c.deviceId);

      await sim.syncAll("personal");
      await sim.expectConverged("personal", { snapshots: true });
      for (const device of [a, b, c]) {
        expect(await device.db.select("SELECT 1 FROM weekly_objective_results")).toEqual([]);
        expect(await device.db.select("SELECT 1 FROM weekly_objectives")).toEqual([]);
        expect(await device.db.select("PRAGMA foreign_key_check")).toEqual([]);
        const meta = await resultMeta(device);
        expect(meta?.deleted_at).not.toBeNull();
        // A tombstone is later than every clock it retains, so an equal clock cannot keep an edit.
        for (const clock of Object.values(
          JSON.parse(meta?.field_clocks_json as string) as Record<string, string>,
        )) {
          expect((meta?.deleted_at as string) > clock).toBe(true);
        }
      }
    });
  });
});
