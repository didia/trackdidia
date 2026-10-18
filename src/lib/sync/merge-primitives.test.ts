import { describe, expect, it } from "vitest";
import { setOwn } from "./field-clocks";
import { encodeHlc } from "./hlc";
import {
  type MapEntry,
  type MaybeClock,
  mergeJsonMapPerKey,
  mergeLww,
  mergeMonotonicMax,
  mergeNonEmptyWins,
  mergeOrSet,
  mergeTerminalBeatsPending,
  mergeTombstone,
  type StatusMergeResult,
  type OrSetElement,
  type OrSetElements,
} from "./merge-primitives";

const ITERATIONS = 400;

/** Deterministic seeded PRNG (mulberry32); no external property-testing dependency. */
const makeRng = (seed: number) => {
  let a = seed;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number): number => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number): boolean => next() < p,
  };
};
type Rng = ReturnType<typeof makeRng>;

const DEVICES = ["dev:a", "dev:b", "dev:c"] as const;
const BASE = 1_700_000_000_000;
const clock = (ms: number, counter = 0, device = "dev:a"): string =>
  encodeHlc(BASE + ms, counter, device);

/** Small clock domain so collisions (including exact ties) happen constantly. */
const randomClock = (rng: Rng): string => clock(rng.int(4), rng.int(2), rng.pick(DEVICES));
const randomMaybeClock = (rng: Rng): MaybeClock =>
  rng.chance(0.15) ? null : rng.chance(0.05) ? undefined : randomClock(rng);

const forEachCase = (seed: number, body: (rng: Rng, index: number) => void): void => {
  const rng = makeRng(seed);
  for (let i = 0; i < ITERATIONS; i += 1) {
    body(rng, i);
  }
};

describe("mergeLww", () => {
  it("takes the later clock", () => {
    const merged = mergeLww("local", clock(1), "remote", clock(2));
    expect(merged).toEqual({
      value: "remote",
      clock: clock(2),
      winner: "remote",
      overwritten: { value: "local", clock: clock(1) },
    });
    expect(mergeLww("local", clock(3), "remote", clock(2))).toEqual({
      value: "local",
      clock: clock(3),
      winner: "local",
      overwritten: { value: "remote", clock: clock(2) },
    });
  });

  it("uses the device id to order otherwise identical physical/counter pairs", () => {
    const merged = mergeLww("a", clock(1, 0, "dev:a"), "b", clock(1, 0, "dev:b"));
    expect(merged.value).toBe("b");
    expect(merged.winner).toBe("remote");
  });

  it("is a no-op for equal clocks and equal values", () => {
    expect(mergeLww({ a: 1, b: 2 }, clock(1), { b: 2, a: 1 }, clock(1))).toEqual({
      value: { a: 1, b: 2 },
      clock: clock(1),
      winner: "equal",
      overwritten: null,
    });
  });

  it("reports no overwrite when a later clock carries the same value", () => {
    const merged = mergeLww("same", clock(1), "same", clock(2));
    expect(merged.winner).toBe("remote");
    expect(merged.clock).toBe(clock(2));
    expect(merged.overwritten).toBeNull();
  });

  it("treats a missing clock as older than any clock", () => {
    expect(mergeLww("never stamped", null, "stamped", clock(0)).value).toBe("stamped");
    expect(mergeLww("stamped", clock(0), "never stamped", undefined).value).toBe("stamped");
    expect(mergeLww("x", null, "x", undefined).winner).toBe("equal");
  });

  it("resolves equal clocks with different values deterministically and reports the loser", () => {
    const ab = mergeLww("alpha", clock(1), "beta", clock(1));
    const ba = mergeLww("beta", clock(1), "alpha", clock(1));
    expect(ab.value).toBe("alpha");
    expect(ba.value).toBe("alpha");
    expect(ab.overwritten).toEqual({ value: "beta", clock: clock(1) });
    expect(ba.overwritten).toEqual({ value: "beta", clock: clock(1) });
  });

  it("treats undefined and null as the same value, whichever side holds which", () => {
    const c = clock(1);
    const undefinedLocal = mergeLww<unknown>(undefined, c, null, c);
    const nullLocal = mergeLww<unknown>(null, c, undefined, c);
    for (const merged of [undefinedLocal, nullLocal]) {
      expect(merged.winner).toBe("equal");
      expect(merged.overwritten).toBeNull();
      expect(merged.clock).toBe(c);
    }
    // One deterministic representation, independent of argument order.
    expect(undefinedLocal.value).toBeNull();
    expect(nullLocal.value).toBeNull();
    expect(mergeLww<unknown>([undefined], c, [null], c).value).toEqual([null]);
    expect(mergeLww<unknown>([null], c, [undefined], c).value).toEqual([null]);
  });

  it("reports no overwrite for undefined versus null at different clocks", () => {
    const olderUndefined = mergeLww<unknown>(undefined, clock(1), null, clock(2));
    expect(olderUndefined).toMatchObject({ winner: "remote", clock: clock(2), overwritten: null });
    const newerUndefined = mergeLww<unknown>(null, clock(1), undefined, clock(2));
    expect(newerUndefined).toMatchObject({ winner: "remote", clock: clock(2), overwritten: null });
    expect(mergeLww<unknown>([null], clock(3), [undefined], clock(2)).overwritten).toBeNull();
  });

  it("supports null as a real value", () => {
    const merged = mergeLww<string | null>("deadline", clock(1), null, clock(2));
    expect(merged.value).toBeNull();
    expect(merged.overwritten).toEqual({ value: "deadline", clock: clock(1) });
  });

  const randomValue = (rng: Rng): unknown =>
    rng.pick<unknown>([
      "x",
      "y",
      1,
      null,
      undefined,
      [null],
      [undefined],
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: null },
      { a: undefined },
      [1, 2],
      [2, 1],
    ]);

  it("is commutative, idempotent and associative", () => {
    forEachCase(11, (rng) => {
      const a = { v: randomValue(rng), c: randomMaybeClock(rng) };
      const b = { v: randomValue(rng), c: randomMaybeClock(rng) };
      const c = { v: randomValue(rng), c: randomMaybeClock(rng) };

      const ab = mergeLww(a.v, a.c, b.v, b.c);
      const ba = mergeLww(b.v, b.c, a.v, a.c);
      expect(ab.value).toEqual(ba.value);
      expect(ab.clock).toEqual(ba.clock);
      expect(ab.overwritten).toEqual(ba.overwritten);
      expect(ab.winner === "equal").toBe(ba.winner === "equal");
      if (ab.winner !== "equal") {
        expect(ab.winner).toBe(ba.winner === "local" ? "remote" : "local");
      }

      const aa = mergeLww(a.v, a.c, a.v, a.c);
      expect(aa).toEqual({ value: a.v, clock: a.c ?? null, winner: "equal", overwritten: null });

      const left = mergeLww(ab.value, ab.clock, c.v, c.c);
      const bc = mergeLww(b.v, b.c, c.v, c.c);
      const right = mergeLww(a.v, a.c, bc.value, bc.clock);
      expect(left.value).toEqual(right.value);
      expect(left.clock).toEqual(right.clock);
    });
  });
});

describe("mergeOrSet", () => {
  it("keeps concurrent adds of different elements", () => {
    const local: OrSetElements = { errands: { addedAt: clock(2) } };
    const remote: OrSetElements = { calls: { addedAt: clock(2, 0, "dev:b") } };
    const merged = mergeOrSet(local, remote);
    expect(merged.ids).toEqual(["calls", "errands"]);
    expect(merged.elements).toEqual({
      errands: { addedAt: clock(2) },
      calls: { addedAt: clock(2, 0, "dev:b") },
    });
  });

  it("lets a later remove beat an earlier add, and a later re-add beat the remove", () => {
    const added: OrSetElements = { x: { addedAt: clock(1) } };
    const removed: OrSetElements = { x: { addedAt: clock(1), removedAt: clock(2) } };
    expect(mergeOrSet(added, removed).ids).toEqual([]);
    const readded: OrSetElements = { x: { addedAt: clock(3), removedAt: clock(2) } };
    expect(mergeOrSet(removed, readded).ids).toEqual(["x"]);
    expect(mergeOrSet(added, readded).ids).toEqual(["x"]);
  });

  it("keeps an add concurrent with (later than the base of) a remove it did not see", () => {
    // Local removed at t2; remote re-added at t3 without having seen the removal.
    const merged = mergeOrSet({ x: { removedAt: clock(2) } }, { x: { addedAt: clock(3) } });
    expect(merged.ids).toEqual(["x"]);
    expect(merged.elements.x).toEqual({ addedAt: clock(3), removedAt: clock(2) });
  });

  it("resolves an exact add/remove tie as absent, deterministically", () => {
    const tie: OrSetElements = { x: { addedAt: clock(1), removedAt: clock(1) } };
    expect(mergeOrSet(tie, {}).ids).toEqual([]);
    expect(mergeOrSet({ x: { addedAt: clock(1) } }, { x: { removedAt: clock(1) } }).ids).toEqual(
      [],
    );
    expect(mergeOrSet({ x: { removedAt: clock(1) } }, { x: { addedAt: clock(1) } }).ids).toEqual(
      [],
    );
  });

  it("returns ids sorted and drops elements with no clocks", () => {
    const merged = mergeOrSet(
      { b: { addedAt: clock(1) }, empty: {}, nulls: { addedAt: null, removedAt: null } },
      { a: { addedAt: clock(1) }, c: { addedAt: clock(1) } },
    );
    expect(merged.ids).toEqual(["a", "b", "c"]);
    expect(Object.keys(merged.elements).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its inputs", () => {
    const local: OrSetElements = { x: { addedAt: clock(1) } };
    const remote: OrSetElements = { x: { removedAt: clock(2) } };
    mergeOrSet(local, remote);
    expect(local).toEqual({ x: { addedAt: clock(1) } });
    expect(remote).toEqual({ x: { removedAt: clock(2) } });
  });

  const randomElements = (rng: Rng): OrSetElements => {
    const elements: OrSetElements = {};
    for (const id of ["a", "b", "c", "d"]) {
      if (rng.chance(0.7)) {
        const element: { addedAt?: string; removedAt?: string } = {};
        if (rng.chance(0.7)) {
          element.addedAt = randomClock(rng);
        }
        if (rng.chance(0.5)) {
          element.removedAt = randomClock(rng);
        }
        elements[id] = element;
      }
    }
    return elements;
  };

  it("is commutative, idempotent and associative", () => {
    forEachCase(22, (rng) => {
      const a = randomElements(rng);
      const b = randomElements(rng);
      const c = randomElements(rng);
      expect(mergeOrSet(a, b)).toEqual(mergeOrSet(b, a));
      const aa = mergeOrSet(a, a);
      expect(mergeOrSet(aa.elements, a)).toEqual(aa);
      expect(mergeOrSet(aa.elements, aa.elements)).toEqual(aa);
      expect(mergeOrSet(mergeOrSet(a, b).elements, c)).toEqual(
        mergeOrSet(a, mergeOrSet(b, c).elements),
      );
    });
  });
});

describe("mergeJsonMapPerKey", () => {
  const live = <V>(value: V, c: string | null): MapEntry<V> => ({ value, clock: c });
  const dead = <V>(value: V, c: string | null): MapEntry<V> => ({ value, clock: c, deleted: true });

  it("merges key by key and keeps keys present on one side only", () => {
    const result = mergeJsonMapPerKey<number | string>(
      { mood: live(3, clock(1)), sleep: live(7, clock(5)), only_local: live("l", clock(1)) },
      { mood: live(4, clock(2)), sleep: live(8, clock(3)), only_remote: live("r", clock(1)) },
    );
    expect(result.map).toEqual({
      mood: live(4, clock(2)),
      sleep: live(7, clock(5)),
      only_local: live("l", clock(1)),
      only_remote: live("r", clock(1)),
    });
    expect(result.overwritten).toEqual([
      { key: "mood", kept: live(4, clock(2)), discarded: live(3, clock(1)) },
      { key: "sleep", kept: live(7, clock(5)), discarded: live(8, clock(3)) },
    ]);
  });

  it("lets a later key tombstone beat an older write, and a later write beat the tombstone", () => {
    const older = { k: live("v", clock(1)) };
    const tombstone = { k: dead("v", clock(2)) };
    const rewritten = { k: live("w", clock(3)) };
    const removal = mergeJsonMapPerKey(older, tombstone);
    expect(removal.map.k).toEqual(dead("v", clock(2)));
    expect(removal.overwritten).toHaveLength(1);
    expect(mergeJsonMapPerKey(tombstone, rewritten).map.k).toEqual(live("w", clock(3)));
    expect(mergeJsonMapPerKey(removal.map, rewritten).map.k).toEqual(live("w", clock(3)));
  });

  it("treats undefined and null values as equal and merges to one representation", () => {
    const c = clock(1);
    for (const [x, y] of [
      [undefined, null],
      [[undefined], [null]],
    ] as const) {
      const xy = mergeJsonMapPerKey<unknown>({ k: live(x, c) }, { k: live(y, c) });
      const yx = mergeJsonMapPerKey<unknown>({ k: live(y, c) }, { k: live(x, c) });
      expect(xy.overwritten).toEqual([]);
      expect(yx.overwritten).toEqual([]);
      expect(xy.map).toEqual(yx.map);
      expect(xy.map.k?.value).toEqual(Array.isArray(x) ? [null] : null);
      // At different clocks the later one wins without reporting an overwrite.
      expect(
        mergeJsonMapPerKey<unknown>({ k: live(x, clock(1)) }, { k: live(y, clock(2)) }).overwritten,
      ).toEqual([]);
    }
  });

  it("does not report a conflict for the same value or for two removals", () => {
    expect(
      mergeJsonMapPerKey(
        { k: live({ a: 1, b: 2 }, clock(1)) },
        { k: live({ b: 2, a: 1 }, clock(2)) },
      ).overwritten,
    ).toEqual([]);
    expect(
      mergeJsonMapPerKey({ k: dead("x", clock(1)) }, { k: dead("y", clock(2)) }).overwritten,
    ).toEqual([]);
  });

  it("normalizes deleted: false away and null clocks lose to stamped ones", () => {
    const merged = mergeJsonMapPerKey(
      { k: { value: 1, clock: null, deleted: false } },
      { k: live(2, clock(0)) },
    );
    expect(merged.map.k).toEqual(live(2, clock(0)));
    expect(
      mergeJsonMapPerKey({ k: { value: 1, clock: clock(1), deleted: false } }, {}).map.k,
    ).toEqual(live(1, clock(1)));
  });

  it("does not mutate its inputs", () => {
    const local = { k: live(1, clock(1)) };
    const remote = { k: live(2, clock(2)) };
    mergeJsonMapPerKey(local, remote);
    expect(local).toEqual({ k: live(1, clock(1)) });
    expect(remote).toEqual({ k: live(2, clock(2)) });
  });

  const randomMap = (rng: Rng): Record<string, MapEntry<unknown>> => {
    const map: Record<string, MapEntry<unknown>> = {};
    for (const key of ["a", "b", "c"]) {
      if (rng.chance(0.75)) {
        const entry: MapEntry<unknown> = {
          value: rng.pick<unknown>([
            1,
            2,
            "x",
            null,
            undefined,
            [null],
            [undefined],
            { p: 1, q: 2 },
            { q: 2, p: 1 },
          ]),
          clock: rng.chance(0.1) ? null : randomClock(rng),
        };
        if (rng.chance(0.35)) {
          entry.deleted = true;
        }
        map[key] = entry;
      }
    }
    return map;
  };

  it("is commutative, idempotent and associative", () => {
    forEachCase(33, (rng) => {
      const a = randomMap(rng);
      const b = randomMap(rng);
      const c = randomMap(rng);
      const ab = mergeJsonMapPerKey(a, b);
      const ba = mergeJsonMapPerKey(b, a);
      expect(ab.map).toEqual(ba.map);
      expect(ab.overwritten).toEqual(ba.overwritten);
      expect(mergeJsonMapPerKey(a, a).map).toEqual(a);
      expect(mergeJsonMapPerKey(a, a).overwritten).toEqual([]);
      expect(mergeJsonMapPerKey(ab.map, c).map).toEqual(
        mergeJsonMapPerKey(a, mergeJsonMapPerKey(b, c).map).map,
      );
    });
  });
});

describe("mergeTombstone", () => {
  it("keeps a row that was never deleted alive", () => {
    expect(mergeTombstone(clock(1), null, clock(2), null)).toEqual({
      deleted: false,
      deletedAt: null,
      rowClock: clock(2),
    });
    expect(mergeTombstone(null, null, null, null)).toEqual({
      deleted: false,
      deletedAt: null,
      rowClock: null,
    });
  });

  it("lets a delete later than every edit win", () => {
    expect(mergeTombstone(clock(1), null, clock(1), clock(5))).toEqual({
      deleted: true,
      deletedAt: clock(5),
      rowClock: clock(1),
    });
  });

  it("lets an edit causally later than the delete resurrect the row", () => {
    const result = mergeTombstone(clock(7), null, clock(1), clock(5));
    expect(result).toEqual({ deleted: false, deletedAt: null, rowClock: clock(7) });
  });

  it("lets a concurrent edit that carries a later clock than the delete win too", () => {
    // The delete (t5) is a different device's event than the edit (t6); the later clock rules.
    expect(mergeTombstone(clock(6, 0, "dev:b"), null, clock(1), clock(5)).deleted).toBe(false);
    expect(mergeTombstone(clock(4, 0, "dev:b"), null, clock(1), clock(5)).deleted).toBe(true);
  });

  it("treats a delete clock equal to the edit clock as not deleted (edit wins)", () => {
    expect(mergeTombstone(clock(5), null, null, clock(5)).deleted).toBe(false);
  });

  it("deletes a row with no recorded edits", () => {
    expect(mergeTombstone(null, clock(2), null, null).deleted).toBe(true);
  });

  it("picks the latest of two tombstones", () => {
    expect(mergeTombstone(clock(1), clock(3), clock(1), clock(4)).deletedAt).toBe(clock(4));
  });

  it("is commutative, idempotent and associative as a state merge", () => {
    type State = { rowClock: MaybeClock; deletedAt: MaybeClock };
    const join = (x: State, y: State): State => {
      const result = mergeTombstone(x.rowClock, x.deletedAt, y.rowClock, y.deletedAt);
      return { rowClock: result.rowClock, deletedAt: result.deletedAt };
    };
    forEachCase(44, (rng) => {
      const gen = (): State => ({
        rowClock: randomMaybeClock(rng),
        deletedAt: rng.chance(0.5) ? null : randomClock(rng),
      });
      const [a, b, c] = [gen(), gen(), gen()] as [State, State, State];
      const ab = mergeTombstone(a.rowClock, a.deletedAt, b.rowClock, b.deletedAt);
      const ba = mergeTombstone(b.rowClock, b.deletedAt, a.rowClock, a.deletedAt);
      expect(ab).toEqual(ba);
      // Idempotent on a normalized (already merged) state.
      const normalized = join(a, { rowClock: null, deletedAt: null });
      expect(join(normalized, normalized)).toEqual(normalized);
      expect(join(join(a, b), c)).toEqual(join(a, join(b, c)));
      // Deleted flag agrees with the definition applied to the three raw states at once.
      const all = mergeTombstone(
        join(a, b).rowClock,
        join(a, b).deletedAt,
        c.rowClock,
        c.deletedAt,
      );
      expect(all.deleted).toBe(join(a, join(b, c)).deletedAt !== null);
    });
  });
});

describe("mergeMonotonicMax", () => {
  it("takes the later date and handles missing values", () => {
    expect(mergeMonotonicMax("2026-10-17", "2026-10-18")).toBe("2026-10-18");
    expect(mergeMonotonicMax("2026-12-01", "2026-02-01")).toBe("2026-12-01");
    expect(mergeMonotonicMax(null, "2026-10-18")).toBe("2026-10-18");
    expect(mergeMonotonicMax("2026-10-18", undefined)).toBe("2026-10-18");
    expect(mergeMonotonicMax("", "2026-10-18")).toBe("2026-10-18");
    expect(mergeMonotonicMax(null, undefined)).toBeNull();
    expect(mergeMonotonicMax("", "")).toBeNull();
  });

  it("is commutative, idempotent and associative", () => {
    const pool = [null, undefined, "", "2026-01-31", "2026-02-01", "2025-12-31", "2026-02-01"];
    forEachCase(55, (rng) => {
      const [a, b, c] = [rng.pick(pool), rng.pick(pool), rng.pick(pool)];
      expect(mergeMonotonicMax(a, b)).toBe(mergeMonotonicMax(b, a));
      const aa = mergeMonotonicMax(a, a);
      expect(mergeMonotonicMax(aa, a)).toBe(aa);
      expect(mergeMonotonicMax(mergeMonotonicMax(a, b), c)).toBe(
        mergeMonotonicMax(a, mergeMonotonicMax(b, c)),
      );
    });
  });
});

describe("mergeNonEmptyWins", () => {
  it("prefers any non-empty value and the smaller one when both are set", () => {
    expect(mergeNonEmptyWins(null, "2026-10-18T10:00:00.000Z")).toBe("2026-10-18T10:00:00.000Z");
    expect(mergeNonEmptyWins("2026-10-18T10:00:00.000Z", "")).toBe("2026-10-18T10:00:00.000Z");
    expect(mergeNonEmptyWins("2026-10-19T10:00:00.000Z", "2026-10-18T10:00:00.000Z")).toBe(
      "2026-10-18T10:00:00.000Z",
    );
    expect(mergeNonEmptyWins(undefined, null)).toBeNull();
    expect(mergeNonEmptyWins("", undefined)).toBeNull();
  });

  it("is commutative, idempotent and associative", () => {
    const pool = [null, undefined, "", "b", "a", "c", "a"];
    forEachCase(66, (rng) => {
      const [a, b, c] = [rng.pick(pool), rng.pick(pool), rng.pick(pool)];
      expect(mergeNonEmptyWins(a, b)).toBe(mergeNonEmptyWins(b, a));
      const aa = mergeNonEmptyWins(a, a);
      expect(mergeNonEmptyWins(aa, a)).toBe(aa);
      expect(mergeNonEmptyWins(mergeNonEmptyWins(a, b), c)).toBe(
        mergeNonEmptyWins(a, mergeNonEmptyWins(b, c)),
      );
    });
  });
});

describe("mergeTerminalBeatsPending", () => {
  const terminal = ["accepted", "dismissed", "expired"] as const;

  it("keeps the conflict flag in every grouping of three replicas (whole-result associativity)", () => {
    const t = ["accepted", "dismissed"] as const;
    const left = mergeTerminalBeatsPending(
      mergeTerminalBeatsPending("pending", "accepted", t),
      "dismissed",
      t,
    );
    const right = mergeTerminalBeatsPending(
      "pending",
      mergeTerminalBeatsPending("accepted", "dismissed", t),
      t,
    );
    const last = mergeTerminalBeatsPending(
      mergeTerminalBeatsPending("accepted", "dismissed", t),
      "pending",
      t,
    );
    for (const result of [left, right, last]) {
      expect(result).toEqual({ status: "accepted", conflict: true });
    }
  });

  it("conflict is true iff two different terminal statuses were merged, for every triple", () => {
    const pool = ["pending", "snoozed", "accepted", "dismissed", "expired"];
    const merge = (x: string | StatusMergeResult, y: string | StatusMergeResult) =>
      mergeTerminalBeatsPending(x, y, terminal);
    for (const a of pool) {
      for (const b of pool) {
        for (const c of pool) {
          const expectedStatus = merge(merge(a, b).status, c).status;
          const terminals = new Set([a, b, c].filter((x) => terminal.includes(x as never)));
          const expected = { status: expectedStatus, conflict: terminals.size > 1 };
          expect(merge(merge(a, b), c)).toEqual(expected);
          expect(merge(a, merge(b, c))).toEqual(expected);
          expect(merge(merge(a, c), b)).toEqual(expected);
          expect(merge(c, merge(b, a))).toEqual(expected);
        }
      }
    }
  });

  it("is idempotent on an accumulator and keeps a carried flag", () => {
    const carried = { status: "accepted", conflict: true };
    expect(mergeTerminalBeatsPending(carried, carried, terminal)).toEqual(carried);
    expect(mergeTerminalBeatsPending(carried, "accepted", terminal)).toEqual(carried);
    expect(mergeTerminalBeatsPending("pending", carried, terminal)).toEqual(carried);
  });

  it("lets a terminal status beat pending from either side", () => {
    expect(mergeTerminalBeatsPending("pending", "accepted", terminal)).toEqual({
      status: "accepted",
      conflict: false,
    });
    expect(mergeTerminalBeatsPending("dismissed", "pending", terminal)).toEqual({
      status: "dismissed",
      conflict: false,
    });
  });

  it("keeps an identical status without a conflict", () => {
    expect(mergeTerminalBeatsPending("pending", "pending", terminal)).toEqual({
      status: "pending",
      conflict: false,
    });
    expect(mergeTerminalBeatsPending("accepted", "accepted", terminal)).toEqual({
      status: "accepted",
      conflict: false,
    });
  });

  it("flags two different terminal statuses and picks deterministically", () => {
    const ab = mergeTerminalBeatsPending("accepted", "dismissed", terminal);
    const ba = mergeTerminalBeatsPending("dismissed", "accepted", terminal);
    expect(ab).toEqual({ status: "accepted", conflict: true });
    expect(ba).toEqual(ab);
  });

  it("picks deterministically between two different non-terminal statuses", () => {
    expect(mergeTerminalBeatsPending("snoozed", "pending", terminal)).toEqual({
      status: "pending",
      conflict: false,
    });
    expect(mergeTerminalBeatsPending("pending", "snoozed", terminal)).toEqual({
      status: "pending",
      conflict: false,
    });
  });

  it("is commutative, idempotent and associative", () => {
    const pool = ["pending", "snoozed", "accepted", "dismissed", "expired"];
    forEachCase(77, (rng) => {
      const [a, b, c] = [rng.pick(pool), rng.pick(pool), rng.pick(pool)];
      expect(mergeTerminalBeatsPending(a, b, terminal)).toEqual(
        mergeTerminalBeatsPending(b, a, terminal),
      );
      expect(mergeTerminalBeatsPending(a, a, terminal)).toEqual({ status: a, conflict: false });
      const left = mergeTerminalBeatsPending(
        mergeTerminalBeatsPending(a, b, terminal),
        c,
        terminal,
      );
      const right = mergeTerminalBeatsPending(
        a,
        mergeTerminalBeatsPending(b, c, terminal),
        terminal,
      );
      expect(left).toEqual(right);
    });
  });
});

describe("own-property safety and clock validation in merges", () => {
  const live = <V>(value: V, c: string | null): MapEntry<V> => ({ value, clock: c });

  it("mergeJsonMapPerKey keeps a __proto__ key and ignores inherited names", () => {
    const local = setOwn({} as Record<string, MapEntry<number>>, "__proto__", live(1, clock(1)));
    const remote = setOwn({} as Record<string, MapEntry<number>>, "__proto__", live(2, clock(2)));
    const merged = mergeJsonMapPerKey(local, remote);
    expect(Object.keys(merged.map)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(merged.map, "__proto__")?.value).toEqual(
      live(2, clock(2)),
    );
    expect(merged.overwritten).toHaveLength(1);
    // Only on one side: still kept as an own key.
    const oneSided = mergeJsonMapPerKey(local, {});
    expect(Object.keys(oneSided.map)).toEqual(["__proto__"]);
    // An absent key named like an Object.prototype member is absent, not "present".
    const named = mergeJsonMapPerKey<number>(
      { constructor: live(1, clock(1)) },
      { toString: live(2, clock(1)) },
    );
    expect(Object.keys(named.map).sort()).toEqual(["constructor", "toString"]);
    expect(named.overwritten).toEqual([]);
  });

  it("mergeOrSet keeps a __proto__ element and ignores inherited names", () => {
    const local = setOwn<OrSetElement>({}, "__proto__", { addedAt: clock(1) });
    const remote: OrSetElements = { constructor: { addedAt: clock(1) } };
    const merged = mergeOrSet(local, remote);
    expect(merged.ids).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(merged.elements).sort()).toEqual(["__proto__", "constructor"]);
    expect(mergeOrSet(local, {}).ids).toEqual(["__proto__"]);
  });

  const real = clock(1);
  const bad = "zzzz";

  it("every primitive propagates hlc_malformed instead of ordering a corrupt clock", () => {
    expect(() => mergeLww("a", real, "b", bad)).toThrow("hlc_malformed");
    expect(() => mergeLww("a", bad, "b", null)).toThrow("hlc_malformed");
    expect(() => mergeLww("a", null, "b", "9-000000-d")).toThrow("hlc_malformed");
    expect(() => mergeOrSet({ x: { addedAt: bad } }, {})).toThrow("hlc_malformed");
    expect(() => mergeOrSet({ x: { addedAt: real } }, { x: { removedAt: bad } })).toThrow(
      "hlc_malformed",
    );
    expect(() => mergeJsonMapPerKey({ k: live(1, real) }, { k: live(2, bad) })).toThrow(
      "hlc_malformed",
    );
    expect(() => mergeJsonMapPerKey({ k: live(1, bad) }, {})).toThrow("hlc_malformed");
    expect(() => mergeTombstone(real, null, bad, null)).toThrow("hlc_malformed");
    expect(() => mergeTombstone(real, bad, null, null)).toThrow("hlc_malformed");
  });
});
