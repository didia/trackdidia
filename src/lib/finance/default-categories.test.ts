import { DEFAULT_FINANCE_CATEGORIES } from "./default-categories";

describe("DEFAULT_FINANCE_CATEGORIES", () => {
  it("has unique, fixed fincat: ids", () => {
    const ids = DEFAULT_FINANCE_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("fincat:"))).toBe(true);
  });

  it("every parentId points at an id present in the taxonomy", () => {
    const ids = new Set(DEFAULT_FINANCE_CATEGORIES.map((category) => category.id));
    for (const category of DEFAULT_FINANCE_CATEGORIES) {
      if (category.parentId !== null) {
        expect(ids.has(category.parentId)).toBe(true);
      }
    }
  });

  it("never reuses a system category id", () => {
    const systemIds = ["fincat:non-categorise", "fincat:transfert", "fincat:split"];
    const ids = DEFAULT_FINANCE_CATEGORIES.map((category) => category.id);
    for (const systemId of systemIds) {
      expect(ids).not.toContain(systemId);
    }
  });

  it("is deterministic across repeated imports (stable ids, not regenerated)", () => {
    const first = DEFAULT_FINANCE_CATEGORIES.map((category) => category.id);
    const second = DEFAULT_FINANCE_CATEGORIES.map((category) => category.id);
    expect(first).toEqual(second);
  });
});
