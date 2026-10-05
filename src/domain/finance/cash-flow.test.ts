import { describe, expect, it } from "vitest";
import { computeFinanceCashFlow, type FinanceCashFlowComputationInput } from "./cash-flow";

const base: Omit<FinanceCashFlowComputationInput, "monthKey"> = {
  baseCurrency: "CAD",
  transactions: [],
  splits: [],
};

const txn = (overrides: Partial<FinanceCashFlowComputationInput["transactions"][number]>) => ({
  id: "txn",
  postedDate: "2026-03-10",
  amountMinor: 0,
  currency: "CAD",
  isTransfer: false,
  excludedFromReports: false,
  hasSplits: false,
  ...overrides,
});

describe("computeFinanceCashFlow", () => {
  it("sums income and expense for the month, net = income - expense", () => {
    const result = computeFinanceCashFlow({
      ...base,
      monthKey: "2026-03",
      transactions: [
        txn({ id: "t1", amountMinor: 3_000_00 }),
        txn({ id: "t2", amountMinor: -1_200_00 }),
        txn({ id: "t3", amountMinor: -300_00 }),
      ],
    });
    expect(result).toEqual({
      monthKey: "2026-03",
      incomeMinor: 3_000_00,
      expenseMinor: 1_500_00,
      netMinor: 1_500_00,
    });
  });

  it("excludes transfers and excludedFromReports rows", () => {
    const result = computeFinanceCashFlow({
      ...base,
      monthKey: "2026-03",
      transactions: [
        txn({ id: "t1", amountMinor: 1_000_00 }),
        txn({ id: "t2", amountMinor: -500_00, isTransfer: true }),
        txn({ id: "t3", amountMinor: -400_00, excludedFromReports: true }),
      ],
    });
    expect(result.incomeMinor).toBe(1_000_00);
    expect(result.expenseMinor).toBe(0);
  });

  it("excludes rows outside the month and non-base-currency rows", () => {
    const result = computeFinanceCashFlow({
      ...base,
      monthKey: "2026-03",
      transactions: [
        txn({ id: "t1", postedDate: "2026-02-28", amountMinor: -100_00 }),
        txn({ id: "t2", postedDate: "2026-04-01", amountMinor: -100_00 }),
        txn({ id: "t3", currency: "EUR", amountMinor: -100_00 }),
        txn({ id: "t4", amountMinor: -50_00 }),
      ],
    });
    expect(result.expenseMinor).toBe(50_00);
  });

  it("expands a split transaction into its splits once and never counts the parent", () => {
    const result = computeFinanceCashFlow({
      ...base,
      monthKey: "2026-03",
      transactions: [txn({ id: "t1", amountMinor: -100_00, hasSplits: true })],
      splits: [
        { transactionId: "t1", amountMinor: -60_00 },
        { transactionId: "t1", amountMinor: -40_00 },
      ],
    });
    expect(result.expenseMinor).toBe(100_00);
  });
});
