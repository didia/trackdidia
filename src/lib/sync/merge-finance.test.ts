import { describe, expect, it } from "vitest";
import type { RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import { canonicalJson } from "./field-clocks";
import { encodeHlc } from "./hlc";
import type { EntityMeta } from "./merge-entity";
import {
  compareAnchors,
  compareUnits,
  mergeTransactionEntity,
  nextUnitVersion,
  SNAPSHOT_RULES,
  SUGGESTION_RULES,
  type TransactionMergeOutcome,
  UNIT_CLOCK_KEYS,
  UNIT_COLUMNS,
  unitClocksOf,
  unitOverwrite,
  unitPayloadOf,
  unitSignature,
  type UnitVersion,
  unitVersionOf,
  wantedChildren,
} from "./merge-finance";
import { mergeRowEntity } from "./merge-row";

/**
 * Pure tests of the finance merge rules: the categorization unit (order, examples of the spec,
 * randomized 3-replica convergence), the suggestion status rules and the statement anchors.
 */

const A = "dev:00000000-0000-4000-8000-000000000001";
const B = "dev:00000000-0000-4000-8000-000000000002";
const C = "dev:00000000-0000-4000-8000-000000000003";

const clock = (ms: number, device = A, counter = 0): string => encodeHlc(ms, counter, device);

const COLUMNS = [
  "id",
  "description_raw",
  "category_id",
  "category_source",
  "category_confidence",
  "categorized_at",
  "has_splits",
  "updated_at",
];

const txnRow = (overrides: Record<string, unknown> = {}): RawRow => ({
  id: "t1",
  description_raw: "IGA",
  category_id: "fincat:non-categorise",
  category_source: "default",
  category_confidence: null,
  categorized_at: null,
  has_splits: 0,
  updated_at: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const unit = (
  c: string,
  base: string | null = null,
  protect: string | null = null,
): UnitVersion => ({
  clock: c,
  base,
  protect,
});

const metaOf = (version: UnitVersion, rowHlc: string): EntityMeta => ({
  fieldClocks: unitClocksOf(version),
  rowHlc,
  deletedAt: null,
});

describe("unit versions", () => {
  it("round-trips through the clock keys and reads an unstamped row from its row clock", () => {
    const version = unit(clock(30), clock(20), clock(10));
    const clocks = unitClocksOf(version);
    expect(Object.keys(clocks).sort()).toEqual([...UNIT_CLOCK_KEYS].sort());
    expect(unitVersionOf(clocks, clock(99), txnRow())).toEqual(version);
    expect(unitClocksOf(unit(clock(1)))).toEqual({ categorization: clock(1) });
    // A row from before the unit existed: its row clock stands in; a user row protects itself.
    expect(unitVersionOf({}, clock(5), txnRow())).toEqual(unit(clock(5)));
    expect(unitVersionOf({}, clock(5), txnRow({ category_source: "user" }))).toEqual(
      unit(clock(5), null, clock(5)),
    );
  });

  it("stamps a user write as self-protecting and an automatic one as inheriting protection", () => {
    const first = nextUnitVersion(null, "default", clock(1));
    expect(first).toEqual(unit(clock(1)));
    const manual = nextUnitVersion(first, "user", clock(2));
    expect(manual).toEqual(unit(clock(2), clock(1), clock(2)));
    const reset = nextUnitVersion(manual, "default", clock(3));
    expect(reset).toEqual(unit(clock(3), clock(2), clock(2)));
    // A later user decision protects itself again.
    expect(nextUnitVersion(reset, "user", clock(4))).toEqual(unit(clock(4), clock(3), clock(4)));
  });

  it("changes the unit signature with the payload and with any child, not with other columns", () => {
    const row = txnRow({ category_source: "user" });
    const child = { id: "s1", transaction_id: "t1", amount_minor: -100, category_id: "x" };
    const base = unitSignature(row, [child]);
    expect(unitSignature({ ...row, description_raw: "other", updated_at: "z" }, [child])).toBe(
      base,
    );
    expect(unitSignature({ ...row, category_id: "y" }, [child])).not.toBe(base);
    expect(unitSignature(row, [{ ...child, amount_minor: -99 }])).not.toBe(base);
    expect(unitSignature(row, [])).not.toBe(base);
    expect(unitSignature(row, [child, { ...child, id: "s0" }])).toBe(
      unitSignature(row, [{ ...child, id: "s0" }, child]),
    );
  });
});

describe("the unit order", () => {
  const side = (version: UnitVersion, categoryId = "x") => ({
    version,
    payload: unitPayloadOf(txnRow({ category_id: categoryId })),
  });

  it("is antisymmetric and total on distinct writes", () => {
    const writes = [
      unit(clock(1)),
      unit(clock(2), clock(1), clock(2)),
      unit(clock(3), clock(2), clock(2)),
      unit(clock(4, B)),
      unit(clock(5, B), null, clock(5, B)),
    ];
    for (const left of writes) {
      for (const right of writes) {
        const forward = compareUnits(side(left), side(right));
        const backward = compareUnits(side(right), side(left));
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
        if (left !== right) expect(forward).not.toBe(0);
      }
    }
  });

  it("lets a user write beat a concurrent automatic one whatever the clocks", () => {
    const manual = unit(clock(10, A), null, clock(10, A));
    const staleAutomatic = unit(clock(99, B));
    expect(compareUnits(side(manual), side(staleAutomatic))).toBeGreaterThan(0);
  });

  it("lets two concurrent user writes compare by clock", () => {
    const earlier = unit(clock(10, A), null, clock(10, A));
    const later = unit(clock(20, B), null, clock(20, B));
    expect(compareUnits(side(later), side(earlier))).toBeGreaterThan(0);
  });

  it("lets a write that saw another win even when it is automatic (the spec's reset)", () => {
    const withSplits = unit(clock(10, B), null, clock(10, B));
    const reset = nextUnitVersion(withSplits, "default", clock(20, A));
    expect(compareUnits(side(reset), side(withSplits))).toBeGreaterThan(0);
  });

  it("does not cycle where the pairwise causal rule would", () => {
    // Y user; X automatic that saw Y; Z automatic that saw neither and is later than both. The
    // pairwise rule "base >= clock wins, else user beats automatic, else later" gives X > Y,
    // Y > Z and Z > X. The total order puts X (inherited protection) first, then Y, then Z.
    const y = unit(clock(5, B), clock(1, C), clock(5, B));
    const x = nextUnitVersion(y, "default", clock(10, A));
    const z = unit(clock(20, C), clock(1, C));
    const ordered = [z, y, x].sort((p, q) => compareUnits(side(q), side(p)));
    expect(ordered).toEqual([x, y, z]);
  });

  it("breaks an exact clock tie by the smaller canonical payload", () => {
    const version = unit(clock(10));
    const a = { version, payload: unitPayloadOf(txnRow({ category_id: "a" })) };
    const b = { version, payload: unitPayloadOf(txnRow({ category_id: "b" })) };
    expect(compareUnits(a, b)).toBeGreaterThan(0);
    expect(compareUnits(b, a)).toBeLessThan(0);
    expect(compareUnits(a, { ...a })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// A replica of one transaction: row, meta and the children of the unit
// ---------------------------------------------------------------------------------------------

interface Replica {
  row: RawRow | null;
  meta: EntityMeta | null;
  children: RawRow[];
}

const EMPTY: Replica = { row: null, meta: null, children: [] };

const toEntity = (replica: Replica): SyncEntity => {
  if (replica.row === null || replica.meta === null) throw new Error("not a live replica");
  return {
    table: "finance_transactions",
    entityId: String(replica.row.id),
    row: replica.row,
    fieldClocks: replica.meta.fieldClocks,
    rowHlc: replica.meta.rowHlc,
    deletedAt: null,
  };
};

const tombstoneEntity = (deletedAt: string): SyncEntity => ({
  table: "finance_transactions",
  entityId: "t1",
  row: null,
  fieldClocks: {},
  rowHlc: deletedAt,
  deletedAt,
});

/** What `apply-finance.ts` does for one transaction and its children, on plain data. */
const mergeInto = (
  local: Replica,
  remote: SyncEntity,
  remoteChildren: RawRow[],
): { replica: Replica; outcome: TransactionMergeOutcome } => {
  const outcome = mergeTransactionEntity({
    columns: COLUMNS,
    local: { row: local.row, meta: local.meta },
    remote,
  });
  const wanted = wantedChildren(outcome.unit.winner, remoteChildren);
  const row = outcome.finalRow === null ? null : { ...outcome.finalRow };
  return {
    outcome,
    replica: {
      row,
      meta: outcome.finalRow === null ? outcome.meta : outcome.meta,
      children: wanted === null ? local.children : [...wanted],
    },
  };
};

const merge = (local: Replica, remote: Replica): Replica =>
  mergeInto(local, toEntity(remote), remote.children).replica;

const stateKey = (replica: Replica): string =>
  canonicalJson({
    row: replica.row,
    meta: replica.meta,
    children: [...replica.children].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });

const split = (id: string, amount: number): RawRow => ({
  id,
  transaction_id: "t1",
  amount_minor: amount,
  category_id: "fincat:alimentation",
});

/** A local categorization write on a replica, as capture stamps it. */
const categorize = (
  replica: Replica,
  at: string,
  categoryId: string,
  source: string,
  children: RawRow[] = [],
): Replica => {
  const previous =
    replica.row !== null && replica.meta !== null
      ? unitVersionOf(replica.meta.fieldClocks, replica.meta.rowHlc, replica.row)
      : null;
  const version = nextUnitVersion(previous, source, at);
  return {
    row: {
      ...(replica.row ?? txnRow()),
      category_id: categoryId,
      category_source: source,
      has_splits: children.length > 0 ? 1 : 0,
      updated_at: at,
    },
    meta: metaOf(version, at),
    children,
  };
};

const editDescription = (replica: Replica, at: string, description: string): Replica => ({
  ...replica,
  row: { ...(replica.row as RawRow), description_raw: description, updated_at: at },
  meta: { ...(replica.meta as EntityMeta), rowHlc: at },
});

const created = (at: string): Replica => ({
  row: txnRow(),
  meta: metaOf(nextUnitVersion(null, "default", at), at),
  children: [],
});

describe("mergeTransactionEntity: the spec's examples", () => {
  it("causally later wins: A's removal of the last split is not undone when B republishes", () => {
    const base = created(clock(1, A));
    // B categorizes with splits (user); A receives it, then removes the final split.
    const b = categorize(base, clock(10, B), "fincat:split", "user", [
      split("s1", -60),
      split("s2", -40),
    ]);
    let a = merge(base, b);
    expect(a.children).toHaveLength(2);
    const reset = categorize(a, clock(20, A), "fincat:non-categorise", "default", []);
    a = reset;
    // B republishes an unrelated edit, still carrying its old unit and its old children.
    const bEdited = editDescription(b, clock(30, B), "IGA renamed");
    const atA = merge(a, bEdited);
    expect(atA.row?.category_id).toBe("fincat:non-categorise");
    expect(atA.row?.category_source).toBe("default");
    expect(atA.row?.has_splits).toBe(0);
    expect(atA.children).toEqual([]); // B's old children are NOT restored
    expect(atA.row?.description_raw).toBe("IGA renamed"); // the row clock still merges the edit
    // And B converges to A's reset, losing the children.
    const atB = merge(bEdited, a);
    expect(atB.row?.category_id).toBe("fincat:non-categorise");
    expect(atB.children).toEqual([]);
    expect(atB.row?.description_raw).toBe("IGA renamed");
    expect(stateKey(atA)).toBe(stateKey(atB));
  });

  it("a peer republishing an unchanged row loses to any later write", () => {
    const base = created(clock(1, A));
    const bOld = categorize(base, clock(5, B), "fincat:alimentation", "rule");
    const aNew = categorize(merge(base, bOld), clock(9, A), "fincat:transport", "rule");
    const republished = { ...bOld, meta: { ...(bOld.meta as EntityMeta), rowHlc: clock(40, B) } };
    expect(merge(aNew, republished).row?.category_id).toBe("fincat:transport");
  });

  it("a stale automatic stage never overwrites a manual choice, on either replica", () => {
    const base = created(clock(1, A));
    const manual = categorize(base, clock(10, A), "fincat:logement", "user");
    const automatic = categorize(base, clock(50, B), "fincat:transport", "rule");
    for (const [local, remote] of [
      [manual, automatic],
      [automatic, manual],
    ] as const) {
      const merged = merge(local, remote);
      expect(merged.row?.category_id).toBe("fincat:logement");
      expect(merged.row?.category_source).toBe("user");
    }
  });

  it("two concurrent user writes: the later HLC wins and the loser is logged", () => {
    const base = created(clock(1, A));
    const first = categorize(base, clock(10, A), "fincat:logement", "user");
    const second = categorize(base, clock(20, B), "fincat:transport", "user");
    const atFirst = mergeInto(first, toEntity(second), second.children);
    expect(atFirst.replica.row?.category_id).toBe("fincat:transport");
    const lost = unitOverwrite(
      {
        version: atFirst.outcome.unit.local as UnitVersion,
        row: first.row as RawRow,
        signature: unitSignature(first.row as RawRow, first.children),
      },
      {
        version: atFirst.outcome.unit.remote as UnitVersion,
        row: second.row as RawRow,
        signature: unitSignature(second.row as RawRow, second.children),
      },
      { local: first.children, remote: second.children },
    );
    expect(lost).toMatchObject({ field: "categorization" });
    // The replica that keeps its value logs nothing: the winner never lost anything.
    const atSecond = mergeInto(second, toEntity(first), first.children);
    expect(atSecond.outcome.unit.winner).toBe("local");
    expect(atSecond.replica.row?.category_id).toBe("fincat:transport");
  });

  it("an ordinary later user edit that saw the earlier one is not logged as an overwrite", () => {
    const base = created(clock(1, A));
    const first = categorize(base, clock(10, A), "fincat:logement", "user");
    const second = categorize(merge(base, first), clock(20, B), "fincat:transport", "user");
    const { outcome } = mergeInto(first, toEntity(second), second.children);
    expect(outcome.unit.winner).toBe("remote");
    expect(
      unitOverwrite(
        {
          version: outcome.unit.local as UnitVersion,
          row: first.row as RawRow,
          signature: unitSignature(first.row as RawRow, []),
        },
        {
          version: outcome.unit.remote as UnitVersion,
          row: second.row as RawRow,
          signature: unitSignature(second.row as RawRow, []),
        },
        { local: [], remote: [] },
      ),
    ).toBeNull();
  });

  it("logs a lost unit only when the replaced decision was this device's own", () => {
    const row = txnRow({ category_source: "user" });
    const local = { version: unit(clock(5, A), null, clock(5, A)), row, signature: "a" };
    const remote = { version: unit(clock(9, B)), row, signature: "b" };
    const splits = { local: [], remote: [] };
    expect(unitOverwrite(local, remote, splits, A)).toMatchObject({ field: "categorization" });
    // The decision came from A and is replaced on C by B's later write: propagation for C.
    expect(unitOverwrite(local, remote, splits, C)).toBeNull();
  });

  it("does not log an automatic value that lost, nor an identical unit", () => {
    const row = txnRow({ category_source: "rule" });
    const lost = unitOverwrite(
      { version: unit(clock(1)), row, signature: "a" },
      { version: unit(clock(2, B)), row, signature: "b" },
      { local: [], remote: [] },
    );
    expect(lost).toBeNull();
    const user = txnRow({ category_source: "user" });
    expect(
      unitOverwrite(
        { version: unit(clock(1), null, clock(1)), row: user, signature: "same" },
        { version: unit(clock(2, B)), row: user, signature: "same" },
        { local: [], remote: [] },
      ),
    ).toBeNull();
  });
});

describe("mergeTransactionEntity: row and unit are merged independently", () => {
  it("takes the other columns from the row winner and the unit from the unit winner", () => {
    const base = created(clock(1, A));
    // A: user categorization at 10, then nothing. B: a description edit at 50 (row clock later).
    const a = categorize(base, clock(10, A), "fincat:logement", "user");
    const b = editDescription(base, clock(50, B), "edited at B");
    const merged = merge(a, b);
    expect(merged.row?.description_raw).toBe("edited at B"); // row winner: B
    expect(merged.row?.category_id).toBe("fincat:logement"); // unit winner: A
    expect(merged.row?.category_source).toBe("user");
    expect(merged.meta?.rowHlc).toBe(clock(50, B));
    expect(unitVersionOf(merged.meta?.fieldClocks ?? {}, "", merged.row as RawRow).clock).toBe(
      clock(10, A),
    );
    expect(stateKey(merge(b, a))).toBe(stateKey(merged));
  });

  it("keeps the winning unit's children as a set and never mixes two sets", () => {
    const base = created(clock(1, A));
    const a = categorize(base, clock(10, A), "fincat:split", "user", [
      split("a1", -50),
      split("a2", -50),
    ]);
    const b = categorize(base, clock(20, B), "fincat:split", "user", [split("b1", -100)]);
    for (const [local, remote] of [
      [a, b],
      [b, a],
    ] as const) {
      const merged = merge(local, remote);
      expect(merged.children.map((child) => child.id)).toEqual(["b1"]);
    }
  });

  it("keeps the local children when the local unit wins or is the same write", () => {
    const base = created(clock(1, A));
    const a = categorize(base, clock(10, A), "fincat:split", "user", [split("a1", -100)]);
    expect(merge(a, a).children.map((child) => child.id)).toEqual(["a1"]);
    const stale = categorize(base, clock(5, B), "fincat:split", "rule", [split("old", -100)]);
    expect(merge(a, stale).children.map((child) => child.id)).toEqual(["a1"]);
  });

  it("is idempotent: merging the same entity again changes nothing", () => {
    const base = created(clock(1, A));
    const b = categorize(base, clock(10, B), "fincat:split", "user", [split("b1", -100)]);
    const once = merge(base, b);
    const twice = mergeInto(once, toEntity(b), b.children);
    expect(stateKey(twice.replica)).toBe(stateKey(once));
    expect(twice.outcome.rowAction).toBe("none");
    expect(twice.outcome.metaChanged).toBe(false);
    expect(twice.outcome.unit.winner).toBe("equal");
  });

  it("inserts a remote transaction with its unit clocks and children", () => {
    const b = categorize(created(clock(1, B)), clock(10, B), "fincat:split", "user", [
      split("b1", -100),
    ]);
    const { replica, outcome } = mergeInto(EMPTY, toEntity(b), b.children);
    expect(outcome.rowAction).toBe("insert");
    expect(outcome.unit.winner).toBe("remote");
    expect(replica.meta?.fieldClocks).toEqual(b.meta?.fieldClocks);
    expect(replica.children).toEqual(b.children);
  });

  it("deletes with the clocks (edit wins over delete) and keeps no children for a deleted row", () => {
    const base = created(clock(1, A));
    const edited = categorize(base, clock(30, A), "fincat:logement", "user", []);
    // A delete older than the edit loses.
    const lost = mergeInto(edited, tombstoneEntity(clock(20, B)), []);
    expect(lost.replica.row?.category_id).toBe("fincat:logement");
    expect(lost.outcome.unit.winner).toBe("local");
    // An equal clock keeps the row too (edit wins over delete).
    expect(mergeInto(edited, tombstoneEntity(clock(30, A)), []).replica.row).not.toBeNull();
    // A strictly later delete wins and the unit clocks go with the row.
    const gone = mergeInto(
      { ...edited, children: [split("s1", -1)] },
      tombstoneEntity(clock(40, B)),
      [],
    );
    expect(gone.replica.row).toBeNull();
    expect(gone.replica.children).toEqual([]);
    expect(gone.replica.meta).toMatchObject({ deletedAt: clock(40, B), fieldClocks: {} });
    expect(gone.outcome.unit.winner).toBe("gone");
  });

  it("resurrects with the incoming row's unit when the edit is later than the delete", () => {
    const tombstone: Replica = {
      row: null,
      meta: { fieldClocks: {}, rowHlc: clock(20, A), deletedAt: clock(20, A) },
      children: [],
    };
    const b = categorize(created(clock(1, B)), clock(30, B), "fincat:logement", "user", [
      split("b1", -100),
    ]);
    const { replica, outcome } = mergeInto(tombstone, toEntity(b), b.children);
    expect(replica.row?.category_id).toBe("fincat:logement");
    expect(replica.children).toHaveLength(1);
    expect(outcome.unit.winner).toBe("remote");
    // A delete later than the edit stays deleted and keeps no children.
    const stays = mergeInto(
      { ...tombstone, meta: { fieldClocks: {}, rowHlc: clock(40, A), deletedAt: clock(40, A) } },
      toEntity(b),
      b.children,
    );
    expect(stays.replica.row).toBeNull();
    expect(stays.outcome.unit.winner).toBe("gone");
  });

  it("lets a remote unit replace a local row that was never stamped", () => {
    const unstamped: Replica = {
      row: txnRow({ category_id: "local-only" }),
      meta: null,
      children: [],
    };
    const b = categorize(created(clock(1, B)), clock(10, B), "fincat:logement", "rule");
    const merged = mergeInto(unstamped, toEntity(b), b.children);
    expect(merged.replica.row?.category_id).toBe("fincat:logement");
    expect(merged.replica.meta?.fieldClocks).toEqual(b.meta?.fieldClocks);
  });

  it("derives the unit of a row stamped before the unit existed from its row clock", () => {
    const legacy: Replica = {
      row: txnRow({ category_id: "fincat:logement", category_source: "user" }),
      meta: { fieldClocks: {}, rowHlc: clock(10, A), deletedAt: null },
      children: [],
    };
    const rule = categorize(created(clock(1, B)), clock(5, B), "fincat:transport", "rule");
    // The legacy user row protects itself at its row clock, so the older automatic write loses.
    expect(merge(legacy, rule).row?.category_id).toBe("fincat:logement");
    expect(merge(rule, legacy).row?.category_id).toBe("fincat:logement");
  });

  it("carries the unit columns together (confidence and categorized_at follow the decision)", () => {
    const base = created(clock(1, A));
    const a: Replica = {
      ...categorize(base, clock(10, A), "fincat:logement", "user"),
    };
    a.row = {
      ...(a.row as RawRow),
      category_confidence: null,
      categorized_at: "2026-10-02T00:00:00.000Z",
    };
    const auto = categorize(base, clock(60, B), "fincat:transport", "ai");
    auto.row = {
      ...(auto.row as RawRow),
      category_confidence: 0.9,
      categorized_at: "2026-10-03T00:00:00.000Z",
    };
    const merged = merge(auto, a);
    expect(merged.row?.category_source).toBe("user");
    expect(merged.row?.category_confidence).toBeNull();
    expect(merged.row?.categorized_at).toBe("2026-10-02T00:00:00.000Z");
    for (const column of UNIT_COLUMNS) expect(merged.row).toHaveProperty(column);
  });
});

// ---------------------------------------------------------------------------------------------
// Randomized three-replica convergence of the transaction merge
// ---------------------------------------------------------------------------------------------

const prng = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ]),
      );

const DEVICES = [A, B, C];

/** Three laptops make random categorization, split and edit writes and merge at random moments. */
const simulate = (seed: number, steps: number): Replica[] => {
  const rand = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  let tick = 100;
  const base = created(clock(1, A));
  const replicas: Replica[] = [base, base, base];
  let splitCounter = 0;
  for (let step = 0; step < steps; step += 1) {
    const index = Math.floor(rand() * 3);
    const device = DEVICES[index] as string;
    const replica = replicas[index] as Replica;
    tick += 1 + Math.floor(rand() * 7);
    const at = clock(tick, device);
    const roll = rand();
    if (roll < 0.2) {
      replicas[index] = categorize(replica, at, pick(["c1", "c2", "c3"]), "user");
    } else if (roll < 0.4) {
      replicas[index] = categorize(
        replica,
        at,
        pick(["c1", "c2", "c3"]),
        pick(["rule", "memory", "seed", "ai"]),
      );
    } else if (roll < 0.55) {
      splitCounter += 1;
      replicas[index] = categorize(replica, at, "fincat:split", "user", [
        split(`s${splitCounter}a`, -10),
        split(`s${splitCounter}b`, -20),
      ]);
    } else if (roll < 0.65) {
      // Remove the last split: the parent resets to uncategorized / default.
      replicas[index] = categorize(replica, at, "fincat:non-categorise", "default", []);
    } else if (roll < 0.8) {
      replicas[index] = editDescription(replica, at, `desc ${tick}`);
    } else {
      const other = (index + 1 + Math.floor(rand() * 2)) % 3;
      replicas[index] = merge(replica, replicas[other] as Replica);
    }
  }
  return replicas;
};

describe("the transaction merge is a join (randomized, three replicas)", () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    it(`seed ${seed}: any order, grouping and repetition gives one state`, () => {
      const [x, y, z] = simulate(seed, 40) as [Replica, Replica, Replica];
      const results = new Set<string>();
      for (const order of permutations([x, y, z])) {
        results.add(stateKey(order.reduce((acc, next) => merge(acc, next), EMPTY)));
        // Repeats and re-merging a partial result change nothing.
        results.add(stateKey([...order, ...order].reduce((acc, next) => merge(acc, next), EMPTY)));
      }
      // Associativity: (x v y) v z == x v (y v z) for every labeling.
      for (const [p, q, r] of permutations([x, y, z]) as [Replica, Replica, Replica][]) {
        results.add(stateKey(merge(merge(p, q), r)));
        results.add(stateKey(merge(p, merge(q, r))));
      }
      expect(results.size).toBe(1);
      // Commutative and idempotent on pairs.
      expect(stateKey(merge(x, y))).toBe(stateKey(merge(y, x)));
      expect(stateKey(merge(x, x))).toBe(stateKey(x));
    });
  }

  it("converges by exchange across a tombstone, as every row-clock merge does", () => {
    const base = created(clock(1, A));
    const a = categorize(base, clock(10, A), "c1", "user", []);
    const b = categorize(base, clock(12, B), "c2", "user", []);
    const tomb: Replica = {
      row: null,
      meta: { fieldClocks: {}, rowHlc: clock(11, C), deletedAt: clock(11, C) },
      children: [],
    };
    // Different arrival orders may differ in one pass; after a full exchange they agree.
    const settle = (first: Replica, second: Replica, third: Replica): string => {
      const passes = [first, second, third];
      let states: Replica[] = passes;
      for (let round = 0; round < 3; round += 1) {
        states = states.map((state) =>
          states.reduce(
            (acc, other) =>
              other.row === null
                ? mergeInto(acc, tombstoneEntity(other.meta?.deletedAt as string), []).replica
                : merge(acc, other),
            state,
          ),
        );
      }
      return stateKey(states[0] as Replica);
    };
    const outcomes = new Set(
      permutations([a, b, tomb]).map(([p, q, r]) =>
        settle(p as Replica, q as Replica, r as Replica),
      ),
    );
    expect(outcomes.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Suggestions, snapshots
// ---------------------------------------------------------------------------------------------

describe("category suggestion rules", () => {
  const columns = ["id", "transaction_id", "status", "suggested_category_id", "decided_at"];
  const suggestion = (status: string, overrides: Record<string, unknown> = {}): RawRow => ({
    id: "s1",
    transaction_id: "t1",
    status,
    suggested_category_id: "fincat:x",
    decided_at: status === "pending" ? null : "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
  const entity = (row: RawRow, at: string): SyncEntity => ({
    table: "finance_category_suggestions",
    entityId: String(row.id),
    row,
    fieldClocks: {},
    rowHlc: at,
    deletedAt: null,
  });
  const run = (local: RawRow, localAt: string, remote: RawRow, remoteAt: string) =>
    mergeRowEntity({
      columns,
      local: { row: local, meta: { fieldClocks: {}, rowHlc: localAt, deletedAt: null } },
      remote: entity(remote, remoteAt),
      rules: SUGGESTION_RULES,
    });

  it("a decided suggestion beats a pending one whatever the clocks, in both directions", () => {
    const decided = suggestion("accepted");
    const pending = suggestion("pending", { suggested_category_id: "fincat:y" });
    const forward = run(pending, clock(99), decided, clock(1));
    expect(forward.finalRow?.status).toBe("accepted");
    expect(forward.finalRow?.decided_at).toBe("2026-10-01T00:00:00.000Z");
    const backward = run(decided, clock(1), pending, clock(99));
    expect(backward.finalRow?.status).toBe("accepted");
    expect(backward.rowAction).toBe("none");
  });

  it("keeps the smaller status of two different decisions and raises a divergence", () => {
    const accepted = suggestion("accepted");
    const dismissed = suggestion("dismissed");
    const result = run(dismissed, clock(50), accepted, clock(1));
    expect(result.finalRow?.status).toBe("accepted");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: "terminal_divergence",
      entityType: "finance_category_suggestions",
      entityId: "s1",
    });
    expect(run(accepted, clock(1), dismissed, clock(50)).finalRow?.status).toBe("accepted");
    expect(run(accepted, clock(1), dismissed, clock(50)).conflicts[0]?.id).toBe(
      result.conflicts[0]?.id,
    );
    expect(run(suggestion("corrected"), clock(1), dismissed, clock(2)).finalRow?.status).toBe(
      "corrected",
    );
  });

  it("is silent when one side is an engine expiry: a decision just wins", () => {
    const result = run(suggestion("expired"), clock(50), suggestion("dismissed"), clock(1));
    expect(result.finalRow?.status).toBe("dismissed");
    expect(result.conflicts).toEqual([]);
  });

  it("two pending rows follow the later clock; the same decision twice follows the clock too", () => {
    const early = suggestion("pending", { suggested_category_id: "fincat:early" });
    const late = suggestion("pending", { suggested_category_id: "fincat:late" });
    expect(run(early, clock(1), late, clock(2)).finalRow?.suggested_category_id).toBe(
      "fincat:late",
    );
    expect(run(late, clock(2), early, clock(1)).finalRow?.suggested_category_id).toBe(
      "fincat:late",
    );
  });

  it("a decided suggestion survives a tombstone whatever the clocks; a pending one follows them", () => {
    const tomb: SyncEntity = {
      table: "finance_category_suggestions",
      entityId: "s1",
      row: null,
      fieldClocks: {},
      rowHlc: clock(99),
      deletedAt: clock(99),
    };
    const decided = mergeRowEntity({
      columns,
      local: {
        row: suggestion("dismissed"),
        meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
      },
      remote: tomb,
      rules: SUGGESTION_RULES,
    });
    expect(decided.finalRow?.status).toBe("dismissed");
    const pending = mergeRowEntity({
      columns,
      local: {
        row: suggestion("pending"),
        meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
      },
      remote: tomb,
      rules: SUGGESTION_RULES,
    });
    expect(pending.finalRow).toBeNull();
    // And a decided row arriving at a replica that already deleted the suggestion comes back.
    const resurrected = mergeRowEntity({
      columns,
      local: { row: null, meta: { fieldClocks: {}, rowHlc: clock(99), deletedAt: clock(99) } },
      remote: entity(suggestion("accepted"), clock(1)),
      rules: SUGGESTION_RULES,
    });
    expect(resurrected.finalRow?.status).toBe("accepted");
  });
});

describe("statement snapshot rules", () => {
  const columns = ["account_id", "as_of_date", "balance_minor", "source"];
  const row = (source: string, balance = 100): RawRow => ({
    account_id: "acc",
    as_of_date: "2026-09-30",
    balance_minor: balance,
    source,
  });
  const incoming = (source: string, at: string, balance = 100): SyncEntity => ({
    table: "finance_account_balance_snapshots",
    entityId: '["acc","2026-09-30"]',
    row: row(source, balance),
    fieldClocks: {},
    rowHlc: at,
    deletedAt: null,
  });

  it("a statement row beats a derived one at the same key whatever the clocks", () => {
    const merged = mergeRowEntity({
      columns,
      local: {
        row: row("derived", 5),
        meta: { fieldClocks: {}, rowHlc: clock(99), deletedAt: null },
      },
      remote: incoming("statement", clock(1), 100),
      rules: SNAPSHOT_RULES,
    });
    expect(merged.finalRow).toMatchObject({ source: "statement", balance_minor: 100 });
  });

  it("two statement rows at one key follow the later clock and log the loser", () => {
    const merged = mergeRowEntity({
      columns,
      local: {
        row: row("statement", 100),
        meta: { fieldClocks: {}, rowHlc: clock(1), deletedAt: null },
      },
      remote: incoming("statement", clock(2), 250),
      rules: SNAPSHOT_RULES,
    });
    expect(merged.finalRow?.balance_minor).toBe(250);
    expect(merged.overwritten).toHaveLength(1);
  });

  it("orders anchors of one account by clock, then by date, and a missing clock is lowest", () => {
    const d1 = { clock: clock(1), asOfDate: "2026-08-31" };
    const d2 = { clock: clock(2), asOfDate: "2026-09-30" };
    expect(compareAnchors(d2, d1)).toBeGreaterThan(0);
    expect(compareAnchors(d1, d2)).toBeLessThan(0);
    expect(compareAnchors({ clock: clock(2), asOfDate: "2026-10-31" }, d2)).toBeGreaterThan(0);
    expect(compareAnchors({ clock: null, asOfDate: "2027-01-31" }, d1)).toBeLessThan(0);
    expect(compareAnchors(d1, { ...d1 })).toBe(0);
  });
});
