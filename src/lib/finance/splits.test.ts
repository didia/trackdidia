import { validateSplitTotal } from "./splits";

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
