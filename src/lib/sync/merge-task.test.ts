import { describe, expect, it } from "vitest";
import { buildEntityCodec, type FieldCodec, type RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import { canonicalJson, type FieldClocks } from "./field-clocks";
import { encodeHlc } from "./hlc";
import type { LocalEntityState } from "./merge-entity";
import {
  instanceEntityId,
  mergeTaskEntity,
  mergeTemplateEntity,
  normalizeTaskRow,
  type TaskMergeContext,
  type TaskMergeOutcome,
  terminalDivergenceId,
} from "./merge-task";
import type { OccurrenceRecord } from "./recurrence-occurrences";
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
  "bucket",
  "context_ids_json",
  "project_id",
  "parent_task_id",
  "scheduled_for",
  "deadline",
  "recurring_template_id",
  "recurrence_due_date",
  "is_recurring_instance",
  "completed_at",
  "recurrence_group_id",
  "pending_past_recurrences",
  "planned_order",
  "source",
  "source_external_id",
  "source_url",
  "created_at",
  "updated_at",
];

const input = (local: LocalEntityState, remote: SyncEntity | null) => ({
  codec: buildEntityCodec("gtd_tasks", TASK_COLUMNS) as FieldCodec,
  columns: TASK_COLUMNS,
  primaryKey: getTableRegistration("gtd_tasks").primaryKey,
  notNullColumns: new Set(["id", "title", "notes", "status", "bucket"]),
  local,
  remote,
});

const row = (overrides: RawRow = {}): RawRow => ({
  id: "t1",
  title: "Plan",
  notes: "",
  status: "active",
  bucket: "next_action",
  context_ids_json: "[]",
  project_id: null,
  parent_task_id: null,
  scheduled_for: null,
  deadline: null,
  recurring_template_id: null,
  recurrence_due_date: null,
  is_recurring_instance: 0,
  completed_at: null,
  recurrence_group_id: null,
  pending_past_recurrences: 0,
  planned_order: null,
  source: "manual",
  source_external_id: null,
  source_url: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

/** Clocks for every column at one instant, then specific overrides. */
const stamped = (base: string, overrides: FieldClocks = {}): FieldClocks => {
  const clocks: FieldClocks = {};
  for (const column of TASK_COLUMNS) {
    if (column !== "id" && column !== "context_ids_json") clocks[column] = base;
  }
  return { ...clocks, ...overrides };
};

const maxClock = (clocks: FieldClocks): string => Object.values(clocks).sort().at(-1) as string;

interface State {
  row: RawRow;
  clocks: FieldClocks;
}

const localOf = (state: State): LocalEntityState => ({
  row: state.row,
  meta: { fieldClocks: state.clocks, rowHlc: maxClock(state.clocks), deletedAt: null },
});

const entityOf = (state: State): SyncEntity => ({
  table: "gtd_tasks",
  entityId: String(state.row.id),
  row: state.row,
  fieldClocks: state.clocks,
  rowHlc: maxClock(state.clocks),
  deletedAt: null,
});

const merge = (local: State, remote: State, context: TaskMergeContext = {}): TaskMergeOutcome =>
  mergeTaskEntity(input(localOf(local), entityOf(remote)), context);

/** The state a replica holds after merging `remote` into `local`. */
const join = (local: State, remote: State, context: TaskMergeContext = {}): State => {
  const outcome = merge(local, remote, context);
  return { row: outcome.finalRow as RawRow, clocks: outcome.meta.fieldClocks };
};

const base = (overrides: RawRow = {}, clockOverrides: FieldClocks = {}): State => ({
  row: row(overrides),
  clocks: stamped(at(100), clockOverrides),
});

describe("lifecycle tuple: terminal beats a concurrent move", () => {
  it("keeps a completion when the peer moved the task to another bucket, in either direction", () => {
    const completed: State = {
      row: row({ status: "completed", completed_at: "2026-10-02T10:00:00.000Z" }),
      clocks: stamped(at(100), { status: at(200), completed_at: at(200), updated_at: at(200) }),
    };
    const moved: State = {
      row: row({ bucket: "waiting_for" }),
      // The move is LATER than the completion but was made without seeing it.
      clocks: stamped(at(100), { bucket: at(300, B), updated_at: at(300, B) }),
    };
    for (const [local, remote] of [
      [completed, moved],
      [moved, completed],
    ] as const) {
      const outcome = merge(local, remote);
      expect(outcome.finalRow).toMatchObject({
        status: "completed",
        bucket: "next_action",
        completed_at: "2026-10-02T10:00:00.000Z",
      });
      // The winner's member clocks come along, not a per-member maximum.
      expect(outcome.meta.fieldClocks.bucket).toBe(at(100));
      expect(outcome.meta.fieldClocks.status).toBe(at(200));
    }
  });

  it("logs the dropped move as an overwritten edit on the device whose move lost, and only there", () => {
    const completed: State = {
      row: row({ status: "completed", completed_at: "2026-10-02T10:00:00.000Z" }),
      clocks: stamped(at(100), { status: at(200), completed_at: at(200) }),
    };
    const moved: State = {
      row: row({ bucket: "waiting_for" }),
      clocks: stamped(at(100), { bucket: at(300, B) }),
    };
    const onMover = merge(moved, completed);
    expect(onMover.overwritten).toHaveLength(1);
    expect(onMover.overwritten[0]).toMatchObject({
      field: "lifecycle",
      local: { value: { bucket: "waiting_for", status: "active" }, clock: at(300, B) },
      remote: { value: { status: "completed" }, clock: at(200) },
    });
    // The completer simply keeps its state: the peer's lost move is that peer's to log.
    expect(merge(completed, moved).overwritten).toEqual([]);
  });

  it("does not log an ordinary later edit by a peer that had already seen the old tuple", () => {
    const old = base({}, { bucket: at(100, A) });
    const later: State = {
      row: row({ bucket: "waiting_for" }),
      clocks: stamped(at(100), { bucket: at(300, B), status: at(100, A) }),
    };
    expect(merge(old, later).overwritten).toEqual([]);
  });

  it("does not log a reorder inside the Planned queue", () => {
    const local: State = {
      row: row({ bucket: "planned", project_id: "p1", planned_order: 1 }),
      clocks: stamped(at(100, A), { planned_order: at(150, A), project_id: at(100, A) }),
    };
    const remote: State = {
      row: row({ bucket: "planned", project_id: "p1", planned_order: 0 }),
      clocks: stamped(at(100, A), { planned_order: at(300, B) }),
    };
    const outcome = merge(local, remote);
    expect(outcome.finalRow).toMatchObject({ planned_order: 0 });
    expect(outcome.overwritten).toEqual([]);
  });
});

describe("lifecycle tuple: completed against cancelled", () => {
  const completed: State = {
    row: row({ status: "completed", completed_at: "2026-10-02T10:00:00.000Z" }),
    clocks: stamped(at(100), { status: at(200, A), completed_at: at(200, A) }),
  };
  const cancelled: State = {
    row: row({ status: "cancelled", completed_at: null }),
    clocks: stamped(at(100), { status: at(300, B), completed_at: at(300, B) }),
  };

  it("picks the later decision as the provisional winner, the same on both replicas", () => {
    const onA = merge(completed, cancelled);
    const onB = merge(cancelled, completed);
    expect(onA.finalRow).toEqual(onB.finalRow);
    expect(onA.finalRow).toMatchObject({ status: "cancelled", completed_at: null });
    expect(onA.meta.fieldClocks).toEqual(onB.meta.fieldClocks);
  });

  it("keeps completed_at consistent with the winning status in both outcomes", () => {
    const earlierCancel: State = {
      row: row({ status: "cancelled" }),
      clocks: stamped(at(100), { status: at(150, B), completed_at: at(150, B) }),
    };
    const result = merge(earlierCancel, completed).finalRow;
    expect(result).toMatchObject({ status: "completed", completed_at: "2026-10-02T10:00:00.000Z" });
  });

  it("raises one unresolved divergence with both tuples and a deterministic id", () => {
    const onA = merge(completed, cancelled);
    const onB = merge(cancelled, completed);
    expect(onA.conflicts).toHaveLength(1);
    expect(onA.conflicts[0]).toMatchObject({
      kind: "terminal_divergence",
      entityType: "gtd_tasks",
      entityId: "t1",
      id: terminalDivergenceId("gtd_tasks", "t1", null),
      local: { status: "completed", completed_at: "2026-10-02T10:00:00.000Z" },
      remote: { status: "cancelled", completed_at: null },
    });
    expect(onB.conflicts[0]?.id).toBe(onA.conflicts[0]?.id);
    expect(onB.conflicts[0]).toMatchObject({
      local: { status: "cancelled" },
      remote: { status: "completed" },
    });
  });

  it("raises nothing when both sides completed, or for the same cancel", () => {
    const completedLater: State = {
      row: row({ status: "completed", completed_at: "2026-10-03T08:00:00.000Z" }),
      clocks: stamped(at(100), { status: at(400, B), completed_at: at(400, B) }),
    };
    const both = merge(completed, completedLater);
    expect(both.conflicts).toEqual([]);
    // Same status on both sides: last writer wins as a whole tuple.
    expect(both.finalRow).toMatchObject({ completed_at: "2026-10-03T08:00:00.000Z" });
    expect(merge(cancelled, cancelled).conflicts).toEqual([]);
  });
});

describe("lifecycle tuple: both active", () => {
  it("takes bucket, schedule and order together from the later tuple", () => {
    const scheduled: State = {
      row: row({ bucket: "scheduled", scheduled_for: "2026-11-03T12:00:00.000Z" }),
      clocks: stamped(at(100), { bucket: at(200, A), scheduled_for: at(200, A) }),
    };
    const planned: State = {
      row: row({ bucket: "planned", project_id: "p1", planned_order: 2 }),
      // Only the order is newer than the scheduled move; the tuple clock is the newest member.
      clocks: stamped(at(100), {
        bucket: at(150, B),
        planned_order: at(250, B),
        project_id: at(150, B),
      }),
    };
    for (const [local, remote] of [
      [scheduled, planned],
      [planned, scheduled],
    ] as const) {
      expect(merge(local, remote).finalRow).toMatchObject({
        bucket: "planned",
        scheduled_for: null,
        planned_order: 2,
        project_id: "p1",
      });
    }
    // Per-field last-writer-wins would have produced `planned` with a scheduled date and no order:
    // the stale scheduled_for (clock 200) beats the planned tuple's null scheduled_for (clock 100).
  });

  it("never mixes members of two tuples", () => {
    const x: State = {
      row: row({ bucket: "scheduled", scheduled_for: "2026-11-03T12:00:00.000Z" }),
      clocks: stamped(at(100), { bucket: at(200, A), scheduled_for: at(500, A) }),
    };
    const y: State = {
      row: row({ bucket: "waiting_for" }),
      clocks: stamped(at(100), { bucket: at(400, B), scheduled_for: at(100, B) }),
    };
    // x's tuple clock (500) is newer: bucket AND scheduled_for come from x.
    expect(merge(y, x).finalRow).toMatchObject({
      bucket: "scheduled",
      scheduled_for: "2026-11-03T12:00:00.000Z",
    });
    expect(merge(x, y).finalRow).toMatchObject({ bucket: "scheduled" });
  });
});

describe("normalization", () => {
  it("demotes an active planned task without a project exactly as the desktop does", () => {
    expect(
      normalizeTaskRow(
        row({ bucket: "planned", project_id: null, planned_order: 3, scheduled_for: "2026-11-03" }),
      ),
    ).toMatchObject({ bucket: "next_action", planned_order: null, scheduled_for: null });
  });

  it("demotes a planned task whose project is known to be gone, and only then", () => {
    const planned = row({ bucket: "planned", project_id: "p1", planned_order: 1 });
    expect(normalizeTaskRow(planned, (id) => id === "p1")).toMatchObject({
      bucket: "next_action",
      planned_order: null,
    });
    // An unknown project is not a deleted one: it may simply not have arrived yet.
    expect(normalizeTaskRow(planned)).toBe(planned);
  });

  it("demotes a scheduled task without a date and clears an order outside Planned", () => {
    expect(normalizeTaskRow(row({ bucket: "scheduled", scheduled_for: null }))).toMatchObject({
      bucket: "next_action",
    });
    expect(normalizeTaskRow(row({ bucket: "inbox", planned_order: 4 }))).toMatchObject({
      planned_order: null,
    });
  });

  it("leaves a completed planned task alone, order included, like the desktop", () => {
    const done = row({
      status: "completed",
      bucket: "planned",
      project_id: null,
      planned_order: 2,
    });
    expect(normalizeTaskRow(done)).toBe(done);
  });

  it("is idempotent", () => {
    const bad = row({ bucket: "planned", project_id: null, planned_order: 3 });
    const once = normalizeTaskRow(bad);
    expect(normalizeTaskRow(once)).toBe(once);
  });

  it("is applied to the merged row and written, with the winner's clocks", () => {
    const planned: State = {
      row: row({ bucket: "planned", project_id: "p1", planned_order: 0 }),
      clocks: stamped(at(100), {
        bucket: at(300, A),
        planned_order: at(300, A),
        project_id: at(100),
      }),
    };
    const gone = merge(base(), planned, { projectGone: (id) => id === "p1" });
    expect(gone.rowAction).toBe("update");
    expect(gone.finalRow).toMatchObject({ bucket: "next_action", planned_order: null });
    expect(gone.columns).not.toHaveProperty("bucket");
    expect(gone.meta.fieldClocks.bucket).toBe(at(300, A));
  });

  it("moves the project with the tuple: a re-filing racing a bucket change competes as a whole", () => {
    const planned: State = {
      row: row({ bucket: "planned", project_id: "p1", planned_order: 0 }),
      clocks: stamped(at(100), {
        bucket: at(300, A),
        planned_order: at(300, A),
        project_id: at(300, A),
      }),
    };
    const reassigned: State = {
      row: row({ project_id: "p2" }),
      clocks: stamped(at(100), { project_id: at(500, B) }),
    };
    for (const [local, remote] of [
      [planned, reassigned],
      [reassigned, planned],
    ] as const) {
      // The later decision wins whole: never `planned` with an order from another project's queue.
      expect(merge(local, remote).finalRow).toMatchObject({
        bucket: "next_action",
        project_id: "p2",
        planned_order: null,
      });
    }
  });
});

describe("everything else keeps the generic rules", () => {
  it("merges title per field and context ids as an OR-set next to a lifecycle decision", () => {
    const local: State = {
      row: row({ title: "A title", context_ids_json: '["home"]' }),
      clocks: stamped(at(100), { title: at(200, A), "context_ids_json.home": at(200, A) }),
    };
    const remote: State = {
      row: row({
        title: "B title",
        status: "completed",
        completed_at: "2026-10-02T10:00:00.000Z",
        context_ids_json: '["work"]',
      }),
      clocks: stamped(at(100), {
        title: at(300, B),
        status: at(300, B),
        completed_at: at(300, B),
        "context_ids_json.work": at(300, B),
      }),
    };
    const merged = merge(local, remote);
    expect(merged.finalRow).toMatchObject({ title: "B title", status: "completed" });
    expect(JSON.parse(String(merged.finalRow?.context_ids_json)).sort()).toEqual(["home", "work"]);
  });

  it("passes a delete through untouched, and an insert through the same normalization", () => {
    const tomb: SyncEntity = {
      table: "gtd_tasks",
      entityId: "t1",
      row: null,
      fieldClocks: {},
      rowHlc: at(900, B),
      deletedAt: at(900, B),
    };
    const deleted = mergeTaskEntity(input(localOf(base()), tomb));
    expect(deleted.rowAction).toBe("delete");
    expect(deleted.finalRow).toBeNull();

    const fresh: State = { row: row({ bucket: "scheduled" }), clocks: stamped(at(100)) };
    const inserted = mergeTaskEntity(input({ row: null, meta: null }, entityOf(fresh)));
    expect(inserted.rowAction).toBe("insert");
    expect(inserted.columns).toMatchObject({ id: "t1", bucket: "next_action" });
  });
});

describe("randomized convergence of the task merge", () => {
  const prng = (seed: number) => {
    let state = seed >>> 0 || 1;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };
  const pick = <T>(rand: () => number, items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)] as T;

  const BUCKETS = ["inbox", "next_action", "scheduled", "waiting_for", "planned", "someday_maybe"];
  const DEVICES = [A, B, C];

  /** A state obeying the invariants a desktop save keeps, with clocks unique to the state. */
  const randomState = (rand: () => number, index: number): State => {
    const device = DEVICES[index % DEVICES.length] as string;
    const tick = (): string => at(100 + Math.floor(rand() * 900), device, index);
    const bucket = pick(rand, BUCKETS);
    const status = pick(rand, ["active", "active", "active", "completed", "cancelled"]);
    const planned = bucket === "planned";
    const clocks = stamped(at(50), {});
    for (const column of [
      "status",
      "bucket",
      "completed_at",
      "scheduled_for",
      "planned_order",
      "project_id",
      "title",
    ]) {
      clocks[column] = tick();
    }
    return {
      row: row({
        title: `Title ${index}`,
        status,
        bucket,
        completed_at: status === "completed" ? `2026-10-0${1 + (index % 8)}T10:00:00.000Z` : null,
        scheduled_for: bucket === "scheduled" ? `2026-11-0${1 + (index % 8)}T12:00:00.000Z` : null,
        planned_order: planned ? Math.floor(rand() * 5) : null,
        project_id: planned || rand() < 0.3 ? pick(rand, ["p1", "p2"]) : null,
      }),
      clocks,
    };
  };

  const key = (state: State): string => canonicalJson([state.row, state.clocks]);
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, at) =>
          permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  for (let seed = 1; seed <= 150; seed += 1) {
    it(`seed ${seed}: pairs commute, merges are idempotent, triples converge in all orders`, () => {
      const rand = prng(seed);
      const states = [0, 1, 2].map((index) => randomState(rand, index));
      const [x, y, z] = states as [State, State, State];

      expect(key(join(x, y))).toBe(key(join(y, x)));
      expect(key(join(x, x))).toBe(key(x));
      const joined = join(x, y);
      expect(key(join(joined, x))).toBe(key(joined));
      expect(key(join(joined, y))).toBe(key(joined));

      const results = permutations(states).map((order) =>
        key(order.slice(1).reduce((acc, next) => join(acc, next), order[0] as State)),
      );
      expect(new Set(results).size).toBe(1);
      // Also with the middle merge done first: (y + z) then x.
      expect(key(join(x, join(y, z)))).toBe(results[0]);
    });
  }

  it("a terminal tuple always beats an active one, whatever the clocks", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const rand = prng(seed);
      const x = randomState(rand, 0);
      const y = randomState(rand, 1);
      const xTerminal = x.row.status !== "active";
      const yTerminal = y.row.status !== "active";
      if (xTerminal !== yTerminal) {
        expect(join(x, y).row.status).toBe(xTerminal ? x.row.status : y.row.status);
        expect(join(y, x).row.status).toBe(xTerminal ? x.row.status : y.row.status);
      }
    }
  });
});

describe("recurring instances", () => {
  const TEMPLATE = "tpl-1";
  const record = (
    dueDate: string,
    outcome: OccurrenceRecord["outcome"],
    ms: number,
    device = A,
  ): OccurrenceRecord => ({
    templateId: TEMPLATE,
    dueDate,
    outcome,
    outcomeHlc: at(ms, device),
    deviceId: device,
  });

  const instance = (
    due: string,
    status: string,
    ms: number,
    extra: RawRow = {},
    device = A,
  ): State => ({
    row: row({
      id: instanceEntityId(TEMPLATE),
      is_recurring_instance: 1,
      recurring_template_id: TEMPLATE,
      recurrence_due_date: due,
      status,
      completed_at: status === "completed" ? `${due}T10:00:00.000Z` : null,
      ...extra,
    }),
    clocks: stamped(at(50), {
      status: at(ms, device),
      completed_at: at(ms, device),
      recurrence_due_date: at(ms, device),
      pending_past_recurrences: at(ms, device),
    }),
  });

  it("the worked example: a completion of Oct 15 and a generation of Oct 16 merge in both orders", () => {
    const aRow = instance("2026-10-15", "completed", 200, {}, A);
    const bRow = instance("2026-10-16", "active", 300, { pending_past_recurrences: 1 }, B);
    const recurrence = {
      occurrences: [
        record("2026-10-15", "completed", 200, A), // beat B's `missed`
        record("2026-10-16", "active", 300, B),
      ],
      clearedThroughDate: null,
    };
    for (const [local, remote] of [
      [aRow, bRow],
      [bRow, aRow],
    ] as const) {
      const merged = merge(local, remote, { recurrence }).finalRow;
      expect(merged).toMatchObject({
        recurrence_due_date: "2026-10-16",
        status: "active",
        completed_at: null,
        pending_past_recurrences: 0,
      });
    }
  });

  it("never lets a stale epoch's completion mark the current occurrence completed", () => {
    const aRow = instance("2026-10-15", "completed", 900, {}, A); // newest clock, older epoch
    const bRow = instance("2026-10-16", "active", 300, {}, B);
    const merged = merge(aRow, bRow, {
      recurrence: {
        occurrences: [
          record("2026-10-15", "completed", 900, A),
          record("2026-10-16", "active", 300, B),
        ],
        clearedThroughDate: null,
      },
    }).finalRow;
    expect(merged).toMatchObject({ status: "active", recurrence_due_date: "2026-10-16" });
  });

  it("derives the backlog from the missed occurrences after the clear watermark, ignoring a stale count", () => {
    const stale = instance("2026-10-16", "active", 400, { pending_past_recurrences: 7 }, B);
    const cleared = instance("2026-10-16", "active", 300, { pending_past_recurrences: 0 }, A);
    const recurrence = {
      occurrences: [
        record("2026-10-13", "missed", 100),
        record("2026-10-14", "missed", 100),
        record("2026-10-15", "missed", 100),
        record("2026-10-16", "active", 100),
      ],
      clearedThroughDate: "2026-10-14",
    };
    for (const [local, remote] of [
      [stale, cleared],
      [cleared, stale],
    ] as const) {
      expect(merge(local, remote, { recurrence }).finalRow).toMatchObject({
        pending_past_recurrences: 1,
      });
    }
  });

  it("takes the terminal outcome of the current occurrence even when the row at that epoch is older", () => {
    const aRow = instance("2026-10-16", "completed", 500, {}, A);
    const bRow = instance("2026-10-16", "active", 800, { bucket: "waiting_for" }, B);
    const merged = merge(bRow, aRow, {
      recurrence: {
        occurrences: [record("2026-10-16", "completed", 500, A)],
        clearedThroughDate: null,
      },
    }).finalRow;
    expect(merged).toMatchObject({ status: "completed", bucket: "next_action" });
  });

  it("trusts the recorded occurrence over a cancelled row (the generator's pull-back is not an outcome)", () => {
    const pulledBack = instance("2026-10-21", "cancelled", 900, {}, B); // newest clock
    const generated = instance("2026-10-21", "active", 300, {}, A);
    const recurrence = {
      occurrences: [record("2026-10-21", "active", 300, A)],
      clearedThroughDate: null,
    };
    for (const [local, remote] of [
      [pulledBack, generated],
      [generated, pulledBack],
    ] as const) {
      expect(merge(local, remote, { recurrence }).finalRow).toMatchObject({
        status: "active",
        recurrence_due_date: "2026-10-21",
      });
    }
    // Without any record, the row's own status stands in for it.
    expect(merge(generated, pulledBack).finalRow).toMatchObject({ status: "cancelled" });
  });

  it("recomputes from the sidecars alone when no peer row is given", () => {
    const local = instance("2026-10-15", "active", 200, { pending_past_recurrences: 1 });
    const outcome = mergeTaskEntity(input(localOf(local), null), {
      recurrence: {
        occurrences: [
          record("2026-10-15", "completed", 250, B),
          record("2026-10-16", "active", 300, B),
        ],
        clearedThroughDate: null,
      },
    });
    // The row catches up to the latest occurrence recorded by a peer.
    expect(outcome.finalRow).toMatchObject({
      recurrence_due_date: "2026-10-16",
      status: "active",
      pending_past_recurrences: 0,
    });
    expect(outcome.rowAction).toBe("update");
    expect(outcome.metaChanged).toBe(false);
  });

  it("merges the non-lifecycle fields of an instance per field", () => {
    const local = instance("2026-10-16", "active", 300, { title: "Mine" });
    local.clocks.title = at(900, A);
    const remote = instance("2026-10-16", "active", 300, { title: "Theirs" }, B);
    remote.clocks.title = at(400, B);
    expect(
      merge(local, remote, { recurrence: { occurrences: [], clearedThroughDate: null } }).finalRow,
    ).toMatchObject({ title: "Mine" });
  });
});

describe("recurring template", () => {
  const TEMPLATE_COLUMNS = [
    "id",
    "title",
    "last_generated_for_date",
    "pending_missed_occurrences",
    "updated_at",
  ];
  const tplInput = (local: LocalEntityState, remote: SyncEntity | null) => ({
    codec: buildEntityCodec("recurring_task_templates", TEMPLATE_COLUMNS) as FieldCodec,
    columns: TEMPLATE_COLUMNS,
    primaryKey: ["id"],
    notNullColumns: new Set(["id", "title"]),
    local,
    remote,
  });
  const tpl = (last: string | null, ms: number, device = A): State => ({
    row: {
      id: "tpl-1",
      title: "Water",
      last_generated_for_date: last,
      pending_missed_occurrences: 0,
      updated_at: "x",
    },
    clocks: {
      title: at(50),
      last_generated_for_date: at(ms, device),
      pending_missed_occurrences: at(ms, device),
      updated_at: at(ms, device),
    },
  });
  const entity = (state: State): SyncEntity => ({
    ...entityOf(state),
    table: "recurring_task_templates",
    entityId: "tpl-1",
  });

  it("derives last_generated_for_date from the latest occurrence, not from the newest clock", () => {
    const newerButOlder = tpl("2026-10-15", 900, B);
    const older = tpl("2026-10-16", 100, A);
    const recurrence = {
      occurrences: [
        {
          templateId: "tpl-1",
          dueDate: "2026-10-16",
          outcome: "active" as const,
          outcomeHlc: at(100),
          deviceId: A,
        },
      ],
      clearedThroughDate: null,
    };
    const outcome = mergeTemplateEntity(tplInput(localOf(newerButOlder), entity(older)), {
      recurrence,
    });
    expect(outcome.finalRow).toMatchObject({ last_generated_for_date: "2026-10-16" });
  });

  it("falls back to the generic merge when the template has no occurrence", () => {
    const outcome = mergeTemplateEntity(
      tplInput(localOf(tpl("2026-10-15", 100)), entity(tpl("2026-10-16", 900, B))),
    );
    expect(outcome.finalRow).toMatchObject({ last_generated_for_date: "2026-10-16" });
  });
});
