import { describe, expect, it } from "vitest";
import {
  addMonthsToMonthKey,
  assertFinanceCategoryAssignable,
  computeAssignAllReadyToAssign,
  computeAssignAverageLast3MonthsAmount,
  computeAssignLastMonthAmount,
  computeCoverOverspending,
  computeEnvelopePace,
  computeFinanceBudgetState,
  computeFinanceCategoryActivity,
  computeFinanceCategoryAvailable,
  computeFinanceCategoryCarryIn,
  computeEnvelopePaceFromState,
  computeFinanceDeferredIncome,
  computeFinanceOnBudgetBalance,
  computeFinanceReadyToAssign,
  listUnbudgetedCategoryActivity,
  selectUnbudgetedCategories,
  type FinanceBudgetComputationInput,
} from "./budget";
import type { FinanceBudgetEntry } from "../finance";

const CATEGORY_A = "fincat:test.a";
const CATEGORY_B = "fincat:test.b";
const UNCATEGORIZED = "fincat:non-categorise";
const INCOME = "fincat:test.income";
const DEFERRED_INCOME = "fincat:test.income-deferred";
const CHECKING = "account-checking";
const CREDIT_CARD = "account-credit-card";
const INVESTMENT = "account-investment";

const categories = [
  { id: CATEGORY_A, kind: "expense" as const, defersToNextMonth: false },
  { id: CATEGORY_B, kind: "expense" as const, defersToNextMonth: false },
  { id: UNCATEGORIZED, kind: "expense" as const, defersToNextMonth: false },
  { id: INCOME, kind: "income" as const, defersToNextMonth: false },
  { id: DEFERRED_INCOME, kind: "income" as const, defersToNextMonth: true },
];

const accounts = [
  { id: CHECKING, onBudget: true, openingBalanceMinor: 0 },
  { id: CREDIT_CARD, onBudget: true, openingBalanceMinor: 0 },
  { id: INVESTMENT, onBudget: false, openingBalanceMinor: 0 },
];

let nextTxnId = 0;
const txn = (
  accountId: string,
  postedDate: string,
  amountMinor: number,
  categoryId: string | null,
  hasSplits = false,
) => ({
  id: `txn-${nextTxnId++}`,
  accountId,
  postedDate,
  amountMinor,
  categoryId,
  hasSplits,
});

const entry = (
  monthKey: string,
  categoryId: string,
  assignedMinor: number,
  overspendPolicy: FinanceBudgetEntry["overspendPolicy"] = "reduce_next_ready_to_assign",
): FinanceBudgetEntry => ({
  monthKey,
  categoryId,
  assignedMinor,
  overspendPolicy,
  note: null,
  updatedAt: "",
});

/** The invariant `budget.test.ts` must assert directly, per specs/todo/finance.md "Budget model". */
const expectBalanceInvariant = (monthKey: string, input: FinanceBudgetComputationInput) => {
  const state = computeFinanceBudgetState({ ...input, monthKey });
  const sumAvailable = state.categories.reduce((total, c) => total + c.availableMinor, 0);
  const sumFutureAssigned = input.entries.reduce(
    (total, e) => total + (e.monthKey > monthKey ? e.assignedMinor : 0),
    0,
  );
  const deferredThis = computeFinanceDeferredIncome(monthKey, input);
  const deferredPrev = computeFinanceDeferredIncome(addMonthsToMonthKey(monthKey, -1), input);
  expect(state.onBudgetBalanceMinor).toBe(
    sumAvailable + state.readyToAssignMinor + sumFutureAssigned + (deferredThis - deferredPrev),
  );
};

describe("worked example — income 100, assign 50 to A, spend 80 on A", () => {
  const buildInput = (
    overspendPolicy: FinanceBudgetEntry["overspendPolicy"],
  ): FinanceBudgetComputationInput => ({
    monthKey: "2026-01",
    accounts,
    transactions: [
      txn(CHECKING, "2026-01-02", 10_000, INCOME),
      txn(CHECKING, "2026-01-10", -8_000, CATEGORY_A),
    ],
    splits: [],
    entries: [entry("2026-01", CATEGORY_A, 5_000, overspendPolicy)],
    categories,
  });

  it.each([
    "reduce_next_ready_to_assign",
    "carry_negative",
  ] as const)("holds the balance invariant in month 1 and month 2 under %s", (overspendPolicy) => {
    const input = buildInput(overspendPolicy);
    expect(computeFinanceCategoryActivity(CATEGORY_A, "2026-01", input)).toBe(-8_000);
    expect(computeFinanceCategoryAvailable(CATEGORY_A, "2026-01", input)).toBe(-3_000);
    expect(computeFinanceReadyToAssign("2026-01", input)).toBe(5_000);
    expectBalanceInvariant("2026-01", input);

    const month2Input = { ...input, monthKey: "2026-02" };
    expectBalanceInvariant("2026-02", month2Input);

    if (overspendPolicy === "reduce_next_ready_to_assign") {
      expect(computeFinanceCategoryCarryIn(CATEGORY_A, "2026-02", month2Input)).toBe(0);
      expect(computeFinanceReadyToAssign("2026-02", month2Input)).toBe(2_000);
    } else {
      expect(computeFinanceCategoryCarryIn(CATEGORY_A, "2026-02", month2Input)).toBe(-3_000);
      expect(computeFinanceReadyToAssign("2026-02", month2Input)).toBe(5_000);
    }
  });
});

describe("positive rollover", () => {
  it("carries a positive available balance forward unchanged", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-02",
      accounts,
      transactions: [txn(CHECKING, "2026-01-05", -400, CATEGORY_A)],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 1_000)],
      categories,
    };
    expect(computeFinanceCategoryAvailable(CATEGORY_A, "2026-01", input)).toBe(600);
    expect(computeFinanceCategoryCarryIn(CATEGORY_A, "2026-02", input)).toBe(600);
    expect(computeFinanceCategoryAvailable(CATEGORY_A, "2026-02", input)).toBe(600);
  });
});

describe("retroactive edit propagates forward", () => {
  it("a correction to a transaction six months back changes this month's available", () => {
    const monthsForward = Array.from({ length: 6 }, (_, i) => addMonthsToMonthKey("2026-01", i));
    const buildInput = (januarySpendMinor: number): FinanceBudgetComputationInput => ({
      monthKey: "2026-07",
      accounts,
      transactions: [txn(CHECKING, "2026-01-05", januarySpendMinor, CATEGORY_A)],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 1_000)],
      categories,
    });

    expect(monthsForward).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);

    const before = buildInput(-1_000);
    expect(computeFinanceCategoryAvailable(CATEGORY_A, "2026-07", before)).toBe(0);

    const after = buildInput(-400);
    expect(computeFinanceCategoryAvailable(CATEGORY_A, "2026-07", after)).toBe(600);
  });
});

describe("income deferred to next month", () => {
  it("holds the balance invariant across the earning month and the release month", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-28", 5_000, DEFERRED_INCOME)],
      splits: [],
      entries: [],
      categories,
    };
    expect(computeFinanceDeferredIncome("2026-01", input)).toBe(5_000);
    expect(computeFinanceReadyToAssign("2026-01", input)).toBe(0);
    expectBalanceInvariant("2026-01", input);

    const nextMonthInput = { ...input, monthKey: "2026-02" };
    expect(computeFinanceDeferredIncome("2026-02", nextMonthInput)).toBe(0);
    expectBalanceInvariant("2026-02", nextMonthInput);
  });
});

describe("on-budget credit-card purchase plus payment transfer", () => {
  it("leaves Ready to Assign unchanged whether or not the cancelling transfer legs are present", () => {
    const base: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [
        txn(CHECKING, "2026-01-02", 10_000, INCOME),
        txn(CREDIT_CARD, "2026-01-10", -3_000, CATEGORY_A),
      ],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 3_000)],
      categories,
    };
    const withTransferLegsIncluded: FinanceBudgetComputationInput = {
      ...base,
      // Both legs are on-budget accounts, so including the (otherwise
      // excluded_from_budget) pair must cancel in the aggregate balance.
      transactions: [
        ...base.transactions,
        txn(CHECKING, "2026-01-15", -1_500, "fincat:transfert"),
        txn(CREDIT_CARD, "2026-01-15", 1_500, "fincat:transfert"),
      ],
    };

    expect(computeFinanceReadyToAssign("2026-01", withTransferLegsIncluded)).toBe(
      computeFinanceReadyToAssign("2026-01", base),
    );
  });
});

describe("one-legged transfer to an off-budget account", () => {
  it("counts as ordinary spending in the sending on-budget account", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [
        txn(CHECKING, "2026-01-02", 10_000, INCOME),
        // The investment account is off-budget, so only the checking leg is
        // present in the (already-filtered) input — and it is deliberately
        // not excluded_from_budget, per "Transfer detection".
        txn(CHECKING, "2026-01-12", -2_000, UNCATEGORIZED),
      ],
      splits: [],
      entries: [],
      categories,
    };
    expect(computeFinanceCategoryActivity(UNCATEGORIZED, "2026-01", input)).toBe(-2_000);
    // Unassigned spending lowers the balance but also lowers Uncategorized's
    // `available` by the same amount, so it does not change Ready to Assign —
    // it shows up as negative available in "Non budgété" until assigned.
    expect(computeFinanceReadyToAssign("2026-01", input)).toBe(10_000);
  });
});

describe("split transaction", () => {
  it("contributes its full amount to categories exactly once", () => {
    const parent = txn(CHECKING, "2026-01-05", -1_000, "fincat:split", true);
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-02", 10_000, INCOME), parent],
      splits: [
        { transactionId: parent.id, amountMinor: -600, categoryId: CATEGORY_A },
        { transactionId: parent.id, amountMinor: -400, categoryId: CATEGORY_B },
      ],
      entries: [],
      categories,
    };
    expect(computeFinanceCategoryActivity(CATEGORY_A, "2026-01", input)).toBe(-600);
    expect(computeFinanceCategoryActivity(CATEGORY_B, "2026-01", input)).toBe(-400);
    // The full transaction amount (not split-expanded) still contributes once to the balance.
    expect(computeFinanceOnBudgetBalance("2026-01", input)).toBe(10_000 - 1_000);
    expectBalanceInvariant("2026-01", input);
  });
});

describe("zero Ready to Assign when everything is assigned", () => {
  it("returns 0 once the full income is assigned and nothing is spent", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-02", 10_000, INCOME)],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 10_000)],
      categories,
    };
    expect(computeFinanceReadyToAssign("2026-01", input)).toBe(0);
    expectBalanceInvariant("2026-01", input);
  });
});

describe("assigning 0 removes the row", () => {
  it("is visible to listUnbudgetedCategoryActivity as 'never assigned'", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-05", -500, CATEGORY_A)],
      splits: [],
      entries: [], // setFinanceBudgetAssignment(..., 0) deletes the row, so no entry exists
      categories,
    };
    expect(listUnbudgetedCategoryActivity("2026-01", input)).toEqual([
      { categoryId: CATEGORY_A, activityMinor: -500 },
    ]);
  });
});

describe("assertFinanceCategoryAssignable", () => {
  it("rejects income-kind categories and accepts expense categories", () => {
    expect(() => assertFinanceCategoryAssignable({ id: INCOME, kind: "income" })).toThrow();
    expect(() =>
      assertFinanceCategoryAssignable({ id: CATEGORY_A, kind: "expense" }),
    ).not.toThrow();
  });
});

describe("quick actions", () => {
  const input: FinanceBudgetComputationInput = {
    monthKey: "2026-03",
    accounts,
    transactions: [],
    splits: [],
    entries: [
      entry("2026-01", CATEGORY_A, 1_000),
      entry("2026-02", CATEGORY_A, 2_000),
      entry("2026-01", CATEGORY_B, -500), // unused by A's quick actions
    ],
    categories,
  };

  it("assign last month's amount", () => {
    expect(computeAssignLastMonthAmount(CATEGORY_A, "2026-03", input)).toBe(2_000);
  });

  it("assign average of last 3 months", () => {
    expect(computeAssignAverageLast3MonthsAmount(CATEGORY_A, "2026-03", input)).toBe(1_000);
  });

  it("cover overspending from another category, capped at the source's available", () => {
    const overspent: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-05", -1_200, CATEGORY_A)],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 1_000), entry("2026-01", CATEGORY_B, 100)],
      categories,
    };
    const result = computeCoverOverspending(CATEGORY_B, CATEGORY_A, "2026-01", overspent);
    expect(result).toEqual({
      amountMinor: 100,
      fromNewAssignedMinor: 0,
      toNewAssignedMinor: 1_100,
    });
  });

  it("assign all Ready to Assign", () => {
    const rtaInput: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [txn(CHECKING, "2026-01-02", 10_000, INCOME)],
      splits: [],
      entries: [entry("2026-01", CATEGORY_A, 1_000)],
      categories,
    };
    expect(computeAssignAllReadyToAssign(CATEGORY_B, "2026-01", rtaInput)).toBe(9_000);
  });
});

describe("computeEnvelopePace", () => {
  const input: FinanceBudgetComputationInput = {
    monthKey: "2026-01",
    accounts,
    transactions: [txn(CHECKING, "2026-01-10", -400, CATEGORY_A)],
    splits: [],
    entries: [entry("2026-01", CATEGORY_A, 1_000)],
    categories,
  };

  it("reports spent-vs-elapsed fractions without forecasting", () => {
    const pace = computeEnvelopePace(CATEGORY_A, "2026-01", input, 10, 31);
    expect(pace).toEqual({
      categoryId: CATEGORY_A,
      envelopeMinor: 1_000,
      spentMinor: 400,
      fractionSpent: 0.4,
      fractionElapsed: 10 / 31,
    });
  });

  it("computeEnvelopePaceFromState matches computeEnvelopePace given the same category state", () => {
    const state = computeFinanceBudgetState(input);
    const categoryState = state.categories.find((c) => c.categoryId === CATEGORY_A);
    if (!categoryState) {
      throw new Error("expected category state");
    }
    expect(computeEnvelopePaceFromState(categoryState, 10, 31)).toEqual(
      computeEnvelopePace(CATEGORY_A, "2026-01", input, 10, 31),
    );
  });
});

describe("selectUnbudgetedCategories", () => {
  it("selects categories with activity and no assignment from an already-computed state", () => {
    const input: FinanceBudgetComputationInput = {
      monthKey: "2026-01",
      accounts,
      transactions: [
        txn(CHECKING, "2026-01-05", -500, CATEGORY_A),
        txn(CHECKING, "2026-01-06", -200, CATEGORY_B),
      ],
      splits: [],
      entries: [entry("2026-01", CATEGORY_B, 200)],
      categories,
    };
    const state = computeFinanceBudgetState(input);
    expect(selectUnbudgetedCategories(state)).toEqual([
      expect.objectContaining({ categoryId: CATEGORY_A, activityMinor: -500 }),
    ]);
  });
});
