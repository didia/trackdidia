import { describe, expect, it } from "vitest";
import type { FinanceCategory } from "../finance";
import {
  buildCategoryTree,
  groupHasActiveChildren,
  listReassignTargets,
  nextCategorySortOrder,
  validateCategoryName,
} from "./category-management";

const category = (overrides: Partial<FinanceCategory> & { id: string }): FinanceCategory => ({
  name: overrides.id,
  parentId: null,
  kind: "expense",
  archived: false,
  isSystem: false,
  defersToNextMonth: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const fixtures = [
  category({ id: "fincat:non-categorise", name: "Non catégorisé", isSystem: true }),
  category({ id: "g1", name: "Alimentation", sortOrder: 0 }),
  category({ id: "c1", name: "Épicerie", parentId: "g1", sortOrder: 0 }),
  category({ id: "c2", name: "Restaurants", parentId: "g1", sortOrder: 1 }),
  category({ id: "c3", name: "Ancien", parentId: "g1", sortOrder: 2, archived: true }),
  category({ id: "g2", name: "Revenu", kind: "income", sortOrder: 1 }),
  category({ id: "c4", name: "Salaire", parentId: "g2", kind: "income" }),
  category({ id: "g3", name: "Vide", sortOrder: 2 }),
];

describe("buildCategoryTree", () => {
  it("lists active groups with active children and hides system categories", () => {
    const tree = buildCategoryTree(fixtures, false);
    expect(tree.map((entry) => entry.group.id)).toEqual(["g1", "g2", "g3"]);
    expect(tree[0].children.map((child) => child.id)).toEqual(["c1", "c2"]);
  });

  it("lists only groups that hold archived categories in the archived view", () => {
    const tree = buildCategoryTree(fixtures, true);
    expect(tree.map((entry) => entry.group.id)).toEqual(["g1"]);
    expect(tree[0].children.map((child) => child.id)).toEqual(["c3"]);
  });
});

describe("validateCategoryName", () => {
  it("requires a non-blank name", () => {
    expect(validateCategoryName("   ", "g1", fixtures)).toBe("required");
  });

  it("rejects an accent- and case-insensitive duplicate among active siblings", () => {
    expect(validateCategoryName("epicerie", "g1", fixtures)).toBe("duplicate");
    expect(validateCategoryName("  ÉPICERIE ", "g1", fixtures)).toBe("duplicate");
  });

  it("allows the same name under another parent, an archived sibling's name, or a rename to itself", () => {
    expect(validateCategoryName("Épicerie", "g2", fixtures)).toBeNull();
    expect(validateCategoryName("Ancien", "g1", fixtures)).toBeNull();
    expect(validateCategoryName("Épicerie", "g1", fixtures, "c1")).toBeNull();
  });
});

describe("nextCategorySortOrder", () => {
  it("places a new category after its siblings", () => {
    expect(nextCategorySortOrder("g1", fixtures)).toBe(3);
    expect(nextCategorySortOrder("g3", fixtures)).toBe(0);
  });
});

describe("listReassignTargets", () => {
  it("offers same-kind active leaves and Non catégorisé, never itself or a group with children", () => {
    const ids = listReassignTargets(fixtures[2], fixtures).map((target) => target.id);
    expect(ids).toContain("fincat:non-categorise");
    expect(ids).toContain("c2");
    expect(ids).toContain("g3");
    expect(ids).not.toContain("c1");
    expect(ids).not.toContain("g1");
    expect(ids).not.toContain("c4");
    expect(ids).not.toContain("c3");
  });
});

describe("groupHasActiveChildren", () => {
  it("ignores archived children", () => {
    expect(groupHasActiveChildren(fixtures[1], fixtures)).toBe(true);
    expect(groupHasActiveChildren(fixtures[7], fixtures)).toBe(false);
    expect(
      groupHasActiveChildren(fixtures[1], [
        fixtures[1],
        category({ id: "x", parentId: "g1", archived: true }),
      ]),
    ).toBe(false);
  });
});
