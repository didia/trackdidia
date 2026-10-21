// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import { encodeHlc } from "./hlc";
import { SEGMENT_RULES, SESSION_RULES } from "./merge-pomodoro";
import { keepsPending, PROPOSAL_RULES } from "./merge-proposal";
import { compareVersions, mergeRowEntity, ROW_CONFLICT_FIELD, type RowRules } from "./merge-row";

const DEV = "dev:00000000-0000-4000-8000-000000000001";
const clock = (n: number) => encodeHlc(1_800_000_000_000 + n, 0, DEV);

const SESSION_COLUMNS = ["id", "status", "cycle_index"];
const SEGMENT_COLUMNS = ["id", "session_id", "title", "ended_at"];
const PROPOSAL_COLUMNS = ["id", "status", "applied_entity_id", "decided_at"];

type State = { row: RawRow; clock: string } | { deletedAt: string };

const remoteOf = (id: string, table: string, state: State): SyncEntity =>
  "row" in state
    ? { table, entityId: id, row: state.row, fieldClocks: {}, rowHlc: state.clock, deletedAt: null }
    : {
        table,
        entityId: id,
        row: null,
        fieldClocks: {},
        rowHlc: state.deletedAt,
        deletedAt: state.deletedAt,
      };

/** Merges `remote` into `local` and returns the state that results (row + clock, or tombstone). */
const merge = (
  columns: string[],
  rules: RowRules,
  local: State | null,
  remote: State,
): State | null => {
  const row = local && "row" in local ? local.row : null;
  const meta = local
    ? "row" in local
      ? { fieldClocks: {}, rowHlc: local.clock, deletedAt: null }
      : { fieldClocks: {}, rowHlc: local.deletedAt, deletedAt: local.deletedAt }
    : null;
  const outcome = mergeRowEntity({
    columns,
    local: { row, meta },
    remote: remoteOf("x", "t", remote),
    rules,
  });
  if (outcome.meta.deletedAt !== null) {
    return local === null && outcome.rowAction === "none" && !outcome.metaChanged
      ? null
      : { deletedAt: outcome.meta.deletedAt };
  }
  if (outcome.finalRow === null) return local;
  return { row: outcome.finalRow, clock: outcome.meta.rowHlc };
};

const canon = (state: State | null): string => JSON.stringify(state);

/** Folds states in the given order starting from nothing. */
const fold = (columns: string[], rules: RowRules, states: State[]): State | null =>
  states.reduce<State | null>((acc, state) => {
    if (acc === null) {
      return merge(columns, rules, null, state);
    }
    return merge(columns, rules, acc, state);
  }, null);

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ]),
      );

describe("whole-row merge", () => {
  const row = (extra: RawRow = {}): RawRow => ({
    id: "x",
    status: "completed",
    cycle_index: 1,
    ...extra,
  });

  it("inserts a new row and records its clock", () => {
    const outcome = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local: { row: null, meta: null },
      remote: remoteOf("x", "t", { row: row(), clock: clock(1) }),
    });
    expect(outcome).toMatchObject({ rowAction: "insert", metaChanged: true, finalRow: row() });
    expect(outcome.meta).toEqual({ fieldClocks: {}, rowHlc: clock(1), deletedAt: null });
  });

  it("keeps the later version, whole, and reports the overwritten one only when asked", () => {
    const local = {
      row: row({ cycle_index: 1 }),
      meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
    };
    const remote = remoteOf("x", "t", { row: row({ cycle_index: 2 }), clock: clock(2) });
    const quiet = mergeRowEntity({ columns: SESSION_COLUMNS, local, remote });
    expect(quiet).toMatchObject({
      rowAction: "update",
      columns: { cycle_index: 2 },
      overwritten: [],
    });
    const loud = mergeRowEntity({ columns: SESSION_COLUMNS, local, remote, rules: SESSION_RULES });
    expect(loud.overwritten).toHaveLength(1);
    expect(loud.overwritten[0]).toMatchObject({ field: ROW_CONFLICT_FIELD });
    // The earlier remote version changes nothing.
    const stale = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local,
      remote: remoteOf("x", "t", { row: row({ cycle_index: 9 }), clock: clock(0) }),
      rules: SESSION_RULES,
    });
    expect(stale).toMatchObject({ rowAction: "none", metaChanged: false, overwritten: [] });
  });

  it("reports an overwrite only when the replaced version was issued by the applying device", () => {
    const peer = "dev:00000000-0000-4000-8000-000000000002";
    const local = {
      row: row({ cycle_index: 1 }),
      meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
    };
    const remote = remoteOf("x", "t", { row: row({ cycle_index: 2 }), clock: clock(2) });
    // The local version carries this device's clock: a lost local edit.
    const mine = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local,
      remote,
      rules: SESSION_RULES,
      localDeviceId: DEV,
    });
    expect(mine.overwritten).toHaveLength(1);
    // The local version itself came from the peer and is replaced by that peer's later edit:
    // ordinary propagation, nothing was lost, nothing is logged.
    const propagated = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local,
      remote,
      rules: SESSION_RULES,
      localDeviceId: peer,
    });
    expect(propagated).toMatchObject({ rowAction: "update", columns: { cycle_index: 2 } });
    expect(propagated.overwritten).toEqual([]);
  });

  it("is a no-op for the same version (idempotent)", () => {
    const local = { row: row(), meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null } };
    const outcome = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local,
      remote: remoteOf("x", "t", { row: row(), clock: clock(1) }),
    });
    expect(outcome).toMatchObject({ rowAction: "none", metaChanged: false });
  });

  it("an unstamped local row loses to any remote clock", () => {
    const outcome = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local: { row: row({ cycle_index: 1 }), meta: null },
      remote: remoteOf("x", "t", { row: row({ cycle_index: 5 }), clock: clock(1) }),
    });
    expect(outcome).toMatchObject({ rowAction: "update", columns: { cycle_index: 5 } });
  });

  it("columns the sender lacks keep their local value", () => {
    const outcome = mergeRowEntity({
      columns: SESSION_COLUMNS,
      local: {
        row: row({ cycle_index: 3 }),
        meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
      },
      remote: remoteOf("x", "t", { row: { id: "x", status: "cancelled" }, clock: clock(2) }),
    });
    expect(outcome.finalRow).toMatchObject({ status: "cancelled", cycle_index: 3 });
  });

  describe("delete against edit", () => {
    const tomb = (n: number): State => ({ deletedAt: clock(n) });
    const edit = (n: number, cycle = n): State => ({
      row: row({ cycle_index: cycle }),
      clock: clock(n),
    });

    it("the later clock wins; an edit as late as the delete keeps the row", () => {
      expect(merge(SESSION_COLUMNS, {}, edit(1), tomb(2))).toEqual(tomb(2));
      expect(merge(SESSION_COLUMNS, {}, edit(3), tomb(2))).toEqual(edit(3));
      expect(merge(SESSION_COLUMNS, {}, edit(2), tomb(2))).toEqual(edit(2));
      expect(merge(SESSION_COLUMNS, {}, tomb(2), edit(3))).toEqual(edit(3));
      expect(merge(SESSION_COLUMNS, {}, tomb(3), edit(2))).toEqual(tomb(3));
      expect(merge(SESSION_COLUMNS, {}, tomb(2), tomb(5))).toEqual(tomb(5));
    });

    it("records a tombstone for a row never seen", () => {
      const outcome = mergeRowEntity({
        columns: SESSION_COLUMNS,
        local: { row: null, meta: null },
        remote: remoteOf("x", "t", tomb(2)),
      });
      expect(outcome).toMatchObject({
        rowAction: "none",
        metaChanged: true,
        tombstoneApplied: true,
      });
    });
  });

  it("is order independent over every permutation of live and deleted states", () => {
    const states: State[] = [
      { row: row({ cycle_index: 1 }), clock: clock(1) },
      { row: row({ cycle_index: 2 }), clock: clock(2) },
      { deletedAt: clock(3) },
      { row: row({ cycle_index: 4 }), clock: clock(4) },
      { row: row({ cycle_index: 9 }), clock: clock(4) }, // same clock: the smaller JSON wins
    ];
    for (const rules of [{}, SESSION_RULES]) {
      const results = new Set(
        permutations(states).map((order) => canon(fold(SESSION_COLUMNS, rules, order))),
      );
      expect(results.size).toBe(1);
    }
  });
});

describe("segments: ended_at is joined", () => {
  const seg = (title: string, endedAt: string | null): RawRow => ({
    id: "x",
    session_id: "s",
    title,
    ended_at: endedAt,
  });

  it("non-null beats null whichever version is newer, other columns follow the clock", () => {
    const closedOlder: State = { row: seg("old", "2026-10-01T10:00:00Z"), clock: clock(1) };
    const openNewer: State = { row: seg("new", null), clock: clock(2) };
    for (const order of [
      [closedOlder, openNewer],
      [openNewer, closedOlder],
    ]) {
      expect(fold(SEGMENT_COLUMNS, SEGMENT_RULES, order)).toEqual({
        row: seg("new", "2026-10-01T10:00:00Z"),
        clock: clock(2),
      });
    }
  });

  it("two different ends keep the later timestamp", () => {
    const a: State = { row: seg("a", "2026-10-01T10:00:00Z"), clock: clock(5) };
    const b: State = { row: seg("b", "2026-10-01T11:00:00Z"), clock: clock(1) };
    expect(fold(SEGMENT_COLUMNS, SEGMENT_RULES, [a, b])).toEqual({
      row: seg("a", "2026-10-01T11:00:00Z"),
      clock: clock(5),
    });
  });

  it("is order independent over every permutation, equal clocks and tombstone included", () => {
    const states: State[] = [
      { row: seg("a", null), clock: clock(1) },
      { row: seg("b", "2026-10-01T10:00:00Z"), clock: clock(2) },
      { row: seg("c", "2026-10-01T09:00:00Z"), clock: clock(2) },
      { row: seg("d", null), clock: clock(2) },
      { row: seg("e", "2026-10-01T12:00:00Z"), clock: clock(0) },
    ];
    const results = new Set(
      permutations(states).map((order) => canon(fold(SEGMENT_COLUMNS, SEGMENT_RULES, order))),
    );
    expect(results.size).toBe(1);
  });
});

describe("proposals: terminal beats pending", () => {
  const proposal = (status: string, extra: RawRow = {}): RawRow => ({
    id: "x",
    status,
    applied_entity_id: null,
    decided_at: null,
    ...extra,
  });

  it("a terminal row beats a pending one with a later clock, and brings its whole row", () => {
    const accepted: State = {
      row: proposal("accepted", { applied_entity_id: "t1", decided_at: "d" }),
      clock: clock(1),
    };
    const pendingLater: State = { row: proposal("pending"), clock: clock(9) };
    for (const order of [
      [accepted, pendingLater],
      [pendingLater, accepted],
    ]) {
      expect(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order)).toEqual(accepted);
    }
  });

  it("different terminals keep the smaller status and raise a terminal_divergence conflict", () => {
    const outcome = mergeRowEntity({
      columns: PROPOSAL_COLUMNS,
      local: {
        row: proposal("dismissed"),
        meta: { fieldClocks: {}, rowHlc: clock(9), deletedAt: null },
      },
      remote: remoteOf("x", "ai_proposals", { row: proposal("accepted"), clock: clock(1) }),
      rules: PROPOSAL_RULES,
    });
    expect(outcome.finalRow?.status).toBe("accepted");
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toMatchObject({
      kind: "terminal_divergence",
      entityType: "ai_proposals",
      entityId: "x",
    });
    // The same pair found again is the same conflict id, from either side.
    const reverse = mergeRowEntity({
      columns: PROPOSAL_COLUMNS,
      local: {
        row: proposal("accepted"),
        meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
      },
      remote: remoteOf("x", "ai_proposals", { row: proposal("dismissed"), clock: clock(9) }),
      rules: PROPOSAL_RULES,
    });
    expect(reverse.conflicts[0]?.id).toBe(outcome.conflicts[0]?.id);
    expect(reverse.finalRow?.status).toBe("accepted");
  });

  it("raises no conflict for the same status or for pending against terminal", () => {
    for (const [left, right] of [
      ["accepted", "accepted"],
      ["pending", "accepted"],
      ["pending", "pending"],
    ]) {
      const outcome = mergeRowEntity({
        columns: PROPOSAL_COLUMNS,
        local: {
          row: proposal(left as string),
          meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
        },
        remote: remoteOf("x", "ai_proposals", { row: proposal(right as string), clock: clock(2) }),
        rules: PROPOSAL_RULES,
      });
      expect(outcome.conflicts).toEqual([]);
    }
  });

  it("is order independent over every permutation of statuses and clocks", () => {
    const states: State[] = [
      { row: proposal("pending"), clock: clock(7) },
      { row: proposal("pending", { decided_at: "z" }), clock: clock(1) },
      { row: proposal("expired", { decided_at: "e" }), clock: clock(2) },
      { row: proposal("dismissed", { decided_at: "d" }), clock: clock(3) },
      { row: proposal("dismissed", { decided_at: "d2" }), clock: clock(5) },
      { row: proposal("accepted", { applied_entity_id: "t" }), clock: clock(0) },
    ];
    const results = new Set(
      permutations(states).map((order) => canon(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order))),
    );
    expect(results.size).toBe(1);
    expect([...results][0]).toContain('"status":"accepted"');
  });

  it("a decided proposal survives any tombstone, a pending one follows the clocks, in every order", () => {
    const accepted: State = {
      row: proposal("accepted", { applied_entity_id: "t" }),
      clock: clock(1),
    };
    const lateDelete: State = { deletedAt: clock(50) };
    for (const order of permutations([accepted, lateDelete])) {
      expect(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order)).toEqual(accepted);
    }
    const pending: State = { row: proposal("pending"), clock: clock(1) };
    for (const order of permutations([pending, lateDelete])) {
      expect(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order)).toEqual(lateDelete);
    }
    const states: State[] = [
      pending,
      lateDelete,
      { row: proposal("dismissed", { decided_at: "d" }), clock: clock(3) },
      { deletedAt: clock(2) },
      { row: proposal("pending", { decided_at: "z" }), clock: clock(60) },
    ];
    const results = new Set(
      permutations(states).map((order) => canon(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order))),
    );
    expect(results.size).toBe(1);
    expect([...results][0]).toContain('"status":"dismissed"');
    // Other tables are unaffected: a plain row still loses to a later delete.
    expect(
      fold(SESSION_COLUMNS, {}, [
        { row: { id: "x", status: "completed", cycle_index: 1 }, clock: clock(1) },
        lateDelete,
      ]),
    ).toEqual(lateDelete);
  });

  it("expired, a later pending and an in-between delete give one result in every order (no cycle)", () => {
    // expired beats pending by rank, pending beats the tombstone by clock, and expired beats the
    // tombstone because a terminal row survives deletes: a total order, not a cycle.
    const expired: State = { row: proposal("expired"), clock: clock(1) };
    const lateDelete: State = { deletedAt: clock(5) };
    const pending: State = { row: proposal("pending"), clock: clock(10) };
    const results = new Set(
      permutations([expired, lateDelete, pending]).map((order) =>
        canon(fold(PROPOSAL_COLUMNS, PROPOSAL_RULES, order)),
      ),
    );
    expect(results.size).toBe(1);
    expect([...results][0]).toContain('"status":"expired"');
  });

  it("compareVersions is antisymmetric", () => {
    const a = { row: proposal("pending"), clock: clock(1) };
    const b = { row: proposal("accepted"), clock: clock(0) };
    expect(compareVersions(a, b, PROPOSAL_RULES)).toBe(-compareVersions(b, a, PROPOSAL_RULES));
    expect(compareVersions(a, a, PROPOSAL_RULES)).toBe(0);
  });
});

describe("keepsPending", () => {
  it("the later clock keeps the slot, a tie goes to the greater id, a missing clock loses", () => {
    expect(
      keepsPending({ id: "a", clock: clock(2) }, { id: "b", clock: clock(1) }),
    ).toBeGreaterThan(0);
    expect(keepsPending({ id: "a", clock: clock(1) }, { id: "b", clock: clock(1) })).toBeLessThan(
      0,
    );
    expect(
      keepsPending({ id: "b", clock: clock(1) }, { id: "a", clock: clock(1) }),
    ).toBeGreaterThan(0);
    expect(keepsPending({ id: "a", clock: null }, { id: "b", clock: clock(1) })).toBeLessThan(0);
    expect(keepsPending({ id: "a", clock: null }, { id: "a", clock: null })).toBe(0);
  });
});
