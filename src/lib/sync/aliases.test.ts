import { describe, expect, it } from "vitest";
import { type AliasRecord, AliasIndex, compareIds } from "./aliases";
import { encodeHlc } from "./hlc";

const T = "gtd_tasks";
const clock = (n: number): string => encodeHlc(n, 0, "dev:00000000-0000-4000-8000-000000000001");

const classesOf = (index: AliasIndex): string =>
  JSON.stringify(index.records().map(({ recordedHlc: _clock, ...rest }) => rest));

const shuffled = <X>(items: X[], seed: number): X[] => {
  let state = seed >>> 0 || 1;
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    [copy[i], copy[j]] = [copy[j] as X, copy[i] as X];
  }
  return copy;
};

describe("AliasIndex: the class root is the smallest id", () => {
  it("makes the smaller id canonical whichever side learns first", () => {
    for (const [x, y] of [
      ["task-a", "task-b"],
      ["task-b", "task-a"],
    ] as const) {
      const index = new AliasIndex();
      index.learn(T, x, y, clock(1));
      expect(index.resolve(T, "task-b")).toBe("task-a");
      expect(index.resolve(T, "task-a")).toBe("task-a");
      expect(index.records()).toEqual([
        { entityType: T, aliasId: "task-b", canonicalId: "task-a", recordedHlc: clock(1) },
      ]);
    }
  });

  it("uses plain code-unit order, not locale order", () => {
    const index = new AliasIndex();
    index.learn(T, "Z", "a", clock(1));
    expect(index.resolve(T, "a")).toBe("Z");
    expect(compareIds("Z", "a")).toBeLessThan(0);
  });

  it("chains collapse to the root: B -> A then C -> B gives C -> A", () => {
    const index = new AliasIndex();
    expect(index.learn(T, "B", "A", clock(1))).toEqual([
      { entityType: T, id: "B", from: "B", to: "A" },
    ]);
    expect(index.learn(T, "C", "B", clock(2))).toEqual([
      { entityType: T, id: "C", from: "C", to: "A" },
    ]);
    expect(index.resolve(T, "C")).toBe("A");
    expect(index.records().map((r) => [r.aliasId, r.canonicalId])).toEqual([
      ["B", "A"],
      ["C", "A"],
    ]);
  });

  it("moves a whole class when a smaller root appears: A learns about C -> B after B -> C", () => {
    const index = new AliasIndex();
    index.learn(T, "C", "B", clock(1)); // root B
    const moves = index.learn(T, "B", "A", clock(2));
    expect(moves.map((move) => [move.id, move.from, move.to])).toEqual([
      ["B", "B", "A"],
      ["C", "B", "A"],
    ]);
    expect(index.resolve(T, "C")).toBe("A");
    expect(index.aliasesOf(T, "A")).toEqual(["B", "C"]);
    expect(index.aliasesOf(T, "B")).toEqual([]);
  });

  it("is idempotent: learning a pair twice moves nothing", () => {
    const index = new AliasIndex();
    index.learn(T, "B", "A", clock(1));
    expect(index.learn(T, "B", "A", clock(1))).toEqual([]);
    expect(index.learn(T, "A", "B", clock(1))).toEqual([]);
    expect(index.records()).toHaveLength(1);
  });

  it("rejects an id that is its own alias", () => {
    expect(() => new AliasIndex().learn(T, "A", "A", clock(1))).toThrow(/own alias/);
  });

  it("keeps entity types apart", () => {
    const index = new AliasIndex();
    index.learn("gtd_tasks", "B", "A", clock(1));
    expect(index.resolve("gtd_projects", "B")).toBe("B");
    expect(index.hasAliases("gtd_projects")).toBe(false);
    expect(index.hasAliases("gtd_tasks")).toBe(true);
  });

  it("gives every member the largest clock recorded for its class", () => {
    const index = new AliasIndex();
    index.learn(T, "B", "A", clock(5));
    index.learn(T, "C", "D", clock(9));
    index.learn(T, "D", "A", clock(2));
    for (const record of index.records()) expect(record.recordedHlc).toBe(clock(9));
    // A later learn inside the class can still raise it, never lower it.
    index.learn(T, "C", "A", clock(1));
    for (const record of index.records()) expect(record.recordedHlc).toBe(clock(9));
    index.learn(T, "C", "A", clock(12));
    for (const record of index.records()) expect(record.recordedHlc).toBe(clock(12));
  });

  it("round-trips through its stored rows", () => {
    const index = new AliasIndex();
    index.learn(T, "B", "A", clock(1));
    index.learn(T, "C", "B", clock(2));
    index.learn("finance_accounts", "acc-2", "acc-1", clock(3));
    const again = new AliasIndex(index.records());
    expect(again.records()).toEqual(index.records());
  });

  it("accepts stored rows that were never compressed (a chain) and compresses them", () => {
    const stored: AliasRecord[] = [
      { entityType: T, aliasId: "C", canonicalId: "B", recordedHlc: clock(1) },
      { entityType: T, aliasId: "B", canonicalId: "A", recordedHlc: clock(1) },
    ];
    const index = new AliasIndex(stored);
    expect(index.resolve(T, "C")).toBe("A");
    expect(index.records().map((r) => [r.aliasId, r.canonicalId])).toEqual([
      ["B", "A"],
      ["C", "A"],
    ]);
  });
});

describe("AliasIndex: order independence", () => {
  const pairs: [string, string][] = [];
  for (let i = 0; i < 40; i += 1) {
    pairs.push([`id-${(i * 7) % 23}`, `id-${(i * 11 + 3) % 23}`]);
  }
  const usable = pairs.filter(([a, b]) => a !== b);

  it("reaches the same classes and rows in any order of learning", () => {
    const build = (order: [string, string][]): AliasIndex => {
      const index = new AliasIndex();
      for (const [position, [a, b]] of order.entries()) index.learn(T, a, b, clock(position + 1));
      return index;
    };
    const reference = classesOf(build(usable));
    for (let seed = 1; seed <= 25; seed += 1) {
      expect(classesOf(build(shuffled(usable, seed)))).toBe(reference);
    }
  });

  it("gives every class the smallest of its members as root", () => {
    const index = new AliasIndex();
    for (const [position, [a, b]] of usable.entries()) index.learn(T, a, b, clock(position + 1));
    for (const record of index.records()) {
      expect(compareIds(record.canonicalId, record.aliasId)).toBeLessThan(0);
      expect(index.resolve(T, record.canonicalId)).toBe(record.canonicalId);
    }
  });

  it("merging two indexes by their stored rows equals learning everything in one", () => {
    const first = new AliasIndex();
    const second = new AliasIndex();
    for (const [position, [a, b]] of usable.entries()) {
      (position % 2 === 0 ? first : second).learn(T, a, b, clock(position + 1));
    }
    const merged = new AliasIndex([...first.records(), ...second.records()]);
    const whole = new AliasIndex();
    for (const [position, [a, b]] of usable.entries()) whole.learn(T, a, b, clock(position + 1));
    expect(classesOf(merged)).toBe(classesOf(whole));
    expect(merged.records()).toEqual(whole.records());
  });
});
