// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WeeklyObjective } from "../../domain/types";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import { orderByReferences, readForeignKeyEdges, ReferenceGuard } from "./apply-references";
import type { SyncChangeSet } from "./change-set";
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
    await expect(ReferenceGuard.create(db)).rejects.toMatchObject({
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
});
