import { describe, expect, it } from "vitest";
import { validateSplitTotal } from "./splits";
import { reconcileInvoiceSplits } from "./invoice-splits";

const sum = (rows: { amountMinor: number }[]) =>
  rows.reduce((total, row) => total + row.amountMinor, 0);

describe("reconcileInvoiceSplits", () => {
  it("keeps amounts that already add up and signs them like an expense", () => {
    const result = reconcileInvoiceSplits(-10000, [
      { categoryId: "a", amountMinor: 6000 },
      { categoryId: "b", amountMinor: 4000 },
    ]);
    expect(result).toMatchObject({ adjusted: false, totalMismatch: false });
    expect(result?.rows.map((row) => row.amountMinor)).toEqual([-6000, -4000]);
  });

  it("keeps a positive sign for a refund", () => {
    const result = reconcileInvoiceSplits(2500, [{ categoryId: "a", amountMinor: 2500 }]);
    expect(result?.rows.map((row) => row.amountMinor)).toEqual([2500]);
  });

  it("rescales to the exact total with the largest-remainder method", () => {
    // Lines add to 100.00 but the card was charged 114.98 (taxes the model did not distribute).
    const result = reconcileInvoiceSplits(-11498, [
      { categoryId: "a", amountMinor: 3333 },
      { categoryId: "b", amountMinor: 3333 },
      { categoryId: "c", amountMinor: 3334 },
    ]);
    expect(result?.adjusted).toBe(true);
    expect(sum(result?.rows ?? [])).toBe(-11498);
    expect(() =>
      validateSplitTotal(
        -11498,
        result?.rows.map((row) => ({ amountMinor: row.amountMinor, id: "" })) ?? [],
      ),
    ).not.toThrow();
  });

  it("always lands exactly on the target, whatever the weights", () => {
    for (const weights of [
      [1, 1, 1],
      [7, 13, 29],
      [1, 999_999],
      [5, 5, 5, 5, 5, 5, 5],
    ]) {
      const result = reconcileInvoiceSplits(
        -10001,
        weights.map((amountMinor, index) => ({ categoryId: `c${index}`, amountMinor })),
      );
      expect(sum(result?.rows ?? [])).toBe(-10001);
    }
  });

  it("merges lines of the same category and joins their descriptions", () => {
    const result = reconcileInvoiceSplits(-3000, [
      { categoryId: "a", amountMinor: 1000, description: "Pain" },
      { categoryId: "b", amountMinor: 1000 },
      { categoryId: "a", amountMinor: 1000, description: "Lait" },
    ]);
    expect(result?.rows).toEqual([
      { categoryId: "a", amountMinor: -2000, description: "Pain, Lait" },
      { categoryId: "b", amountMinor: -1000, description: "" },
    ]);
  });

  it("keeps several unknown-category lines separate", () => {
    const result = reconcileInvoiceSplits(-300, [
      { categoryId: null, amountMinor: 100 },
      { categoryId: null, amountMinor: 200 },
    ]);
    expect(result?.rows).toHaveLength(2);
  });

  it("ignores non-positive and fractional lines", () => {
    const result = reconcileInvoiceSplits(-1000, [
      { categoryId: "a", amountMinor: -500 },
      { categoryId: "b", amountMinor: 0 },
      { categoryId: "c", amountMinor: 10.5 },
      { categoryId: "d", amountMinor: 1000 },
    ]);
    expect(result?.rows).toEqual([{ categoryId: "d", amountMinor: -1000, description: "" }]);
  });

  it("returns null when nothing is usable or the parent is zero", () => {
    expect(reconcileInvoiceSplits(-1000, [])).toBeNull();
    expect(reconcileInvoiceSplits(-1000, [{ categoryId: "a", amountMinor: 0 }])).toBeNull();
    expect(reconcileInvoiceSplits(0, [{ categoryId: "a", amountMinor: 100 }])).toBeNull();
  });

  it("drops a line that rounds to zero after rescaling", () => {
    const result = reconcileInvoiceSplits(-10, [
      { categoryId: "a", amountMinor: 1_000_000 },
      { categoryId: "b", amountMinor: 1 },
    ]);
    expect(result?.rows).toEqual([{ categoryId: "a", amountMinor: -10, description: "" }]);
  });

  it("stays exact for amounts whose product exceeds 2^53", () => {
    const result = reconcileInvoiceSplits(-900_000_000_000, [
      { categoryId: "a", amountMinor: 300_000_000_001 },
      { categoryId: "b", amountMinor: 600_000_000_003 },
    ]);
    expect(sum(result?.rows ?? [])).toBe(-900_000_000_000);
  });

  it("flags an invoice whose own total is not the transaction amount", () => {
    const lines = [{ categoryId: "a", amountMinor: 5000 }];
    expect(reconcileInvoiceSplits(-5000, lines, 5001)?.totalMismatch).toBe(false);
    expect(reconcileInvoiceSplits(-5000, lines, 5040)?.totalMismatch).toBe(false);
    expect(reconcileInvoiceSplits(-5000, lines, 9000)?.totalMismatch).toBe(true);
    expect(reconcileInvoiceSplits(-5000, lines, null)?.totalMismatch).toBe(false);
  });
});
