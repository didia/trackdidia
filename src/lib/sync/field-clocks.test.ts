import { describe, expect, it } from "vitest";
import {
  buildFieldClockUpdates,
  canonicalJson,
  type FieldClocks,
  FieldClockShapeError,
  fieldClockKey,
  getOwn,
  jsonDeepEqual,
  jsonNormalize,
  mergeFieldClocks,
  rowHlc,
  setOwn,
  splitFieldClockKey,
} from "./field-clocks";
import { encodeHlc } from "./hlc";

const DEVICE = "dev:test";
const at = (ms: number, counter = 0): string => encodeHlc(1_700_000_000_000 + ms, counter, DEVICE);

const taskSpec = {
  scalars: ["title", "notes", "deadline"],
  maps: ["metrics"],
  sets: ["contextIds"],
};

const baseTask = {
  title: "Write spec",
  notes: null,
  deadline: "2026-10-20",
  metrics: { mood: 3, sleep: 7 },
  contextIds: ["context:home", "context:calls"],
};

describe("jsonDeepEqual / canonicalJson", () => {
  it("ignores object key order and undefined properties but not array order", () => {
    expect(jsonDeepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonDeepEqual({ a: null }, {})).toBe(false);
    expect(jsonDeepEqual(null, undefined)).toBe(true);
    expect(jsonDeepEqual([undefined], [null])).toBe(true);
    expect(jsonDeepEqual({ a: null, c: 1 }, { a: undefined, c: 1, d: 2 })).toBe(false);
    expect(jsonDeepEqual(undefined, 0)).toBe(false);
    expect(jsonDeepEqual([], {})).toBe(false);
  });

  it("canonicalizes key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }),
    );
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("clock key helpers", () => {
  it("joins and splits on the first dot only", () => {
    expect(fieldClockKey("metrics", "a.b")).toBe("metrics.a.b");
    expect(splitFieldClockKey("metrics.a.b")).toEqual({ field: "metrics", key: "a.b" });
    expect(splitFieldClockKey("title")).toEqual({ field: "title", key: null });
  });
});

describe("buildFieldClockUpdates", () => {
  it("stamps every field on creation (null previous)", () => {
    const clocks = buildFieldClockUpdates(null, baseTask, at(1), taskSpec);
    expect(clocks).toEqual({
      title: at(1),
      notes: at(1),
      deadline: at(1),
      "metrics.mood": at(1),
      "metrics.sleep": at(1),
      "contextIds.context:home": at(1),
      "contextIds.context:calls": at(1),
    });
  });

  it("stamps only the scalar that changed", () => {
    const initial = buildFieldClockUpdates(null, baseTask, at(1), taskSpec);
    const next = { ...baseTask, title: "Write the spec" };
    const clocks = buildFieldClockUpdates(baseTask, next, at(2), { ...taskSpec, clocks: initial });
    expect(clocks).toEqual({ ...initial, title: at(2) });
    expect(initial.title).toBe(at(1)); // input untouched
  });

  it("returns the very same clocks object when nothing changed", () => {
    const initial = buildFieldClockUpdates(null, baseTask, at(1), taskSpec);
    const reordered = {
      contextIds: ["context:calls", "context:home"],
      metrics: { sleep: 7, mood: 3 },
      deadline: "2026-10-20",
      notes: undefined, // undefined == null
      title: "Write spec",
      updatedAt: "ignored: not in the spec",
    };
    const clocks = buildFieldClockUpdates(baseTask, reordered, at(2), {
      ...taskSpec,
      clocks: initial,
    });
    expect(clocks).toBe(initial);
    expect(buildFieldClockUpdates(baseTask, baseTask, at(2), taskSpec)).toEqual({});
  });

  it("ignores fields that are not in the spec", () => {
    const clocks = buildFieldClockUpdates(
      { ...baseTask, updatedAt: "a" },
      { ...baseTask, updatedAt: "b" },
      at(2),
      { ...taskSpec, clocks: { title: at(1) } },
    );
    expect(clocks).toEqual({ title: at(1) });
  });

  it("compares scalar values deeply regardless of key order", () => {
    const spec = { scalars: ["recurrence"] };
    const clocks = { recurrence: at(1) };
    const before = { recurrence: { freq: "weekly", days: [1, 3] } };
    expect(
      buildFieldClockUpdates(before, { recurrence: { days: [1, 3], freq: "weekly" } }, at(2), {
        ...spec,
        clocks,
      }),
    ).toBe(clocks);
    expect(
      buildFieldClockUpdates(before, { recurrence: { freq: "weekly", days: [3, 1] } }, at(2), {
        ...spec,
        clocks,
      }),
    ).toEqual({ recurrence: at(2) });
  });

  it("stamps a scalar going to null and from null", () => {
    const toNull = buildFieldClockUpdates(baseTask, { ...baseTask, deadline: null }, at(2), {
      ...taskSpec,
      clocks: { deadline: at(1) },
    });
    expect(toNull).toEqual({ deadline: at(2) });
    const fromNull = buildFieldClockUpdates(
      baseTask,
      { ...baseTask, notes: "hi" },
      at(2),
      taskSpec,
    );
    expect(fromNull).toEqual({ notes: at(2) });
  });

  describe("json map fields", () => {
    const spec = { maps: ["metrics"] };

    it("stamps an added key", () => {
      const clocks = buildFieldClockUpdates(
        { metrics: { mood: 3 } },
        { metrics: { mood: 3, energy: 5 } },
        at(2),
        spec,
      );
      expect(clocks).toEqual({ "metrics.energy": at(2) });
    });

    it("stamps a changed key and only that key", () => {
      const start = { "metrics.mood": at(1), "metrics.sleep": at(1) };
      const clocks = buildFieldClockUpdates(
        { metrics: { mood: 3, sleep: 7 } },
        { metrics: { mood: 4, sleep: 7 } },
        at(2),
        { ...spec, clocks: start },
      );
      expect(clocks).toEqual({ "metrics.mood": at(2), "metrics.sleep": at(1) });
    });

    it("stamps a removed key and keeps its clock as a tombstone", () => {
      const start = { "metrics.mood": at(1), "metrics.sleep": at(1) };
      const clocks = buildFieldClockUpdates(
        { metrics: { mood: 3, sleep: 7 } },
        { metrics: { mood: 3 } },
        at(2),
        { ...spec, clocks: start },
      );
      expect(clocks).toEqual({ "metrics.mood": at(1), "metrics.sleep": at(2) });
    });

    it("treats nested object values by deep equality", () => {
      const start = { "milestones.m1": at(1) };
      const same = buildFieldClockUpdates(
        { milestones: { m1: { title: "a", done: false } } },
        { milestones: { m1: { done: false, title: "a" } } },
        at(2),
        { maps: ["milestones"], clocks: start },
      );
      expect(same).toBe(start);
      const changed = buildFieldClockUpdates(
        { milestones: { m1: { title: "a", done: false } } },
        { milestones: { m1: { title: "a", done: true } } },
        at(2),
        { maps: ["milestones"], clocks: start },
      );
      expect(changed).toEqual({ "milestones.m1": at(2) });
    });

    it("handles a map that is null, undefined or missing on either side", () => {
      expect(buildFieldClockUpdates({ metrics: null }, { metrics: { a: 1 } }, at(2), spec)).toEqual(
        {
          "metrics.a": at(2),
        },
      );
      expect(buildFieldClockUpdates({ metrics: { a: 1 } }, { metrics: null }, at(2), spec)).toEqual(
        {
          "metrics.a": at(2),
        },
      );
      expect(buildFieldClockUpdates({}, { metrics: undefined }, at(2), spec)).toEqual({});
    });

    it("treats a key whose value is null as present", () => {
      expect(
        buildFieldClockUpdates({ metrics: {} }, { metrics: { a: null } }, at(2), spec),
      ).toEqual({ "metrics.a": at(2) });
    });
  });

  describe("OR-set fields", () => {
    const spec = { sets: ["contextIds"] };

    it("stamps adds and removals per element", () => {
      const start = { "contextIds.a": at(1), "contextIds.b": at(1) };
      const clocks = buildFieldClockUpdates(
        { contextIds: ["a", "b"] },
        { contextIds: ["b", "c"] },
        at(2),
        { ...spec, clocks: start },
      );
      expect(clocks).toEqual({
        "contextIds.a": at(2), // removed
        "contextIds.b": at(1), // untouched
        "contextIds.c": at(2), // added
      });
    });

    it("tracks add, then remove, then re-add with strictly advancing element clocks", () => {
      let clocks: FieldClocks = {};
      let list: string[] = [];
      const writes: Array<[string[], number]> = [
        [["x"], 1], // add
        [[], 2], // remove
        [["x"], 3], // re-add
      ];
      const seen: string[] = [];
      for (const [nextList, time] of writes) {
        clocks = buildFieldClockUpdates({ contextIds: list }, { contextIds: nextList }, at(time), {
          ...spec,
          clocks,
        });
        list = nextList;
        seen.push(clocks["contextIds.x"] as string);
      }
      expect(seen).toEqual([at(1), at(2), at(3)]);
      expect(Object.keys(clocks)).toEqual(["contextIds.x"]);
    });

    it("does not stamp a pure reorder or duplicate ids", () => {
      const start = { "contextIds.a": at(1), "contextIds.b": at(1) };
      const clocks = buildFieldClockUpdates(
        { contextIds: ["a", "b"] },
        { contextIds: ["b", "a", "a"] },
        at(2),
        { ...spec, clocks: start },
      );
      expect(clocks).toBe(start);
    });

    it("handles null or missing lists", () => {
      expect(
        buildFieldClockUpdates({ contextIds: null }, { contextIds: ["a"] }, at(2), spec),
      ).toEqual({
        "contextIds.a": at(2),
      });
      expect(buildFieldClockUpdates({ contextIds: ["a"] }, {}, at(2), spec)).toEqual({
        "contextIds.a": at(2),
      });
    });
  });

  it("does not depend on the key order of the records", () => {
    const a = buildFieldClockUpdates(
      { title: "a", metrics: { x: 1, y: 2 }, contextIds: ["p", "q"] },
      { contextIds: ["q", "r"], metrics: { y: 3, x: 1, z: 4 }, title: "b" },
      at(5),
      taskSpec,
    );
    const b = buildFieldClockUpdates(
      { contextIds: ["q", "p"], metrics: { y: 2, x: 1 }, title: "a" },
      { title: "b", metrics: { z: 4, x: 1, y: 3 }, contextIds: ["r", "q"] },
      at(5),
      taskSpec,
    );
    expect(a).toEqual(b);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(Object.keys(a).sort()).toEqual([
      "contextIds.p",
      "contextIds.r",
      "metrics.y",
      "metrics.z",
      "title",
    ]);
  });

  it("does not mutate previous, next or the supplied clocks", () => {
    const previous = JSON.parse(JSON.stringify(baseTask));
    const next = { ...JSON.parse(JSON.stringify(baseTask)), title: "changed" };
    const clocks = Object.freeze({ title: at(1) });
    const result = buildFieldClockUpdates(previous, next, at(2), { ...taskSpec, clocks });
    expect(result).toEqual({ title: at(2) });
    expect(previous).toEqual(baseTask);
    expect(clocks).toEqual({ title: at(1) });
  });
});

describe("rowHlc", () => {
  it("is the max clock, regardless of insertion order", () => {
    expect(rowHlc({ a: at(3), b: at(9), c: at(1) })).toBe(at(9));
    expect(rowHlc({ a: at(1, 2), b: at(1, 10) })).toBe(at(1, 10));
  });

  it("is null for a row with no clocks", () => {
    expect(rowHlc({})).toBeNull();
  });
});

describe("mergeFieldClocks", () => {
  it("takes the per-key maximum and unions the keys", () => {
    expect(mergeFieldClocks({ a: at(5), b: at(1) }, { a: at(2), b: at(7), c: at(3) })).toEqual({
      a: at(5),
      b: at(7),
      c: at(3),
    });
  });

  it("is commutative, associative and idempotent over random inputs", () => {
    let seed = 99;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const keys = ["title", "notes", "metrics.a", "contextIds.x"];
    const gen = (): FieldClocks => {
      const clocks: FieldClocks = {};
      for (const key of keys) {
        if (rand() < 0.6) {
          clocks[key] = at(Math.floor(rand() * 5), Math.floor(rand() * 3));
        }
      }
      return clocks;
    };
    for (let i = 0; i < 200; i += 1) {
      const [a, b, c] = [gen(), gen(), gen()] as [FieldClocks, FieldClocks, FieldClocks];
      expect(mergeFieldClocks(a, b)).toEqual(mergeFieldClocks(b, a));
      expect(mergeFieldClocks(mergeFieldClocks(a, b), c)).toEqual(
        mergeFieldClocks(a, mergeFieldClocks(b, c)),
      );
      expect(mergeFieldClocks(a, a)).toEqual(a);
    }
  });
});

describe("own-property safety for hostile keys", () => {
  const protoValue = JSON.parse('{"__proto__": {}}') as Record<string, unknown>;

  it("getOwn/setOwn never touch the prototype", () => {
    const map: Record<string, number> = {};
    expect(getOwn(map, "__proto__")).toBeUndefined();
    expect(getOwn(map, "constructor")).toBeUndefined();
    expect(getOwn(map, "toString")).toBeUndefined();
    setOwn(map, "__proto__", 1);
    expect(Object.keys(map)).toEqual(["__proto__"]);
    expect(getOwn(map, "__proto__")).toBe(1);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
  });

  it("jsonDeepEqual does not equate an own __proto__ key with other objects", () => {
    expect(Object.keys(protoValue)).toEqual(["__proto__"]);
    expect(jsonDeepEqual(protoValue, { notes: "x" })).toBe(false);
    expect(jsonDeepEqual({ notes: "x" }, protoValue)).toBe(false);
    expect(jsonDeepEqual(protoValue, { score: 1 })).toBe(false);
    expect(jsonDeepEqual({}, protoValue)).toBe(false);
    expect(jsonDeepEqual(protoValue, JSON.parse('{"__proto__": {}}'))).toBe(true);
    expect(
      jsonDeepEqual(JSON.parse('{"__proto__": {"a": 1}}'), JSON.parse('{"__proto__": {"a": 2}}')),
    ).toBe(false);
  });

  it("canonicalJson/jsonNormalize keep the __proto__ key", () => {
    expect(canonicalJson(protoValue)).toBe('{"__proto__":{}}');
    const normalized = jsonNormalize(protoValue);
    expect(Object.keys(normalized)).toEqual(["__proto__"]);
    expect(canonicalJson(normalized)).toBe('{"__proto__":{}}');
  });

  it("stamps a scalar whose object value gains a __proto__ key", () => {
    const clocks = { payload: at(1) };
    const result = buildFieldClockUpdates(
      { payload: { notes: "x" } },
      { payload: protoValue },
      at(2),
      {
        scalars: ["payload"],
        clocks,
      },
    );
    expect(result).toEqual({ payload: at(2) });
  });

  it("keeps a __proto__ key of a map field and stamps it when added or removed", () => {
    const added = buildFieldClockUpdates(
      { metrics: { mood: 3 } },
      { metrics: JSON.parse('{"__proto__": {"x": 1}, "mood": 3}') },
      at(2),
      { maps: ["metrics"] },
    );
    expect(Object.keys(added)).toEqual(["metrics.__proto__"]);
    const removed = buildFieldClockUpdates(
      { metrics: JSON.parse('{"__proto__": {"x": 1}, "mood": 3}') },
      { metrics: { mood: 3 } },
      at(3),
      { maps: ["metrics"], clocks: added },
    );
    expect(removed).toEqual({ "metrics.__proto__": at(3) });
  });

  it("stamps an edited __proto__ map entry (the change is not silently idle)", () => {
    const start = { "metrics.__proto__": at(1) };
    const result = buildFieldClockUpdates(
      { metrics: JSON.parse('{"__proto__": 1}') },
      { metrics: JSON.parse('{"__proto__": 2}') },
      at(2),
      { maps: ["metrics"], clocks: start },
    );
    expect(result).toEqual({ "metrics.__proto__": at(2) });
  });

  it("does not read inherited names as existing values", () => {
    const result = buildFieldClockUpdates(
      { metrics: { toString: 1 } },
      { metrics: { toString: 1, constructor: 2 } },
      at(2),
      { maps: ["metrics"] },
    );
    expect(result).toEqual({ "metrics.constructor": at(2) });
  });

  it("mergeFieldClocks keeps a clock whose key is exactly __proto__", () => {
    const a = setOwn({} as FieldClocks, "__proto__", at(5));
    const b = setOwn({} as FieldClocks, "__proto__", at(2));
    const merged = mergeFieldClocks(a, b);
    expect(Object.keys(merged)).toEqual(["__proto__"]);
    expect(getOwn(merged, "__proto__")).toBe(at(5));
    expect(Object.keys(mergeFieldClocks(a, {}))).toEqual(["__proto__"]);
    expect(rowHlc(merged)).toBe(at(5));
  });

  it("buildFieldClockUpdates stamps a scalar field literally named __proto__", () => {
    const next = setOwn({} as Record<string, unknown>, "__proto__", "x");
    const result = buildFieldClockUpdates(null, next, at(1), { scalars: ["__proto__"] });
    expect(Object.keys(result)).toEqual(["__proto__"]);
  });
});

describe("map fields stored as arrays of { id } items (e.g. milestones)", () => {
  const spec = { maps: ["milestones"] };
  const m1 = { id: "m1", title: "A", completedAt: null, sortOrder: 0 };
  const m2 = { id: "m2", title: "B", completedAt: null, sortOrder: 1 };

  it("stamps milestones.<id> for every item on creation", () => {
    expect(buildFieldClockUpdates(null, { milestones: [m1, m2] }, at(1), spec)).toEqual({
      "milestones.m1": at(1),
      "milestones.m2": at(1),
    });
  });

  it("stamps a changed item and only that item", () => {
    const start = { "milestones.m1": at(1), "milestones.m2": at(1) };
    const result = buildFieldClockUpdates(
      { milestones: [m1, m2] },
      { milestones: [{ ...m1, title: "A2" }, m2] },
      at(2),
      { ...spec, clocks: start },
    );
    expect(result).toEqual({ "milestones.m1": at(2), "milestones.m2": at(1) });
  });

  it("stamps a removed item as a tombstone and an added one", () => {
    const start = { "milestones.m1": at(1), "milestones.m2": at(1) };
    const removed = buildFieldClockUpdates({ milestones: [m1, m2] }, { milestones: [m2] }, at(2), {
      ...spec,
      clocks: start,
    });
    expect(removed).toEqual({ "milestones.m1": at(2), "milestones.m2": at(1) });
    const added = buildFieldClockUpdates({ milestones: [m2] }, { milestones: [m2, m1] }, at(3), {
      ...spec,
      clocks: removed,
    });
    expect(added).toEqual({ "milestones.m1": at(3), "milestones.m2": at(1) });
  });

  it("is idle when nothing changed, including a pure array reorder", () => {
    const start = { "milestones.m1": at(1), "milestones.m2": at(1) };
    expect(
      buildFieldClockUpdates(
        { milestones: [m1, m2] },
        { milestones: [{ ...m1 }, { ...m2 }] },
        at(2),
        {
          ...spec,
          clocks: start,
        },
      ),
    ).toBe(start);
    expect(
      buildFieldClockUpdates({ milestones: [m1, m2] }, { milestones: [m2, m1] }, at(2), {
        ...spec,
        clocks: start,
      }),
    ).toBe(start);
  });

  it("treats a changed sortOrder as an edit of that item", () => {
    const start = { "milestones.m1": at(1), "milestones.m2": at(1) };
    const result = buildFieldClockUpdates(
      { milestones: [m1, m2] },
      { milestones: [m2, { ...m1, sortOrder: 5 }] },
      at(2),
      { ...spec, clocks: start },
    );
    expect(result).toEqual({ "milestones.m1": at(2), "milestones.m2": at(1) });
  });

  it("treats null, undefined and an empty array as an empty map", () => {
    expect(buildFieldClockUpdates({ milestones: [] }, { milestones: null }, at(2), spec)).toEqual(
      {},
    );
    expect(buildFieldClockUpdates({}, { milestones: [] }, at(2), spec)).toEqual({});
    expect(
      buildFieldClockUpdates({ milestones: [m1] }, { milestones: undefined }, at(2), spec),
    ).toEqual({
      "milestones.m1": at(2),
    });
  });

  it("throws a typed error for duplicate ids", () => {
    expect(() =>
      buildFieldClockUpdates(null, { milestones: [m1, { ...m1 }] }, at(1), spec),
    ).toThrow(FieldClockShapeError);
    expect(() =>
      buildFieldClockUpdates(null, { milestones: [m1, { ...m1 }] }, at(1), spec),
    ).toThrow(/duplicate id "m1"/);
  });

  it("throws a typed error for items without a string id and for non-map values", () => {
    const bad: unknown[] = [
      [{ title: "no id" }],
      [{ id: 3 }],
      [null],
      ["m1"],
      [[{ id: "m1" }]],
      "text",
      42,
      true,
    ];
    for (const value of bad) {
      expect(() => buildFieldClockUpdates(null, { milestones: value }, at(1), spec)).toThrow(
        FieldClockShapeError,
      );
      expect(() =>
        buildFieldClockUpdates({ milestones: value }, { milestones: [] }, at(1), spec),
      ).toThrow(FieldClockShapeError);
    }
    try {
      buildFieldClockUpdates(null, { milestones: "text" }, at(1), spec);
    } catch (error) {
      expect((error as FieldClockShapeError).field).toBe("milestones");
      expect((error as Error).message).toContain("field_clock_map_invalid: milestones");
    }
  });
});

describe("clock validation", () => {
  it("buildFieldClockUpdates rejects a malformed stamp clock", () => {
    expect(() =>
      buildFieldClockUpdates(null, { title: "a" }, "zzzz", { scalars: ["title"] }),
    ).toThrow("hlc_malformed");
  });

  it("mergeFieldClocks and rowHlc propagate hlc_malformed instead of ordering garbage", () => {
    expect(() => mergeFieldClocks({ a: at(1) }, { a: "zzzz" })).toThrow("hlc_malformed");
    expect(() => mergeFieldClocks({ a: "zzzz" }, {})).toThrow("hlc_malformed");
    expect(() => rowHlc({ a: at(1), b: "9-000000-d" })).toThrow("hlc_malformed");
  });
});
