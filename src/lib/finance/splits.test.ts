import { planSplitSave, validateSplitTotal } from "./splits";

describe("validateSplitTotal", () => {
  it("accepts an empty list and an exact sum", () => {
    expect(() => validateSplitTotal(-5000, [])).not.toThrow();
    expect(() =>
      validateSplitTotal(-5000, [
        { id: "", amountMinor: -2000 },
        { id: "", amountMinor: -3000 },
      ]),
    ).not.toThrow();
  });

  it("rejects mismatched totals, fractional amounts, and duplicate ids", () => {
    expect(() => validateSplitTotal(-5000, [{ id: "", amountMinor: -1000 }])).toThrow();
    expect(() =>
      validateSplitTotal(-1, [
        { id: "", amountMinor: -0.5 },
        { id: "", amountMinor: -0.5 },
      ]),
    ).toThrow();
    expect(() =>
      validateSplitTotal(-10, [
        { id: "x", amountMinor: -5 },
        { id: "x", amountMinor: -5 },
      ]),
    ).toThrow();
  });
});

describe("planSplitSave", () => {
  const stored = [
    { id: "a", amountMinor: -600, categoryId: "fincat:x", notes: null, sortOrder: 0 },
    { id: "b", amountMinor: -400, categoryId: "fincat:y", notes: "n", sortOrder: 1 },
  ];
  const requested = stored.map(({ sortOrder: _order, ...split }) => ({ ...split }));
  const splitParent = {
    hasSplits: true,
    categoryId: "fincat:split",
    categorySource: "user" as const,
    categoryConfidence: null,
  };

  it("writes nothing when the stored children and the parent already match", () => {
    expect(planSplitSave(splitParent, stored, requested)).toEqual({
      rewriteChildren: false,
      parentTarget: null,
    });
    // The stored order does not matter, only the order of the requested list.
    expect(planSplitSave(splitParent, [...stored].reverse(), requested).rewriteChildren).toBe(
      false,
    );
  });

  it("rewrites when only a split's notes change", () => {
    const next = [
      requested[0],
      { ...(requested[1] as (typeof requested)[number]), notes: "changed" },
    ];
    const plan = planSplitSave(splitParent, stored, next as typeof requested);
    expect(plan.rewriteChildren).toBe(true);
    // The parent already holds its split state, so only the children (and its updated_at) move.
    expect(plan.parentTarget).toBeNull();
  });

  it("rewrites when only the order of the same splits changes", () => {
    const plan = planSplitSave(splitParent, stored, [...requested].reverse());
    expect(plan.rewriteChildren).toBe(true);
  });

  it("rewrites when an amount, a category or an id changes", () => {
    const [first, second] = requested as [(typeof requested)[number], (typeof requested)[number]];
    expect(
      planSplitSave(splitParent, stored, [{ ...first, amountMinor: -601 }, second]).rewriteChildren,
    ).toBe(true);
    expect(
      planSplitSave(splitParent, stored, [{ ...first, categoryId: "fincat:z" }, second])
        .rewriteChildren,
    ).toBe(true);
    expect(
      planSplitSave(splitParent, stored, [{ ...first, id: "c" }, second]).rewriteChildren,
    ).toBe(true);
  });

  it("rewrites a split with an empty id (a new split gets an id on save)", () => {
    const [first, second] = requested as [(typeof requested)[number], (typeof requested)[number]];
    expect(planSplitSave(splitParent, stored, [{ ...first, id: "" }, second]).rewriteChildren).toBe(
      true,
    );
  });

  it("rewrites children whose stored order is not 0..n-1, so the save normalizes it", () => {
    const gapped = [
      { ...(stored[0] as (typeof stored)[number]), sortOrder: 0 },
      { ...(stored[1] as (typeof stored)[number]), sortOrder: 5 },
    ];
    expect(planSplitSave(splitParent, gapped, requested).rewriteChildren).toBe(true);
    const allZero = stored.map((split) => ({ ...split, sortOrder: 0 }));
    expect(planSplitSave(splitParent, allZero, requested).rewriteChildren).toBe(true);
  });

  it("never treats an empty id as a match, even against a stored empty id", () => {
    const blank = [
      { id: "", amountMinor: -1000, categoryId: "fincat:x", notes: null, sortOrder: 0 },
    ];
    const next = [{ id: "", amountMinor: -1000, categoryId: "fincat:x", notes: null }];
    expect(planSplitSave(splitParent, blank, next).rewriteChildren).toBe(true);
  });

  it("rewrites when the count changes, in both directions", () => {
    const [first] = requested as [(typeof requested)[number]];
    expect(planSplitSave(splitParent, stored, [first]).rewriteChildren).toBe(true);
    expect(planSplitSave(splitParent, stored.slice(0, 1), requested).rewriteChildren).toBe(true);
    expect(planSplitSave(splitParent, [], requested).rewriteChildren).toBe(true);
  });

  it("repairs a parent that says it has splits while it has no children", () => {
    // Removing every split from a parent that is still flagged and holds the internal category.
    const plan = planSplitSave(splitParent, [], []);
    expect(plan.rewriteChildren).toBe(false);
    expect(plan.parentTarget).toEqual({
      hasSplits: false,
      categoryId: "fincat:non-categorise",
      categorySource: "default",
      categoryConfidence: null,
    });
    // A parent flagged `has_splits` whose category is something else keeps it but loses the flag.
    expect(
      planSplitSave(
        { ...splitParent, categoryId: "fincat:logement", categorySource: "rule" },
        [],
        [],
      ).parentTarget,
    ).toEqual({
      hasSplits: false,
      categoryId: "fincat:logement",
      categorySource: "rule",
      categoryConfidence: null,
    });
    // Saving splits on a parent that is not yet flagged sets the split state even if children match.
    expect(
      planSplitSave(
        {
          hasSplits: false,
          categoryId: "fincat:x",
          categorySource: "rule",
          categoryConfidence: 0.5,
        },
        stored,
        requested,
      ),
    ).toEqual({
      rewriteChildren: false,
      parentTarget: {
        hasSplits: true,
        categoryId: "fincat:split",
        categorySource: "user",
        categoryConfidence: null,
      },
    });
  });

  it("is a no-op for a parent without splits and nothing to clear", () => {
    const plain = {
      hasSplits: false,
      categoryId: "fincat:logement",
      categorySource: "rule" as const,
      categoryConfidence: 0.9,
    };
    expect(planSplitSave(plain, [], [])).toEqual({ rewriteChildren: false, parentTarget: null });
  });
});
