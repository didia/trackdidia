// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: in-memory SQLite only.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { entityIdOf, parseEntityId } from "./entity-id";

describe("entityIdOf", () => {
  it("encodes a single-column key as the value itself", () => {
    expect(entityIdOf("gtd_tasks", ["task-1"])).toBe("task-1");
    expect(entityIdOf("daily_entries", ["2026-03-31"])).toBe("2026-03-31");
    expect(entityIdOf("finance_budget_months", ["2026-03"])).toBe("2026-03");
  });

  it("encodes a composite key as a JSON array in registry order, numbers as numbers", () => {
    expect(entityIdOf("weekly_objective_results", ["2026-03-29", "obj-1"])).toBe(
      '["2026-03-29","obj-1"]',
    );
    expect(entityIdOf("finance_merchant_memory", ["cafe", "acc-1", -1])).toBe(
      '["cafe","acc-1",-1]',
    );
  });

  it("rejects the wrong arity and values that cannot be part of a key", () => {
    expect(() => entityIdOf("gtd_tasks", [])).toThrow(/1-column primary key/);
    expect(() => entityIdOf("weekly_objective_results", ["only-one"])).toThrow(/2-column/);
    expect(() => entityIdOf("gtd_tasks", [null])).toThrow(/strings or finite numbers/);
    expect(() => entityIdOf("gtd_tasks", [Number.NaN])).toThrow(/strings or finite numbers/);
    expect(() => entityIdOf("not_a_table", ["x"])).toThrow(/not classified/);
  });
});

describe("parseEntityId", () => {
  it("round-trips ids of both shapes", () => {
    expect(parseEntityId("gtd_tasks", "task-1")).toEqual(["task-1"]);
    for (const key of [
      ["2026-03-29", "obj-1"],
      ['a"b\\c', "", "é😀"],
    ]) {
      const table = key.length === 2 ? "weekly_objective_results" : "finance_merchant_memory";
      const values = key.length === 2 ? key : [key[0], key[1], 1];
      expect(parseEntityId(table, entityIdOf(table, values))).toEqual(values);
    }
  });

  it("returns null for ids that are not valid keys of the table", () => {
    expect(parseEntityId("gtd_tasks", null)).toBeNull();
    expect(parseEntityId("gtd_tasks", 5)).toBeNull();
    expect(parseEntityId("weekly_objective_results", "not json")).toBeNull();
    expect(parseEntityId("weekly_objective_results", '["one"]')).toBeNull();
    expect(parseEntityId("weekly_objective_results", '["a",null]')).toBeNull();
    expect(parseEntityId("weekly_objective_results", '{"a":1}')).toBeNull();
  });
});

describe("agreement with SQLite json_array", () => {
  it("encodes awkward key values exactly like the capture triggers do", async () => {
    const db = createNodeSqliteDatabase();
    const awkward = [
      "plain",
      'quo"te',
      "back\\slash",
      "new\nline\ttab\r",
      "ctrl\u0001\u001f",
      "del\u007f",
      "slash/ok",
      "é à ü 日本 😀",
      "  ",
      "",
      "  spaces  ",
      "[1,2]",
      '{"a":1}',
    ];
    for (const a of awkward) {
      for (const b of awkward) {
        const [row] = await db.select<{ key: string }[]>("SELECT json_array($1, $2, -7) AS key", [
          a,
          b,
        ]);
        expect(row?.key).toBe(entityIdOf("finance_merchant_memory", [a, b, -7]));
      }
    }
  });
});
