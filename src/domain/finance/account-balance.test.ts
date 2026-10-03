import { describe, expect, it } from "vitest";
import { computeDerivedBalanceMinor, computeReconciliationDiscrepancy } from "./account-balance";

describe("computeDerivedBalanceMinor", () => {
  it("sums opening balance plus every transaction amount", () => {
    const balance = computeDerivedBalanceMinor({ openingBalanceMinor: 10_000 }, [
      { amountMinor: -2_000 },
      { amountMinor: 1_500 },
    ]);
    expect(balance).toBe(9_500);
  });

  it("returns the opening balance when there are no transactions", () => {
    expect(computeDerivedBalanceMinor({ openingBalanceMinor: 500 }, [])).toBe(500);
  });
});

describe("computeReconciliationDiscrepancy", () => {
  it("returns null when currentBalanceMinor is not set", () => {
    const discrepancy = computeReconciliationDiscrepancy(
      { openingBalanceMinor: 0, currentBalanceMinor: null },
      [{ amountMinor: 100 }],
    );
    expect(discrepancy).toBeNull();
  });

  it("returns null when the derived balance matches the reconciliation value", () => {
    const discrepancy = computeReconciliationDiscrepancy(
      { openingBalanceMinor: 1_000, currentBalanceMinor: 1_500 },
      [{ amountMinor: 500 }],
    );
    expect(discrepancy).toBeNull();
  });

  it("reports the difference when the derived balance disagrees with the reconciliation value", () => {
    const discrepancy = computeReconciliationDiscrepancy(
      { openingBalanceMinor: 1_000, currentBalanceMinor: 1_600 },
      [{ amountMinor: 500 }],
    );
    expect(discrepancy).toEqual({
      derivedBalanceMinor: 1_500,
      currentBalanceMinor: 1_600,
      differenceMinor: 100,
    });
  });
});
