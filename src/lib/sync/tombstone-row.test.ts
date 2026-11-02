import { describe, expect, it } from "vitest";
import { asTombstoneRow, parseTombstoneRow, tombstoneRowJson } from "./tombstone-row";

describe("the values a tombstone keeps", () => {
  it("round-trips a row as canonical JSON, with null cells and numbers kept", () => {
    const row = { title: "Plan", id: "t1", planned_order: 3, deadline: null, ratio: 0.5 };
    const json = tombstoneRowJson(row) as string;
    expect(json).toBe('{"deadline":null,"id":"t1","planned_order":3,"ratio":0.5,"title":"Plan"}');
    expect(parseTombstoneRow(json)).toEqual(row);
  });

  it("narrows a bigint to a number (the SQLite adapter hands integers back that way)", () => {
    expect(asTombstoneRow({ id: "t1", count: 7n })).toEqual({ id: "t1", count: 7 });
  });

  it("keeps a column named __proto__ as data", () => {
    const row = JSON.parse('{"id":"t1","__proto__":"x"}') as Record<string, unknown>;
    const parsed = parseTombstoneRow(tombstoneRowJson(row));
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it("treats anything that is not a row of plain cells as unknown", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "{broken",
      "[1]",
      "null",
      "{}",
      '{"id":{"nested":1}}',
      '{"id":[1]}',
      '{"id":true}',
    ]) {
      expect(parseTombstoneRow(bad as string | null | undefined), String(bad)).toBeNull();
    }
    expect(tombstoneRowJson(null)).toBeNull();
    expect(tombstoneRowJson(undefined)).toBeNull();
    expect(tombstoneRowJson({ nan: Number.NaN })).toBeNull();
    expect(asTombstoneRow({ value: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
