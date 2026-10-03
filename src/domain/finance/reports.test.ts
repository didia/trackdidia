import { describe, expect, it } from "vitest";
import {
  computeFinanceCategorySpend,
  computeFinanceMerchantSpend,
  computeFinanceMonthOverMonth,
  computeFinancePersonSpend,
  computeFinanceTrend,
  listFinanceCategorySpendDrilldown,
  type FinanceReportComputationInput,
} from "./reports";

const GROCERIES = "fincat:groceries";
const RESTAURANTS = "fincat:restaurants";
const FOOD_GROUP = "fincat:food";
const INCOME = "fincat:income";

const categories = [
  { id: FOOD_GROUP, parentId: null, name: "Alimentation" },
  { id: GROCERIES, parentId: FOOD_GROUP, name: "Épicerie" },
  { id: RESTAURANTS, parentId: FOOD_GROUP, name: "Restaurants" },
  { id: INCOME, parentId: null, name: "Revenu" },
];

const txn = (overrides: Partial<FinanceReportComputationInput["transactions"][number]>) => ({
  id: "txn",
  postedDate: "2026-03-10",
  amountMinor: 0,
  currency: "CAD",
  categoryId: null,
  merchantKey: "MERCHANT",
  merchantDisplay: "Merchant",
  personId: null,
  isTransfer: false,
  excludedFromReports: false,
  hasSplits: false,
  ...overrides,
});

const baseInput: FinanceReportComputationInput = {
  baseCurrency: "CAD",
  categories,
  splits: [],
  transactions: [
    txn({ id: "t1", categoryId: GROCERIES, merchantKey: "IGA", amountMinor: -80_00 }),
    txn({ id: "t2", categoryId: GROCERIES, merchantKey: "IGA", amountMinor: -20_00 }),
    txn({ id: "t3", categoryId: RESTAURANTS, merchantKey: "RESTO", amountMinor: -45_00 }),
    txn({ id: "t4", categoryId: INCOME, merchantKey: "EMPLOYER", amountMinor: 3_000_00 }),
    txn({
      id: "t5",
      categoryId: null,
      merchantKey: "XFER",
      amountMinor: -10_00,
      isTransfer: true,
    }),
    txn({
      id: "t6",
      categoryId: RESTAURANTS,
      merchantKey: "RESTO",
      amountMinor: -5_00,
      excludedFromReports: true,
    }),
  ],
};

describe("computeFinanceCategorySpend", () => {
  it("sums spend per category, excluding transfers and excludedFromReports", () => {
    const rows = computeFinanceCategorySpend(
      baseInput,
      { from: "2026-03-01", to: "2026-03-31" },
      "category",
    );
    const groceries = rows.find((row) => row.key === GROCERIES);
    const restaurants = rows.find((row) => row.key === RESTAURANTS);
    expect(groceries?.totalMinor).toBe(100_00);
    expect(restaurants?.totalMinor).toBe(45_00);
    expect(rows.find((row) => row.key === INCOME)).toBeUndefined();
  });

  it("rolls up by category group", () => {
    const rows = computeFinanceCategorySpend(
      baseInput,
      { from: "2026-03-01", to: "2026-03-31" },
      "group",
    );
    const food = rows.find((row) => row.key === FOOD_GROUP);
    expect(food?.totalMinor).toBe(100_00 + 45_00);
  });

  it("counts a split transaction once per split, never the parent", () => {
    const input: FinanceReportComputationInput = {
      ...baseInput,
      transactions: [
        txn({ id: "s1", amountMinor: -100_00, hasSplits: true, categoryId: GROCERIES }),
      ],
      splits: [
        { id: "sp1", transactionId: "s1", amountMinor: -60_00, categoryId: GROCERIES },
        { id: "sp2", transactionId: "s1", amountMinor: -40_00, categoryId: RESTAURANTS },
      ],
    };
    const rows = computeFinanceCategorySpend(
      input,
      { from: "2026-03-01", to: "2026-03-31" },
      "category",
    );
    expect(rows.find((row) => row.key === GROCERIES)?.totalMinor).toBe(60_00);
    expect(rows.find((row) => row.key === RESTAURANTS)?.totalMinor).toBe(40_00);
  });
});

describe("listFinanceCategorySpendDrilldown", () => {
  it("lists exactly the transactions that sum to the category's totalMinor", () => {
    const range = { from: "2026-03-01", to: "2026-03-31" };
    const rows = computeFinanceCategorySpend(baseInput, range, "category");
    const groceries = rows.find((row) => row.key === GROCERIES);
    const drilldown = listFinanceCategorySpendDrilldown(baseInput, range, "category", GROCERIES);
    const sum = drilldown.reduce((total, line) => total + -line.amountMinor, 0);
    expect(sum).toBe(groceries?.totalMinor);
    expect(drilldown.map((line) => line.transactionId).sort()).toEqual(["t1", "t2"]);
  });
});

describe("computeFinanceMerchantSpend", () => {
  it("groups by merchant and sorts descending, sliced to limit", () => {
    const rows = computeFinanceMerchantSpend(
      baseInput,
      { from: "2026-03-01", to: "2026-03-31" },
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].merchantKey).toBe("IGA");
    expect(rows[0].totalMinor).toBe(100_00);
  });
});

describe("computeFinancePersonSpend", () => {
  it("groups spend by person, null bucket for unassigned", () => {
    const rows = computeFinancePersonSpend(baseInput, { from: "2026-03-01", to: "2026-03-31" });
    const unassigned = rows.find((row) => row.personId === null);
    expect(unassigned?.totalMinor).toBe(100_00 + 45_00);
  });
});

describe("computeFinanceTrend", () => {
  it("buckets income/expense by month", () => {
    const points = computeFinanceTrend(
      baseInput,
      { from: "2026-03-01", to: "2026-03-31" },
      "month",
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      periodKey: "2026-03",
      incomeMinor: 3_000_00,
      expenseMinor: 145_00,
      netMinor: 3_000_00 - 145_00,
    });
  });
});

describe("computeFinanceMonthOverMonth", () => {
  it("compares per-category spend between two ranges", () => {
    const previousInput: FinanceReportComputationInput = {
      ...baseInput,
      transactions: [
        txn({ id: "p1", categoryId: GROCERIES, amountMinor: -30_00, postedDate: "2026-02-10" }),
      ],
    };
    const rows = computeFinanceMonthOverMonth(
      { ...baseInput, transactions: [...baseInput.transactions, ...previousInput.transactions] },
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-02-01", to: "2026-02-28" },
      "category",
    );
    const groceries = rows.find((row) => row.key === GROCERIES);
    expect(groceries?.currentMinor).toBe(100_00);
    expect(groceries?.previousMinor).toBe(30_00);
    expect(groceries?.deltaMinor).toBe(70_00);
  });
});
