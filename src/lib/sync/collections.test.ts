import { describe, expect, it } from "vitest";
import { type RootMove, AliasIndex } from "./aliases";
import { groupByType } from "./apply-aliases";
import { appendTo, longestList, without } from "./collections";
import { encodeHlc } from "./hlc";

/**
 * Scale guards for the alias path. A first merge moves tens of thousands of ids, so the helpers it
 * relies on must be linear. Each test uses a size at which a quadratic version (copying the
 * accumulator per element, or searching an array per element) takes many seconds, with a bound
 * of two orders of magnitude over the linear time so a loaded machine cannot fail it.
 */

const BIG = 150_000;
const BOUND_MS = 3_000;

const timed = (work: () => void): number => {
  const start = performance.now();
  work();
  return performance.now() - start;
};

describe("linear helpers", () => {
  it("appendTo accumulates a large list in place", () => {
    const map = new Map<string, number[]>();
    const elapsed = timed(() => {
      for (let i = 0; i < BIG; i += 1) appendTo(map, "k", i);
    });
    expect(map.get("k")).toHaveLength(BIG);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  it("appendTo keeps the order and separate keys", () => {
    const map = new Map<string, number[]>();
    appendTo(map, "a", 1);
    appendTo(map, "b", 2);
    appendTo(map, "a", 3);
    expect([...map]).toEqual([
      ["a", [1, 3]],
      ["b", [2]],
    ]);
  });

  it("without filters against a set", () => {
    const items = Array.from({ length: BIG }, (_, i) => `id-${i}`);
    const excluded = new Set(items.filter((_, i) => i % 2 === 0));
    let kept: string[] = [];
    const elapsed = timed(() => {
      kept = without(items, excluded);
    });
    expect(kept).toHaveLength(BIG / 2);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  it("longestList does not spread a large argument list", () => {
    const lists = Array.from({ length: BIG }, (_, i) => (i === 7 ? [1, 2, 3] : [1]));
    expect(longestList(lists)).toBe(3);
    expect(longestList([])).toBe(0);
  });
});

describe("the alias path at scale", () => {
  const clock = encodeHlc(1, 0, "dev:00000000-0000-4000-8000-000000000001");

  it("groups a large number of moves by type in linear time", () => {
    const moves: RootMove[] = Array.from({ length: BIG }, (_, i) => ({
      entityType: i % 2 === 0 ? "finance_transactions" : "gtd_tasks",
      id: `id-${i}`,
      from: `id-${i}`,
      to: "root",
    }));
    let grouped: [string, RootMove[]][] = [];
    const elapsed = timed(() => {
      grouped = groupByType(moves);
    });
    expect(grouped.map(([type, list]) => [type, list.length])).toEqual([
      ["gtd_tasks", BIG / 2],
      ["finance_transactions", BIG / 2],
    ]);
    expect(elapsed).toBeLessThan(BOUND_MS);
  });

  it("learns and lists a large number of aliases in linear time", () => {
    const index = new AliasIndex();
    const elapsed = timed(() => {
      for (let i = 0; i < BIG; i += 1) index.learn("gtd_tasks", `b-${i}`, `a-${i}`, clock);
      expect(index.records()).toHaveLength(BIG);
      expect(new AliasIndex(index.records()).records()).toHaveLength(BIG);
    });
    expect(elapsed).toBeLessThan(BOUND_MS * 2);
  });
});
