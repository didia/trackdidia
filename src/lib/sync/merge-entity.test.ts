import { describe, expect, it } from "vitest";
import { buildEntityCodec, type FieldCodec, type RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import { canonicalJson, type FieldClocks, jsonDeepEqual } from "./field-clocks";
import { encodeHlc } from "./hlc";
import {
  BASELINE_CLOCK,
  type EntityMergeOutcome,
  type LocalEntityState,
  mergeFieldClockEntity,
  mergeSettingEntry,
  overwrittenConflictId,
} from "./merge-entity";
import { getTableRegistration } from "./registry";

const A = "dev:00000000-0000-4000-8000-00000000000a";
const B = "dev:00000000-0000-4000-8000-00000000000b";
const C = "dev:00000000-0000-4000-8000-00000000000c";
const at = (ms: number, device = A, counter = 0) => encodeHlc(ms, counter, device);

const TASK_COLUMNS = [
  "id",
  "title",
  "notes",
  "status",
  "context_ids_json",
  "created_at",
  "updated_at",
];
const GOAL_COLUMNS = [
  "id",
  "title",
  "progress_log_json",
  "milestones_json",
  "created_at",
  "updated_at",
];
const DAILY_COLUMNS = ["date", "status", "metrics_json", "morning_intention", "updated_at"];

const input = (table: string, columns: string[], local: LocalEntityState, remote: SyncEntity) => {
  const codec = buildEntityCodec(table, columns) as FieldCodec;
  return {
    codec,
    columns,
    primaryKey: getTableRegistration(table).primaryKey,
    notNullColumns: new Set(columns),
    local,
    remote,
  };
};

const live = (row: RawRow, clocks: FieldClocks, rowHlc?: string): LocalEntityState => ({
  row,
  meta: {
    fieldClocks: clocks,
    rowHlc: rowHlc ?? Object.values(clocks).sort().at(-1) ?? at(1),
    deletedAt: null,
  },
});

const tomb = (clocks: FieldClocks, deletedAt: string): LocalEntityState => ({
  row: null,
  meta: { fieldClocks: clocks, rowHlc: deletedAt, deletedAt },
});

const remoteLive = (
  table: string,
  entityId: string,
  row: RawRow,
  clocks: FieldClocks,
): SyncEntity => ({
  table,
  entityId,
  row,
  fieldClocks: clocks,
  rowHlc: Object.values(clocks).sort().at(-1) ?? at(1),
  deletedAt: null,
});

const remoteTomb = (
  table: string,
  entityId: string,
  clocks: FieldClocks,
  deletedAt: string,
): SyncEntity => ({
  table,
  entityId,
  row: null,
  fieldClocks: clocks,
  rowHlc: deletedAt,
  deletedAt,
});

const task = (overrides: RawRow = {}): RawRow => ({
  id: "t1",
  title: "Plan",
  notes: "",
  status: "active",
  context_ids_json: "[]",
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  ...overrides,
});

const mergeTask = (local: LocalEntityState, remote: SyncEntity) =>
  mergeFieldClockEntity(input("gtd_tasks", TASK_COLUMNS, local, remote));

describe("scalar fields", () => {
  it("takes the later remote edit and keeps the other fields", () => {
    const local = live(task(), { title: at(10), notes: at(10), status: at(10) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "Plan v2", notes: "n" }), {
      title: at(20, B),
      notes: at(5, B),
      status: at(10),
    });
    const result = mergeTask(local, remote);
    expect(result.rowAction).toBe("update");
    expect(result.columns).toEqual({ title: "Plan v2" });
    expect(result.meta.fieldClocks).toMatchObject({
      title: at(20, B),
      notes: at(10),
      status: at(10),
    });
    expect(result.metaChanged).toBe(true);
  });

  it("keeps a later local edit and changes nothing", () => {
    const local = live(task({ title: "Mine" }), { title: at(30) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "Theirs" }), { title: at(20, B) });
    const result = mergeTask(local, remote);
    expect(result.rowAction).toBe("none");
    expect(result.metaChanged).toBe(false);
    expect(result.overwritten).toEqual([]);
  });

  it("is a no-op when both sides are identical", () => {
    const clocks = { title: at(10), notes: at(10) };
    const result = mergeTask(live(task(), clocks), remoteLive("gtd_tasks", "t1", task(), clocks));
    expect(result.rowAction).toBe("none");
    expect(result.metaChanged).toBe(false);
    expect(result.tombstoneApplied).toBe(false);
  });

  it("adopts a later clock for an equal value without touching the row", () => {
    const result = mergeTask(
      live(task(), { title: at(10) }),
      remoteLive("gtd_tasks", "t1", task(), { title: at(20, B) }),
    );
    expect(result.rowAction).toBe("none");
    expect(result.metaChanged).toBe(true);
    expect(result.meta.fieldClocks.title).toBe(at(20, B));
    expect(result.overwritten).toEqual([]);
  });

  it("keeps the local value for a column the remote row lacks, and ignores its unknown columns", () => {
    const local = live(task({ notes: "local notes" }), { notes: at(10), title: at(10) });
    const remote = remoteLive(
      "gtd_tasks",
      "t1",
      { id: "t1", title: "Newer", added_in_the_future: "x" },
      { title: at(20, B), notes: at(50, B), added_in_the_future: at(50, B) },
    );
    const result = mergeTask(local, remote);
    expect(result.columns).toEqual({ title: "Newer" });
    expect(result.meta.fieldClocks.notes).toBe(at(10));
    expect(Object.keys(result.meta.fieldClocks)).not.toContain("added_in_the_future");
  });

  it("never lets a stamped local field lose to an unstamped remote one", () => {
    const result = mergeTask(
      live(task({ title: "Mine" }), { title: at(10) }),
      remoteLive("gtd_tasks", "t1", task({ title: "Theirs" }), {}),
    );
    expect(result.columns).toEqual({});
  });

  it("never changes the primary key", () => {
    const result = mergeTask(
      live(task(), { title: at(1) }),
      remoteLive("gtd_tasks", "t1", task({ id: "t1", title: "x" }), { title: at(9, B) }),
    );
    expect(Object.keys(result.columns)).not.toContain("id");
  });
});

describe("overwritten edits", () => {
  it("logs a concurrent edit that lost", () => {
    // A created at 10 and edited the title at 12; B created nothing newer than 10 from A's view.
    const local = live(task({ title: "A title" }), { title: at(12), notes: at(10) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "B title" }), {
      title: at(20, B),
      notes: at(10),
    });
    const result = mergeTask(local, remote);
    // The sender carries A's clock 10 (< 12): it had not seen A's title edit.
    expect(result.overwritten).toEqual([
      {
        field: "title",
        local: { value: "A title", clock: at(12) },
        remote: { value: "B title", clock: at(20, B) },
      },
    ]);
  });

  it("does not log an ordinary later edit by a peer that had seen the local value", () => {
    const local = live(task({ title: "A title" }), { title: at(10), notes: at(10) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "B title" }), {
      title: at(20, B),
      notes: at(10), // an A clock at or above A's title clock: B saw it
    });
    expect(mergeTask(local, remote).overwritten).toEqual([]);
  });

  it("does not log when the local value wins", () => {
    const local = live(task({ title: "A title" }), { title: at(30) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "B title" }), { title: at(20, B) });
    expect(mergeTask(local, remote).overwritten).toEqual([]);
  });

  it("ignores updated_at and created_at differences", () => {
    const local = live(task({ updated_at: "2026-10-02", created_at: "2026-10-01" }), {
      updated_at: at(12),
      created_at: at(12),
    });
    const remote = remoteLive(
      "gtd_tasks",
      "t1",
      task({ updated_at: "2026-10-03", created_at: "2026-10-05" }),
      {
        updated_at: at(20, B),
        created_at: at(20, B),
      },
    );
    const result = mergeTask(local, remote);
    expect(result.columns).toEqual({ updated_at: "2026-10-03", created_at: "2026-10-05" });
    expect(result.overwritten).toEqual([]);
  });

  it("never logs identical values", () => {
    const local = live(task({ title: "Same" }), { title: at(12) });
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "Same" }), { title: at(20, B) });
    expect(mergeTask(local, remote).overwritten).toEqual([]);
  });

  it("treats an unstamped local value as possibly concurrent", () => {
    const local = live(task({ title: "Unstamped" }), {});
    const remote = remoteLive("gtd_tasks", "t1", task({ title: "Stamped" }), { title: at(20, B) });
    expect(mergeTask(local, remote).overwritten).toHaveLength(1);
  });

  it("derives a deterministic conflict id from the entity, the field and both clocks", () => {
    const first = overwrittenConflictId("gtd_tasks", "t1", "title", at(12), at(20, B));
    expect(overwrittenConflictId("gtd_tasks", "t1", "title", at(12), at(20, B))).toBe(first);
    for (const other of [
      overwrittenConflictId("gtd_tasks", "t2", "title", at(12), at(20, B)),
      overwrittenConflictId("gtd_tasks", "t1", "notes", at(12), at(20, B)),
      overwrittenConflictId("gtd_tasks", "t1", "title", at(13), at(20, B)),
      overwrittenConflictId("gtd_tasks", "t1", "title", at(12), at(21, B)),
      overwrittenConflictId("gtd_projects", "t1", "title", at(12), at(20, B)),
    ]) {
      expect(other).not.toBe(first);
    }
  });
});

describe("JSON-map columns", () => {
  const daily = (metrics: Record<string, unknown>, overrides: RawRow = {}): RawRow => ({
    date: "2026-10-04",
    status: "not_started",
    metrics_json: JSON.stringify(metrics),
    morning_intention: "",
    updated_at: "2026-10-04",
    ...overrides,
  });
  const mergeDaily = (local: LocalEntityState, remote: SyncEntity) =>
    mergeFieldClockEntity(input("daily_entries", DAILY_COLUMNS, local, remote));

  it("merges per key: concurrent edits of different keys both survive", () => {
    const local = live(daily({ course: 5, marche: null }), {
      "metrics_json.course": at(12),
      "metrics_json.marche": at(10),
    });
    const remote = remoteLive("daily_entries", "2026-10-04", daily({ course: null, marche: 9 }), {
      "metrics_json.course": at(10),
      "metrics_json.marche": at(15, B),
    });
    const result = mergeDaily(local, remote);
    expect(JSON.parse(result.columns.metrics_json as string)).toEqual({ course: 5, marche: 9 });
    expect(result.meta.fieldClocks).toMatchObject({
      "metrics_json.course": at(12),
      "metrics_json.marche": at(15, B),
    });
  });

  it("writes canonical text: sorted keys, compact", () => {
    const local = live(daily({ zeta: 1 }), { "metrics_json.zeta": at(10) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily({ alpha: 2 }), {
      "metrics_json.alpha": at(11, B),
    });
    expect(mergeDaily(local, remote).columns.metrics_json).toBe('{"alpha":2,"zeta":1}');
  });

  it("lets a later removal beat an older value, and a later write beat a removal", () => {
    const removed = mergeDaily(
      live(daily({ course: 5 }), { "metrics_json.course": at(10) }),
      remoteLive("daily_entries", "2026-10-04", daily({}), { "metrics_json.course": at(20, B) }),
    );
    expect(removed.columns.metrics_json).toBe("{}");
    expect(removed.meta.fieldClocks["metrics_json.course"]).toBe(at(20, B));

    const revived = mergeDaily(
      live(daily({}), { "metrics_json.course": at(20, B) }),
      remoteLive("daily_entries", "2026-10-04", daily({ course: 7 }), {
        "metrics_json.course": at(30),
      }),
    );
    expect(JSON.parse(revived.columns.metrics_json as string)).toEqual({ course: 7 });
  });

  it("logs a lost key edit as an overwritten edit of that key", () => {
    const local = live(daily({ course: 5 }), { "metrics_json.course": at(12) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily({ course: 8 }), {
      "metrics_json.course": at(20, B),
    });
    expect(mergeDaily(local, remote).overwritten).toEqual([
      {
        field: "metrics_json.course",
        local: { value: 5, clock: at(12) },
        remote: { value: 8, clock: at(20, B) },
      },
    ]);
  });

  it("records a key removed by the remote as a deleted side", () => {
    const local = live(daily({ course: 5 }), { "metrics_json.course": at(12) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily({}), {
      "metrics_json.course": at(20, B),
    });
    expect(mergeDaily(local, remote).overwritten).toEqual([
      {
        field: "metrics_json.course",
        local: { value: 5, clock: at(12) },
        remote: { deleted: true, clock: at(20, B) },
      },
    ]);
  });

  it("keeps keys with an own __proto__ name", () => {
    const metrics = JSON.parse('{"__proto__": 3, "constructor": 4}') as Record<string, unknown>;
    const remote = remoteLive("daily_entries", "2026-10-04", daily(metrics), {
      "metrics_json.__proto__": at(11, B),
      "metrics_json.constructor": at(11, B),
    });
    const inserted = mergeDaily({ row: null, meta: null }, remote);
    const parsed = JSON.parse(inserted.columns.metrics_json as string) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.constructor).toBe(4);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("merges an array of {id} items (milestones) per id and orders it by sortOrder", () => {
    const goal = (milestones: unknown[]): RawRow => ({
      id: "g1",
      title: "Goal",
      progress_log_json: "{}",
      milestones_json: JSON.stringify(milestones),
      created_at: "x",
      updated_at: "x",
    });
    const m = (id: string, sortOrder: number, completedAt: string | null = null) => ({
      id,
      title: id,
      completedAt,
      sortOrder,
    });
    const local = live(goal([m("m1", 0, "2026-10-02"), m("m2", 1)]), {
      "milestones_json.m1": at(12),
      "milestones_json.m2": at(10),
    });
    const remote = remoteLive("annual_goals", "g1", goal([m("m1", 0), m("m2", 1), m("m0", -1)]), {
      "milestones_json.m1": at(10, B),
      "milestones_json.m2": at(10, B),
      "milestones_json.m0": at(15, B),
    });
    const result = mergeFieldClockEntity(input("annual_goals", GOAL_COLUMNS, local, remote));
    const merged = JSON.parse(result.columns.milestones_json as string) as {
      id: string;
      completedAt: unknown;
    }[];
    expect(merged.map((item) => item.id)).toEqual(["m0", "m1", "m2"]);
    expect(merged.find((item) => item.id === "m1")?.completedAt).toBe("2026-10-02");
  });

  it("falls back to one atomic field when a map column has an unmergeable shape", () => {
    const local = live(daily({ course: 1 }), { "metrics_json.course": at(10) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily({}, { metrics_json: "[1,2]" }), {
      metrics_json: at(20, B),
    });
    const result = mergeDaily(local, remote);
    expect(result.columns.metrics_json).toBe("[1,2]");
    expect(result.meta.fieldClocks).toEqual(expect.objectContaining({ metrics_json: at(20, B) }));
    expect(
      Object.keys(result.meta.fieldClocks).some((key) => key.startsWith("metrics_json.")),
    ).toBe(false);
  });
});

describe("a map field held atomically on one side and per key on the other", () => {
  const daily = (metricsJson: string): RawRow => ({
    date: "2026-10-04",
    status: "not_started",
    metrics_json: metricsJson,
    morning_intention: "",
    updated_at: "2026-10-04",
  });
  const mergeDaily = (local: LocalEntityState, remote: SyncEntity) =>
    mergeFieldClockEntity(input("daily_entries", DAILY_COLUMNS, local, remote));
  const fieldKeys = (outcome: EntityMergeOutcome) =>
    Object.keys(outcome.meta.fieldClocks)
      .filter((key) => key.startsWith("metrics_json"))
      .sort();

  it("a newer per-key remote beats an older bare local clock, and the bare clock goes", () => {
    const local = live(daily("[1,2]"), { metrics_json: at(10) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily('{"course":5}'), {
      "metrics_json.course": at(20, B),
    });
    const result = mergeDaily(local, remote);
    expect(result.columns.metrics_json).toBe('{"course":5}');
    expect(fieldKeys(result)).toEqual(["metrics_json.course"]);
  });

  it("a newer bare remote beats older per-key local clocks, and the key clocks go", () => {
    const local = live(daily('{"course":5,"marche":6}'), {
      "metrics_json.course": at(10),
      "metrics_json.marche": at(12),
    });
    const remote = remoteLive("daily_entries", "2026-10-04", daily("[1,2]"), {
      metrics_json: at(20, B),
    });
    const result = mergeDaily(local, remote);
    expect(result.columns.metrics_json).toBe("[1,2]");
    expect(fieldKeys(result)).toEqual(["metrics_json"]);
    expect(result.meta.fieldClocks.metrics_json).toBe(at(20, B));
  });

  it("an older bare remote loses to newer per-key local clocks and does not leak its bare clock", () => {
    const local = live(daily('{"course":5}'), { "metrics_json.course": at(30) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily("[1,2]"), {
      metrics_json: at(20, B),
    });
    const result = mergeDaily(local, remote);
    expect(result.rowAction).toBe("none");
    expect(fieldKeys(result)).toEqual(["metrics_json.course"]);
  });

  it("a repaired (valid but empty) value stamped atomically is still merged as one column", () => {
    const local = live(daily('{"course":5}'), { "metrics_json.course": at(10) });
    const remote = remoteLive("daily_entries", "2026-10-04", daily("{}"), {
      metrics_json: at(20, B),
    });
    const result = mergeDaily(local, remote);
    expect(result.columns.metrics_json).toBe("{}");
    expect(fieldKeys(result)).toEqual(["metrics_json"]);
  });

  it("a tombstone that meets both forms keeps only the newer one", () => {
    const withKeys = tomb({ "metrics_json.course": at(10), "metrics_json.marche": at(11) }, at(15));
    const bareNewer = remoteTomb(
      "daily_entries",
      "2026-10-04",
      { metrics_json: at(14, B) },
      at(16, B),
    );
    const result = mergeDaily(withKeys, bareNewer);
    expect(result.meta.fieldClocks).toEqual({ metrics_json: at(14, B) });
    const keysNewer = mergeDaily(
      tomb({ metrics_json: at(5) }, at(15)),
      remoteTomb("daily_entries", "2026-10-04", { "metrics_json.course": at(14, B) }, at(16, B)),
    );
    expect(keysNewer.meta.fieldClocks).toEqual({ "metrics_json.course": at(14, B) });
  });

  it("same-form tombstones still union their keys", () => {
    const result = mergeDaily(
      tomb({ "metrics_json.course": at(10) }, at(15)),
      remoteTomb("daily_entries", "2026-10-04", { "metrics_json.marche": at(11, B) }, at(16, B)),
    );
    expect(Object.keys(result.meta.fieldClocks).sort()).toEqual([
      "metrics_json.course",
      "metrics_json.marche",
    ]);
  });
});

describe("resurrecting a tombstone logs the edits it swallowed", () => {
  const clocks = { title: at(10), notes: at(10), "context_ids_json.home": at(10) };

  it("reports every retained clock newer than the incoming one, with an unknown local value", () => {
    // Local: a tombstone at 30 that kept a title edit (20, device B) and a context add (22, device B).
    const local = tomb(
      {
        title: at(20, B),
        notes: at(10),
        "context_ids_json.home": at(10),
        "context_ids_json.work": at(22, B),
      },
      at(30),
    );
    // Incoming: an edit of notes at 40 from a device that never saw those edits.
    const remote = remoteLive(
      "gtd_tasks",
      "t1",
      task({ title: "Old title", notes: "Fresh notes", context_ids_json: '["home"]' }),
      {
        title: at(10),
        notes: at(40, C),
        "context_ids_json.home": at(10),
      },
    );
    const result = mergeTask(local, remote);
    expect(result.rowAction).toBe("insert");
    expect(result.overwritten).toEqual([
      {
        field: "context_ids_json.work",
        local: { unknown: true, clock: at(22, B) },
        remote: { deleted: true, clock: null },
      },
      {
        field: "title",
        local: { unknown: true, clock: at(20, B) },
        remote: { value: "Old title", clock: at(10) },
      },
    ]);
  });

  it("reports nothing when the incoming entity is at least as new in every field", () => {
    const result = mergeTask(
      tomb(clocks, at(20)),
      remoteLive("gtd_tasks", "t1", task({ title: "Back" }), {
        title: at(30, B),
        notes: at(10),
        "context_ids_json.home": at(10),
      }),
    );
    expect(result.rowAction).toBe("insert");
    expect(result.overwritten).toEqual([]);
  });

  it("never reports bookkeeping fields, and a brand-new entity has nothing to lose", () => {
    const withTimestamps = tomb({ updated_at: at(25, B), created_at: at(25, B) }, at(30));
    expect(
      mergeTask(withTimestamps, remoteLive("gtd_tasks", "t1", task(), { title: at(40, C) }))
        .overwritten,
    ).toEqual([]);
    expect(
      mergeTask({ row: null, meta: null }, remoteLive("gtd_tasks", "t1", task(), clocks))
        .overwritten,
    ).toEqual([]);
  });

  it("reports a lost map key", () => {
    const daily = (metrics: string): RawRow => ({
      date: "2026-10-04",
      status: "s",
      metrics_json: metrics,
      morning_intention: "",
      updated_at: "u",
    });
    const result = mergeFieldClockEntity(
      input(
        "daily_entries",
        DAILY_COLUMNS,
        tomb({ "metrics_json.course": at(22, B), "metrics_json.marche": at(5) }, at(30)),
        remoteLive("daily_entries", "2026-10-04", daily('{"marche":3}'), {
          "metrics_json.marche": at(5),
          morning_intention: at(40, C),
        }),
      ),
    );
    expect(result.overwritten).toEqual([
      {
        field: "metrics_json.course",
        local: { unknown: true, clock: at(22, B) },
        remote: { deleted: true, clock: null },
      },
    ]);
  });
});

describe("a resurrection dates a removal for every membership it omits", () => {
  const DELETED = at(50, A);
  const ids = (outcome: EntityMergeOutcome) =>
    JSON.parse((outcome.columns.context_ids_json as string | undefined) ?? "[]") as string[];
  const daily = (metrics: Record<string, unknown>, extra: RawRow = {}): RawRow => ({
    date: "2026-10-04",
    status: "s",
    metrics_json: JSON.stringify(metrics),
    morning_intention: "",
    updated_at: "u",
    ...extra,
  });
  const mergeDaily = (local: LocalEntityState, remote: SyncEntity) =>
    mergeFieldClockEntity(input("daily_entries", DAILY_COLUMNS, local, remote));
  const asState = (outcome: EntityMergeOutcome, row: RawRow): LocalEntityState => ({
    row,
    meta: outcome.meta,
  });

  // A: task with `work` at 10, deleted at 50 (the tombstone keeps `work` at 10).
  const tombstone = () => tomb({ title: at(10), "context_ids_json.work": at(10) }, DELETED);
  // B: a row that has no `work` and no clock for it, edited at 90.
  const resurrecting = () =>
    remoteLive("gtd_tasks", "t1", task({ context_ids_json: "[]", notes: "after" }), {
      title: at(10),
      notes: at(90, B),
    });

  it("dates a removal at the tombstone's deletedAt, taken from the data and not issued locally", () => {
    const result = mergeTask(tombstone(), resurrecting());
    expect(result.rowAction).toBe("insert");
    expect(result.meta.fieldClocks["context_ids_json.work"]).toBe(DELETED);
    expect(result.meta.rowHlc).toBe(at(90, B));
  });

  it("an older replica that still holds the id cannot put it back", () => {
    const resurrected = mergeTask(tombstone(), resurrecting());
    const stale = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work"]' }), {
      title: at(10),
      "context_ids_json.work": at(10),
    });
    const after = mergeTask(asState(resurrected, resurrecting().row as RawRow), stale);
    expect(ids(after)).toEqual([]);
    expect(after.rowAction).toBe("none");
  });

  it("an add made after the delete still beats the removal", () => {
    const resurrected = mergeTask(tombstone(), resurrecting());
    const readded = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work"]' }), {
      "context_ids_json.work": at(70, C),
    });
    expect(ids(mergeTask(asState(resurrected, resurrecting().row as RawRow), readded))).toEqual([
      "work",
    ]);
  });

  it("keeps an incoming removal that is already later", () => {
    const later = remoteLive("gtd_tasks", "t1", task({ context_ids_json: "[]" }), {
      notes: at(90, B),
      "context_ids_json.work": at(80, B),
    });
    expect(mergeTask(tombstone(), later).meta.fieldClocks["context_ids_json.work"]).toBe(at(80, B));
  });

  it("does not invent a removal for a key the tombstone never had, or one the row holds", () => {
    const holding = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work","home"]' }), {
      notes: at(90, B),
      "context_ids_json.work": at(60, B),
      "context_ids_json.home": at(60, B),
    });
    const result = mergeTask(tombstone(), holding);
    expect(result.meta.fieldClocks).toEqual({
      notes: at(90, B),
      "context_ids_json.work": at(60, B),
      "context_ids_json.home": at(60, B),
    });
    const noTombstoneKeys = mergeTask(tomb({ title: at(10) }, DELETED), resurrecting());
    expect(
      Object.keys(noTombstoneKeys.meta.fieldClocks).some((key) =>
        key.startsWith("context_ids_json."),
      ),
    ).toBe(false);
  });

  it("does the same for a map key", () => {
    const result = mergeDaily(
      tomb({ "metrics_json.course": at(10), "metrics_json.marche": at(10) }, DELETED),
      remoteLive("daily_entries", "2026-10-04", daily({ marche: 4 }), {
        "metrics_json.marche": at(60, B),
        morning_intention: at(90, B),
      }),
    );
    expect(result.meta.fieldClocks).toMatchObject({
      "metrics_json.course": DELETED,
      "metrics_json.marche": at(60, B),
    });
  });

  it("leaves an atomic field alone: a bare clock has no per-key removals to invent", () => {
    const bareIncoming = mergeDaily(
      tomb({ "metrics_json.course": at(10) }, DELETED),
      remoteLive("daily_entries", "2026-10-04", daily({}), { metrics_json: at(60, B) }),
    );
    expect(bareIncoming.meta.fieldClocks).toEqual({ metrics_json: at(60, B) });
    const bareTombstone = mergeDaily(
      tomb({ metrics_json: at(10) }, DELETED),
      remoteLive("daily_entries", "2026-10-04", daily({}), { morning_intention: at(90, B) }),
    );
    expect(bareTombstone.meta.fieldClocks).toEqual({ morning_intention: at(90, B) });
    const unmergeable = mergeDaily(
      tomb({ "metrics_json.course": at(10) }, DELETED),
      remoteLive("daily_entries", "2026-10-04", daily({}, { metrics_json: "[1,2]" }), {
        morning_intention: at(90, B),
      }),
    );
    expect(Object.keys(unmergeable.meta.fieldClocks)).toEqual(["morning_intention"]);
  });

  it("still logs the dropped membership as an overwritten edit, now alongside its removal clock", () => {
    const result = mergeTask(tombstone(), resurrecting());
    expect(result.overwritten).toEqual([
      {
        field: "context_ids_json.work",
        local: { unknown: true, clock: at(10) },
        remote: { deleted: true, clock: null },
      },
    ]);
    expect(result.meta.fieldClocks["context_ids_json.work"]).toBe(DELETED);
  });

  it("a live row meeting an older tombstone gets the same removals, once", () => {
    const row = task({ context_ids_json: "[]", notes: "after" });
    const liveLocal = live(row, { title: at(10), notes: at(90, B) });
    const olderTombstone = remoteTomb(
      "gtd_tasks",
      "t1",
      { title: at(10), "context_ids_json.work": at(10) },
      DELETED,
    );
    const first = mergeTask(liveLocal, olderTombstone);
    expect(first.rowAction).toBe("none");
    expect(first.metaChanged).toBe(true);
    expect(first.meta.fieldClocks["context_ids_json.work"]).toBe(DELETED);
    expect(first.meta.rowHlc).toBe(at(90, B));
    const again = mergeTask(asState(first, row), olderTombstone);
    expect(again.metaChanged).toBe(false);
    // Both arrival orders store the same clocks.
    const other = mergeTask(tombstone(), resurrecting());
    expect(first.meta.fieldClocks).toEqual(other.meta.fieldClocks);
  });

  describe("a membership the survivor holds keeps its own clock, even an older one", () => {
    // The guard that matters: the survivor's clock for `work` (10) is OLDER than the tombstone's
    // deletedAt (50), so only "the survivor holds it" keeps the removal from being dated.
    const tombstoneKnowingWork = () => tomb({ "context_ids_json.work": at(10) }, DELETED);

    it("a resurrecting row that holds the id at an older clock", () => {
      const result = mergeTask(
        tombstoneKnowingWork(),
        remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work"]', notes: "after" }), {
          notes: at(90, B),
          "context_ids_json.work": at(10),
        }),
      );
      expect(result.rowAction).toBe("insert");
      expect(JSON.parse(result.columns.context_ids_json as string)).toEqual(["work"]);
      expect(result.meta.fieldClocks["context_ids_json.work"]).toBe(at(10));
    });

    it("a resurrecting row that holds the id with no clock at all (baseline)", () => {
      const result = mergeTask(
        tombstoneKnowingWork(),
        remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work"]', notes: "after" }), {
          notes: at(90, B),
        }),
      );
      expect(JSON.parse(result.columns.context_ids_json as string)).toEqual(["work"]);
      expect(Object.keys(result.meta.fieldClocks)).toEqual(["notes"]);
    });

    it("a resurrecting row that holds a map key at an older clock", () => {
      const result = mergeFieldClockEntity(
        input(
          "daily_entries",
          DAILY_COLUMNS,
          tomb({ "metrics_json.course": at(10) }, DELETED),
          remoteLive(
            "daily_entries",
            "2026-10-04",
            {
              date: "2026-10-04",
              status: "s",
              metrics_json: JSON.stringify({ course: 5 }),
              morning_intention: "",
              updated_at: "u",
            },
            { "metrics_json.course": at(10), morning_intention: at(90, B) },
          ),
        ),
      );
      expect(JSON.parse(result.columns.metrics_json as string)).toEqual({ course: 5 });
      expect(result.meta.fieldClocks["metrics_json.course"]).toBe(at(10));
    });

    it("a live row that holds the id at an older clock meets an older tombstone that knows it", () => {
      const row = task({ context_ids_json: '["work"]', notes: "after" });
      const result = mergeTask(
        live(row, { notes: at(90, B), "context_ids_json.work": at(10) }),
        remoteTomb("gtd_tasks", "t1", { "context_ids_json.work": at(10) }, DELETED),
      );
      expect(result.rowAction).toBe("none");
      expect(result.metaChanged).toBe(false);
      expect(result.meta.fieldClocks["context_ids_json.work"]).toBe(at(10));
    });

    it("a live row that holds the id with no clock (baseline) is left alone too", () => {
      const row = task({ context_ids_json: '["work"]', notes: "after" });
      const result = mergeTask(
        live(row, { notes: at(90, B) }),
        remoteTomb("gtd_tasks", "t1", { "context_ids_json.work": at(10) }, DELETED),
      );
      expect(result.rowAction).toBe("none");
      expect(result.metaChanged).toBe(false);
      expect(Object.keys(result.meta.fieldClocks)).toEqual(["notes"]);
    });

    it("a live row that holds a map key at an older clock is left alone", () => {
      const result = mergeFieldClockEntity(
        input(
          "daily_entries",
          DAILY_COLUMNS,
          live(
            {
              date: "2026-10-04",
              status: "s",
              metrics_json: JSON.stringify({ course: 5 }),
              morning_intention: "after",
              updated_at: "u",
            },
            { "metrics_json.course": at(10), morning_intention: at(90, B) },
          ),
          remoteTomb("daily_entries", "2026-10-04", { "metrics_json.course": at(10) }, DELETED),
        ),
      );
      expect(result.metaChanged).toBe(false);
      expect(result.meta.fieldClocks["metrics_json.course"]).toBe(at(10));
    });
  });

  it("a live row that holds the id is left alone by an older tombstone", () => {
    const result = mergeTask(
      live(task({ context_ids_json: '["work"]' }), {
        notes: at(90, B),
        "context_ids_json.work": at(60, B),
      }),
      remoteTomb("gtd_tasks", "t1", { "context_ids_json.work": at(10) }, DELETED),
    );
    expect(result.metaChanged).toBe(false);
  });
});

describe("OR-set columns", () => {
  const ids = (outcome: EntityMergeOutcome) =>
    JSON.parse((outcome.columns.context_ids_json as string | undefined) ?? "[]") as string[];

  it("keeps both of two concurrent adds, sorted", () => {
    const local = live(task({ context_ids_json: '["home"]' }), { "context_ids_json.home": at(10) });
    const remote = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["work"]' }), {
      "context_ids_json.work": at(11, B),
    });
    const result = mergeTask(local, remote);
    expect(ids(result)).toEqual(["home", "work"]);
    expect(result.meta.fieldClocks).toMatchObject({
      "context_ids_json.home": at(10),
      "context_ids_json.work": at(11, B),
    });
  });

  it("resolves add vs remove by clock", () => {
    const removedLater = mergeTask(
      live(task({ context_ids_json: '["home"]' }), { "context_ids_json.home": at(10) }),
      remoteLive("gtd_tasks", "t1", task({ context_ids_json: "[]" }), {
        "context_ids_json.home": at(20, B),
      }),
    );
    expect(removedLater.columns.context_ids_json).toBe("[]");

    const addedLater = mergeTask(
      live(task({ context_ids_json: "[]" }), { "context_ids_json.home": at(10) }),
      remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["home"]' }), {
        "context_ids_json.home": at(20, B),
      }),
    );
    expect(addedLater.columns.context_ids_json).toBe('["home"]');

    const removeOlder = mergeTask(
      live(task({ context_ids_json: '["home"]' }), { "context_ids_json.home": at(30) }),
      remoteLive("gtd_tasks", "t1", task({ context_ids_json: "[]" }), {
        "context_ids_json.home": at(20, B),
      }),
    );
    expect(removeOlder.rowAction).toBe("none");
  });

  it("does not rewrite a list whose membership did not change, whatever its order", () => {
    const local = live(task({ context_ids_json: '["b","a"]' }), {
      "context_ids_json.a": at(10),
      "context_ids_json.b": at(10),
    });
    const remote = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["a","b"]' }), {
      "context_ids_json.a": at(10),
      "context_ids_json.b": at(10),
    });
    expect(mergeTask(local, remote).rowAction).toBe("none");
  });

  it("gives an unclocked present element a baseline clock so it does not vanish", () => {
    const local = live(task({ context_ids_json: '["old"]' }), {});
    const remote = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["new"]' }), {
      "context_ids_json.new": at(11, B),
    });
    const result = mergeTask(local, remote);
    expect(ids(result)).toEqual(["new", "old"]);
    expect(result.meta.fieldClocks["context_ids_json.old"]).toBe(BASELINE_CLOCK);
  });

  it("lets an explicit, clocked remote removal beat the baseline", () => {
    const local = live(task({ context_ids_json: '["old"]' }), {});
    const remote = remoteLive("gtd_tasks", "t1", task({ context_ids_json: "[]" }), {
      "context_ids_json.old": at(11, B),
    });
    expect(mergeTask(local, remote).columns.context_ids_json).toBe("[]");
  });

  it("treats an unclocked element on the remote side the same way", () => {
    const local = live(task({ context_ids_json: "[]" }), {});
    const remote = remoteLive("gtd_tasks", "t1", task({ context_ids_json: '["old"]' }), {});
    expect(mergeTask(local, remote).columns.context_ids_json).toBe('["old"]');
  });
});

describe("whole-entity delete and edit", () => {
  const clocks = { title: at(10), notes: at(10) };

  it("a later delete removes the local row and keeps the tombstone and clocks", () => {
    const result = mergeTask(
      live(task(), clocks),
      remoteTomb("gtd_tasks", "t1", clocks, at(20, B)),
    );
    expect(result.rowAction).toBe("delete");
    expect(result.tombstoneApplied).toBe(true);
    expect(result.meta).toEqual({ fieldClocks: clocks, rowHlc: at(20, B), deletedAt: at(20, B) });
  });

  it("a local edit later than the delete keeps the row and ignores the tombstone", () => {
    const result = mergeTask(
      live(task(), { title: at(30), notes: at(10) }),
      remoteTomb("gtd_tasks", "t1", clocks, at(20, B)),
    );
    expect(result.rowAction).toBe("none");
    expect(result.metaChanged).toBe(false);
    expect(result.tombstoneApplied).toBe(false);
  });

  it("a remote edit later than a local delete resurrects the row with the remote values", () => {
    const result = mergeTask(
      tomb(clocks, at(20)),
      remoteLive("gtd_tasks", "t1", task({ title: "Back" }), { title: at(30, B), notes: at(10) }),
    );
    expect(result.rowAction).toBe("insert");
    expect(result.columns).toMatchObject({ id: "t1", title: "Back" });
    expect(result.meta.deletedAt).toBeNull();
    expect(result.meta.fieldClocks).toEqual({ title: at(30, B), notes: at(10) });
  });

  it("an older remote edit does not resurrect a local delete", () => {
    const result = mergeTask(
      tomb(clocks, at(40)),
      remoteLive("gtd_tasks", "t1", task(), { title: at(30, B) }),
    );
    expect(result.rowAction).toBe("none");
    expect(result.meta.deletedAt).toBe(at(40));
  });

  it("records a tombstone for a row never seen as metadata only", () => {
    const result = mergeTask(
      { row: null, meta: null },
      remoteTomb("gtd_tasks", "t1", clocks, at(20, B)),
    );
    expect(result.rowAction).toBe("none");
    expect(result.tombstoneApplied).toBe(true);
    expect(result.metaChanged).toBe(true);
    expect(result.meta.deletedAt).toBe(at(20, B));
  });

  it("is idempotent for a tombstone it already holds", () => {
    const result = mergeTask(
      tomb(clocks, at(20, B)),
      remoteTomb("gtd_tasks", "t1", clocks, at(20, B)),
    );
    expect(result.rowAction).toBe("none");
    expect(result.metaChanged).toBe(false);
    expect(result.tombstoneApplied).toBe(false);
  });

  it("inserts a new live entity with the remote clocks", () => {
    const result = mergeTask(
      { row: null, meta: null },
      remoteLive("gtd_tasks", "t1", task(), clocks),
    );
    expect(result.rowAction).toBe("insert");
    expect(result.meta).toEqual({ fieldClocks: clocks, rowHlc: at(10), deletedAt: null });
  });

  it("inserts only the columns the remote row provides", () => {
    const result = mergeTask(
      { row: null, meta: null },
      remoteLive(
        "gtd_tasks",
        "t1",
        { id: "t1", title: "Only title", unknown_col: 1 },
        { title: at(10) },
      ),
    );
    expect(Object.keys(result.columns).sort()).toEqual(["id", "title"]);
  });
});

describe("properties of the entity merge", () => {
  // A tiny deterministic PRNG so a failure is reproducible from the seed in the test name.
  const prng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  interface State {
    row: RawRow | null;
    meta: NonNullable<LocalEntityState["meta"]>;
  }

  const apply = (state: State | null, outcome: EntityMergeOutcome): State => {
    let row = state?.row ?? null;
    if (outcome.rowAction === "insert") row = { ...outcome.columns };
    else if (outcome.rowAction === "update") row = { ...(row as RawRow), ...outcome.columns };
    else if (outcome.rowAction === "delete") row = null;
    return { row, meta: outcome.meta };
  };

  const toRemote = (table: string, entityId: string, state: State): SyncEntity => ({
    table,
    entityId,
    row: state.row,
    fieldClocks: state.meta.fieldClocks,
    rowHlc: state.meta.rowHlc,
    deletedAt: state.meta.deletedAt,
  });

  const normalize = (table: string, columns: string[], state: State) => {
    const codec = buildEntityCodec(table, columns) as FieldCodec;
    const record = state.row ? codec.decode(state.row) : null;
    if (record) {
      for (const set of codec.spec.sets ?? []) {
        record[set] = [...(record[set] as string[])].sort();
      }
    }
    return canonicalJson({ record, meta: state.meta });
  };

  const mergeInto = (table: string, columns: string[], local: State, remote: State, id: string) =>
    apply(
      local,
      mergeFieldClockEntity(
        input(table, columns, { row: local.row, meta: local.meta }, toRemote(table, id, remote)),
      ),
    );

  // A write is identified by its clock, so the value of a field is a function of its clock: the
  // same clock never carries two different values (the real-world invariant).
  const writeOf = (clock: string | undefined) => (clock === undefined ? "none" : `v@${clock}`);

  const randomTask = (rand: () => number, withTomb: boolean): State => {
    const devices = [A, B, C];
    const pick = () =>
      at(
        1 + Math.floor(rand() * 12),
        devices[Math.floor(rand() * 3)] as string,
        Math.floor(rand() * 2),
      );
    const clocks: FieldClocks = {};
    const row: RawRow = { id: "t1", notes: "", created_at: "c", updated_at: "u" };
    for (const field of ["title", "status"]) {
      if (rand() < 0.8) clocks[field] = pick();
      row[field] = writeOf(clocks[field]);
    }
    const present: string[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      const roll = rand();
      if (roll < 0.3) continue;
      const clock = pick();
      clocks[`context_ids_json.${id}`] = clock;
      if (roll < 0.75) present.push(id);
    }
    row.context_ids_json = JSON.stringify(present.sort());
    const rowHlc = Object.values(clocks).sort().at(-1) ?? at(1);
    if (withTomb && rand() < 0.3) {
      const deletedAt = at(13 + Math.floor(rand() * 4), devices[Math.floor(rand() * 3)] as string);
      return { row: null, meta: { fieldClocks: clocks, rowHlc: deletedAt, deletedAt } };
    }
    return { row, meta: { fieldClocks: clocks, rowHlc, deletedAt: null } };
  };

  for (const seed of Array.from({ length: 60 }, (_, index) => index + 1)) {
    it(`is commutative and idempotent for two replicas (seed ${seed})`, () => {
      const rand = prng(seed);
      const left = randomTask(rand, true);
      const right = randomTask(rand, true);
      const ab = mergeInto("gtd_tasks", TASK_COLUMNS, left, right, "t1");
      const ba = mergeInto("gtd_tasks", TASK_COLUMNS, right, left, "t1");
      expect(normalize("gtd_tasks", TASK_COLUMNS, ab)).toBe(
        normalize("gtd_tasks", TASK_COLUMNS, ba),
      );
      // Idempotent: merging a result with either input again changes nothing.
      for (const again of [left, right, ab]) {
        const merged = mergeInto("gtd_tasks", TASK_COLUMNS, ab, again, "t1");
        expect(normalize("gtd_tasks", TASK_COLUMNS, merged)).toBe(
          normalize("gtd_tasks", TASK_COLUMNS, ab),
        );
      }
    });

    it(`is associative for three live replicas (seed ${seed})`, () => {
      const rand = prng(seed * 7919);
      const x = randomTask(rand, false);
      const y = randomTask(rand, false);
      const z = randomTask(rand, false);
      const merge = (l: State, r: State) => mergeInto("gtd_tasks", TASK_COLUMNS, l, r, "t1");
      const groupings = [
        merge(merge(x, y), z),
        merge(x, merge(y, z)),
        merge(merge(z, x), y),
        merge(merge(y, z), x),
      ].map((state) => normalize("gtd_tasks", TASK_COLUMNS, state));
      expect(new Set(groupings).size).toBe(1);
    });
  }

  // A map column in every form capture can leave it in: no clocks, one bare clock over a value that
  // cannot be merged per key (or a repaired one), or per-key clocks.
  const randomDaily = (rand: () => number, withTomb: boolean): State => {
    const devices = [A, B, C];
    const pick = () =>
      at(
        1 + Math.floor(rand() * 10),
        devices[Math.floor(rand() * 3)] as string,
        Math.floor(rand() * 2),
      );
    const clocks: FieldClocks = {};
    const row: RawRow = { date: "2026-10-04", status: "s", morning_intention: "", updated_at: "u" };
    const form = rand();
    if (form < 0.25) {
      // atomic over an unmergeable value, or a repaired (valid) one
      const clock = pick();
      clocks.metrics_json = clock;
      row.metrics_json =
        rand() < 0.6 ? JSON.stringify([`atomic@${clock}`]) : JSON.stringify({ v: clock });
    } else if (form < 0.9) {
      const metrics: Record<string, string> = {};
      for (const key of ["a", "b", "c"]) {
        if (rand() < 0.3) continue;
        const clock = pick();
        clocks[`metrics_json.${key}`] = clock;
        if (rand() < 0.7) metrics[key] = `${key}@${clock}`;
      }
      row.metrics_json = JSON.stringify(metrics);
    } else {
      row.metrics_json = "{}";
    }
    const rowHlc = Object.values(clocks).sort().at(-1) ?? at(1);
    if (withTomb && rand() < 0.25) {
      const deletedAt = at(11 + Math.floor(rand() * 3), devices[Math.floor(rand() * 3)] as string);
      return { row: null, meta: { fieldClocks: clocks, rowHlc: deletedAt, deletedAt } };
    }
    return { row, meta: { fieldClocks: clocks, rowHlc, deletedAt: null } };
  };

  const mergeDailyInto = (local: State, remote: State) =>
    mergeInto("daily_entries", DAILY_COLUMNS, local, remote, "2026-10-04");
  const normalizeDaily = (state: State) => {
    const parsedRow = state.row && {
      ...state.row,
      metrics_json: canonicalJson(JSON.parse(state.row.metrics_json as string)),
    };
    return canonicalJson({ row: parsedRow, meta: state.meta });
  };

  for (const seed of Array.from({ length: 80 }, (_, index) => index + 1)) {
    it(`is commutative and idempotent when map columns mix atomic and per-key clocks (seed ${seed})`, () => {
      const rand = prng(seed * 31);
      const left = randomDaily(rand, true);
      const right = randomDaily(rand, true);
      const ab = mergeDailyInto(left, right);
      const ba = mergeDailyInto(right, left);
      expect(normalizeDaily(ab)).toBe(normalizeDaily(ba));
      for (const again of [left, right, ab]) {
        expect(normalizeDaily(mergeDailyInto(ab, again))).toBe(normalizeDaily(ab));
      }
      // The merged clocks never hold a bare clock and per-key clocks of the same field together.
      const keys = Object.keys(ab.meta.fieldClocks);
      const bare = keys.includes("metrics_json");
      const keyed = keys.some((key) => key.startsWith("metrics_json."));
      expect(bare && keyed).toBe(false);
    });
  }

  it("treats equal records as equal regardless of key order (sanity for the normalizer)", () => {
    expect(jsonDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe("mergeSettingEntry", () => {
  const lww = { scope: "gtd", merge: "lww" } as const;
  const monotonic = { scope: "personal", merge: "monotonic-max" } as const;
  const nonEmpty = { scope: "gtd", merge: "non-empty-wins" } as const;

  it("lww: the later clock wins and moves the clock", () => {
    const result = mergeSettingEntry(
      lww,
      { value: "fr", clock: at(10) },
      { value: "en", rowHlc: at(20, B) },
    );
    expect(result).toEqual({
      value: "en",
      clock: at(20, B),
      valueChanged: true,
      clockChanged: true,
    });
  });

  it("lww: an older remote value changes nothing", () => {
    const result = mergeSettingEntry(
      lww,
      { value: "fr", clock: at(30) },
      { value: "en", rowHlc: at(20, B) },
    );
    expect(result.valueChanged).toBe(false);
    expect(result.clockChanged).toBe(false);
  });

  it("lww: any clock beats a key that was never stamped", () => {
    const result = mergeSettingEntry(
      lww,
      { value: "fr", clock: null },
      { value: "en", rowHlc: at(1, B) },
    );
    expect(result.value).toBe("en");
  });

  it("monotonic-max: the larger date wins whatever the clocks say", () => {
    const result = mergeSettingEntry(
      monotonic,
      { value: "2026-10-05", clock: at(30) },
      { value: "2026-10-03", rowHlc: at(40, B) },
    );
    expect(result.value).toBe("2026-10-05");
    expect(result.valueChanged).toBe(false);
    expect(result.clock).toBe(at(40, B));
  });

  it("non-empty-wins: a marker beats a missing one and the earlier timestamp stays", () => {
    expect(
      mergeSettingEntry(
        nonEmpty,
        { value: null, clock: null },
        { value: "2026-10-03T00:00:00Z", rowHlc: at(5, B) },
      ).value,
    ).toBe("2026-10-03T00:00:00Z");
    expect(
      mergeSettingEntry(
        nonEmpty,
        { value: "2026-10-01T00:00:00Z", clock: at(9) },
        { value: "2026-10-03T00:00:00Z", rowHlc: at(5, B) },
      ).value,
    ).toBe("2026-10-01T00:00:00Z");
  });

  it("keeps the local representation when both sides are missing", () => {
    const result = mergeSettingEntry(
      monotonic,
      { value: "", clock: null },
      { value: null, rowHlc: at(5, B) },
    );
    expect(result.value).toBe("");
    expect(result.valueChanged).toBe(false);
  });

  it("rejects a non-text value for a value-merged key", () => {
    expect(() =>
      mergeSettingEntry(
        monotonic,
        { value: "2026-10-01", clock: null },
        { value: 5, rowHlc: at(5, B) },
      ),
    ).toThrow(TypeError);
  });

  it("is commutative for every rule", () => {
    const cases: [typeof lww | typeof monotonic | typeof nonEmpty, unknown, unknown][] = [
      [lww, "a", "b"],
      [monotonic, "2026-10-01", "2026-10-09"],
      [nonEmpty, "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z"],
    ];
    for (const [rule, x, y] of cases) {
      const forward = mergeSettingEntry(
        rule,
        { value: x, clock: at(10) },
        { value: y, rowHlc: at(20, B) },
      );
      const backward = mergeSettingEntry(
        rule,
        { value: y, clock: at(20, B) },
        { value: x, rowHlc: at(10) },
      );
      expect([forward.value, forward.clock]).toEqual([backward.value, backward.clock]);
    }
  });
});
