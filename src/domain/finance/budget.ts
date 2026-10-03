// Pure YNAB-style envelope budget arithmetic. See specs/done/finance.md
// "Budget model". No I/O. Rollover is always recomputed here, never stored —
// the repository's job is only to load the input shape described below and
// hand it to one of these functions, exactly like `computeWeeklyReviewSummary`.

import { UNCATEGORIZED_CATEGORY_ID } from "../../lib/finance/classify";
import { getMonthEndDate, getMonthKey, getPreviousMonthKey } from "../monthly-review";
import type {
  FinanceAccount,
  FinanceBudgetEntry,
  FinanceCategory,
  FinanceOverspendPolicy,
  FinanceTransaction,
  FinanceTransactionSplit,
} from "../finance";

export type FinanceBudgetAccountInput = Pick<
  FinanceAccount,
  "id" | "onBudget" | "openingBalanceMinor"
>;

export type FinanceBudgetTransactionInput = Pick<
  FinanceTransaction,
  "id" | "accountId" | "postedDate" | "amountMinor" | "categoryId" | "hasSplits"
>;

export type FinanceBudgetSplitInput = Pick<
  FinanceTransactionSplit,
  "transactionId" | "amountMinor" | "categoryId"
>;

/** Every transaction on an on-budget account, regardless of `excludedFromBudget` — see below. */
export type FinanceBudgetBalanceTransactionInput = Pick<
  FinanceTransaction,
  "accountId" | "postedDate" | "amountMinor"
>;

export type FinanceBudgetCategoryInput = Pick<FinanceCategory, "id" | "kind" | "defersToNextMonth">;

/**
 * The single input shape every pure function below takes. Both storage
 * implementations load the same rows and hand them to the same function —
 * never a SQL `GROUP BY` in one and a JS reduce in the other.
 *
 * `transactions` must already be restricted by the caller to on-budget
 * accounts, `excluded_from_budget = 0`, from the first budgeted month
 * through the end of `monthKey` (see "Computation shape" in the spec) — it
 * drives per-category `activity`/`available`. `balanceTransactions` is a
 * *separate* array: every transaction on an on-budget account through the
 * end of `monthKey`, **regardless of `excluded_from_budget`** — per the
 * spec, `onBudgetBalance = opening + Σ ALL transactions`, so a transfer
 * (which is deliberately excluded from `activity`) must still move money in
 * and out of the real account balance. `entries` is every budget entry for
 * every month, past and future — the "Σ assigned in months > M" term needs
 * entries after `monthKey`.
 */
export interface FinanceBudgetComputationInput {
  monthKey: string;
  accounts: FinanceBudgetAccountInput[];
  transactions: FinanceBudgetTransactionInput[];
  balanceTransactions: FinanceBudgetBalanceTransactionInput[];
  splits: FinanceBudgetSplitInput[];
  entries: FinanceBudgetEntry[];
  categories: FinanceBudgetCategoryInput[];
}

interface SeriesPoint {
  assignedMinor: number;
  activityMinor: number;
  carryInMinor: number;
  availableMinor: number;
}

/** Integer month-key arithmetic — no `Date`/timezone involvement. */
export const addMonthsToMonthKey = (monthKey: string, delta: number): string => {
  const [yearStr, monthStr] = monthKey.split("-");
  const index = Number(yearStr) * 12 + (Number(monthStr) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = index % 12;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
};

/** The earliest month present in either activity or budget entries — the "first budgeted month". */
const getEarliestMonthKey = (input: FinanceBudgetComputationInput): string => {
  let earliest: string | null = null;
  for (const txn of input.transactions) {
    const month = getMonthKey(txn.postedDate);
    if (earliest === null || month < earliest) {
      earliest = month;
    }
  }
  for (const entry of input.entries) {
    if (earliest === null || entry.monthKey < earliest) {
      earliest = entry.monthKey;
    }
  }
  return earliest ?? input.monthKey;
};

/**
 * Splits-expanded activity rows: a `has_splits` transaction contributes its
 * splits (each to its own category) and never its parent row; every other
 * transaction contributes once, in full. See "Split aggregation rule".
 */
const buildActivityByCategoryMonth = (
  input: FinanceBudgetComputationInput,
): Map<string, Map<string, number>> => {
  const splitsByTransactionId = new Map<string, FinanceBudgetSplitInput[]>();
  for (const split of input.splits) {
    const bucket = splitsByTransactionId.get(split.transactionId);
    if (bucket) {
      bucket.push(split);
    } else {
      splitsByTransactionId.set(split.transactionId, [split]);
    }
  }

  const byCategory = new Map<string, Map<string, number>>();
  const add = (categoryId: string | null, monthKey: string, amountMinor: number) => {
    const resolvedCategoryId = categoryId ?? UNCATEGORIZED_CATEGORY_ID;
    let byMonth = byCategory.get(resolvedCategoryId);
    if (!byMonth) {
      byMonth = new Map();
      byCategory.set(resolvedCategoryId, byMonth);
    }
    byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + amountMinor);
  };

  for (const txn of input.transactions) {
    const monthKey = getMonthKey(txn.postedDate);
    if (txn.hasSplits) {
      const splits = splitsByTransactionId.get(txn.id) ?? [];
      for (const split of splits) {
        add(split.categoryId, monthKey, split.amountMinor);
      }
    } else {
      add(txn.categoryId, monthKey, txn.amountMinor);
    }
  }

  return byCategory;
};

const getAssignedMinor = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  const entry = input.entries.find(
    (candidate) => candidate.categoryId === categoryId && candidate.monthKey === monthKey,
  );
  return entry?.assignedMinor ?? 0;
};

const getOverspendPolicy = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): FinanceOverspendPolicy => {
  const entry = input.entries.find(
    (candidate) => candidate.categoryId === categoryId && candidate.monthKey === monthKey,
  );
  return entry?.overspendPolicy ?? "reduce_next_ready_to_assign";
};

/**
 * Builds the `assigned`/`activity`/`carryIn`/`available` series for one
 * category, month by month, from the first budgeted month through
 * `targetMonthKey`. `carryIn` for the first budgeted month is always `0`;
 * every later month's `carryIn` is the clamp/pass-through of the previous
 * month's `available` per that previous month's overspend policy.
 */
const computeSeriesUpTo = (
  categoryId: string,
  targetMonthKey: string,
  input: FinanceBudgetComputationInput,
  activityByCategoryMonth: Map<string, Map<string, number>>,
): Map<string, SeriesPoint> => {
  const firstMonth = getEarliestMonthKey(input);
  const lastMonth = targetMonthKey < firstMonth ? firstMonth : targetMonthKey;
  const byMonth = activityByCategoryMonth.get(categoryId);

  const series = new Map<string, SeriesPoint>();
  let monthKey = firstMonth;
  let prevMonthKey: string | null = null;

  while (true) {
    const assignedMinor = getAssignedMinor(categoryId, monthKey, input);
    const activityMinor = byMonth?.get(monthKey) ?? 0;

    let carryInMinor = 0;
    if (prevMonthKey !== null) {
      // prevMonthKey, once set, was `series.set` in the previous iteration.
      const prevPoint = series.get(prevMonthKey) as SeriesPoint;
      if (prevPoint.availableMinor >= 0) {
        carryInMinor = prevPoint.availableMinor;
      } else {
        const policy = getOverspendPolicy(categoryId, prevMonthKey, input);
        carryInMinor = policy === "carry_negative" ? prevPoint.availableMinor : 0;
      }
    }

    const availableMinor = carryInMinor + assignedMinor + activityMinor;
    series.set(monthKey, { assignedMinor, activityMinor, carryInMinor, availableMinor });

    if (monthKey === lastMonth) {
      break;
    }
    prevMonthKey = monthKey;
    monthKey = addMonthsToMonthKey(monthKey, 1);
  }

  return series;
};

const EMPTY_POINT: SeriesPoint = {
  assignedMinor: 0,
  activityMinor: 0,
  carryInMinor: 0,
  availableMinor: 0,
};

/** `activity(cat, month)` — splits-expanded transaction sum, negative for spending. */
export const computeFinanceCategoryActivity = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => buildActivityByCategoryMonth(input).get(categoryId)?.get(monthKey) ?? 0;

/** `available(cat, month) = carryIn + assigned + activity`. */
export const computeFinanceCategoryAvailable = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  const activityMap = buildActivityByCategoryMonth(input);
  const series = computeSeriesUpTo(categoryId, monthKey, input, activityMap);
  return (series.get(monthKey) ?? EMPTY_POINT).availableMinor;
};

/** `carryIn(cat, month)` per the overspend policy of the previous month's entry. */
export const computeFinanceCategoryCarryIn = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  const activityMap = buildActivityByCategoryMonth(input);
  const series = computeSeriesUpTo(categoryId, monthKey, input, activityMap);
  return (series.get(monthKey) ?? EMPTY_POINT).carryInMinor;
};

/**
 * `onBudgetBalance = opening + Σ ALL transactions`, summed across on-budget
 * accounts, up to end of month — using `balanceTransactions`, not
 * `transactions`, so an `excluded_from_budget` transfer still moves money.
 */
export const computeFinanceOnBudgetBalance = (
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  const monthEnd = getMonthEndDate(monthKey);
  const onBudgetAccountIds = new Set(
    input.accounts.filter((account) => account.onBudget).map((account) => account.id),
  );

  let total = 0;
  for (const account of input.accounts) {
    if (account.onBudget) {
      total += account.openingBalanceMinor;
    }
  }
  for (const txn of input.balanceTransactions) {
    if (onBudgetAccountIds.has(txn.accountId) && txn.postedDate <= monthEnd) {
      total += txn.amountMinor;
    }
  }
  return total;
};

const computeDeferredIncomeInternal = (
  monthKey: string,
  input: FinanceBudgetComputationInput,
  activityByCategoryMonth: Map<string, Map<string, number>>,
): number => {
  if (monthKey < getEarliestMonthKey(input)) {
    return 0;
  }
  let total = 0;
  for (const category of input.categories) {
    if (category.kind === "income" && category.defersToNextMonth) {
      const activity = activityByCategoryMonth.get(category.id)?.get(monthKey) ?? 0;
      total += Math.max(0, activity);
    }
  }
  return total;
};

/** `deferredIncome(M)` — positive activity of income-for-next-month categories in `M`. */
export const computeFinanceDeferredIncome = (
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => computeDeferredIncomeInternal(monthKey, input, buildActivityByCategoryMonth(input));

export interface FinanceBudgetCategoryState {
  categoryId: string;
  assignedMinor: number;
  activityMinor: number;
  carryInMinor: number;
  availableMinor: number;
  overspendPolicy: FinanceOverspendPolicy;
  /** "Assign last month's amount" quick action — the amount it would assign. */
  lastMonthAssignedMinor: number;
  /** "Assign average of last 3 months" quick action — the amount it would assign. */
  average3MonthsAssignedMinor: number;
  /** "Assign all Ready to Assign" quick action — the category's new total assignment. */
  assignAllReadyToAssignMinor: number;
}

export interface FinanceBudgetState {
  monthKey: string;
  onBudgetBalanceMinor: number;
  readyToAssignMinor: number;
  categories: FinanceBudgetCategoryState[];
}

/**
 * `readyToAssign(M) = onBudgetBalance(end of M) − Σ available(expense cats, M)
 *  − Σ assigned(m > M) − deferredIncome(M)`.
 *
 * There is no `+ deferredIncome(M − 1)` release term: `onBudgetBalance` is a
 * stock (the account balance at a point in time), not a flow, so the money
 * held back from `M − 1` is still sitting in that same balance at the end of
 * `M` with no further adjustment needed — adding `deferredIncome(M − 1)`
 * back in would double-count it.
 */
export const computeFinanceReadyToAssign = (
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => computeFinanceBudgetState({ ...input, monthKey }).readyToAssignMinor;

/** Envelope grid + Ready to Assign for one month — the one function both repositories call. */
export const computeFinanceBudgetState = (
  input: FinanceBudgetComputationInput,
): FinanceBudgetState => {
  const { monthKey } = input;
  const activityMap = buildActivityByCategoryMonth(input);
  const expenseCategories = input.categories.filter((category) => category.kind === "expense");

  const basePoints = expenseCategories.map((category) => {
    const series = computeSeriesUpTo(category.id, monthKey, input, activityMap);
    const point = series.get(monthKey) ?? EMPTY_POINT;
    return { category, point };
  });

  const onBudgetBalanceMinor = computeFinanceOnBudgetBalance(monthKey, input);
  const sumAvailable = basePoints.reduce((total, { point }) => total + point.availableMinor, 0);
  const sumFutureAssigned = input.entries.reduce(
    (total, entry) => total + (entry.monthKey > monthKey ? entry.assignedMinor : 0),
    0,
  );
  const deferredThisMonth = computeDeferredIncomeInternal(monthKey, input, activityMap);

  const readyToAssignMinor =
    onBudgetBalanceMinor - sumAvailable - sumFutureAssigned - deferredThisMonth;

  const categories: FinanceBudgetCategoryState[] = basePoints.map(({ category, point }) => ({
    categoryId: category.id,
    assignedMinor: point.assignedMinor,
    activityMinor: point.activityMinor,
    carryInMinor: point.carryInMinor,
    availableMinor: point.availableMinor,
    overspendPolicy: getOverspendPolicy(category.id, monthKey, input),
    lastMonthAssignedMinor: computeAssignLastMonthAmount(category.id, monthKey, input),
    average3MonthsAssignedMinor: computeAssignAverageLast3MonthsAmount(
      category.id,
      monthKey,
      input,
    ),
    assignAllReadyToAssignMinor: point.assignedMinor + Math.max(0, readyToAssignMinor),
  }));

  return { monthKey, onBudgetBalanceMinor, readyToAssignMinor, categories };
};

/**
 * Rejects an assignment to an income-kind category: it is reached by neither
 * side of the `onBudgetBalance` invariant (income flows into Ready to Assign
 * through `onBudgetBalance` directly, never through an envelope).
 */
export const assertFinanceCategoryAssignable = (
  category: Pick<FinanceCategory, "id" | "kind">,
): void => {
  if (category.kind === "income") {
    throw new Error(`cannot assign budget money to an income category: ${category.id}`);
  }
};

// --- Quick actions (YNAB parity) -------------------------------------------------------------

/** "Assign last month's amount." */
export const computeAssignLastMonthAmount = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => getAssignedMinor(categoryId, getPreviousMonthKey(monthKey), input);

/** "Assign average of last 3 months", rounded to the nearest minor unit. */
export const computeAssignAverageLast3MonthsAmount = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  let sum = 0;
  let cursor = monthKey;
  for (let i = 0; i < 3; i += 1) {
    cursor = getPreviousMonthKey(cursor);
    sum += getAssignedMinor(categoryId, cursor, input);
  }
  return Math.round(sum / 3);
};

export interface CoverOverspendingResult {
  /** The amount actually movable: capped at both the deficit and the source's available. */
  amountMinor: number;
  fromNewAssignedMinor: number;
  toNewAssignedMinor: number;
}

/** "Cover overspending from another category" — moves `amountMinor` of assignment, never activity. */
export const computeCoverOverspending = (
  fromCategoryId: string,
  toCategoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): CoverOverspendingResult => {
  const toAvailable = computeFinanceCategoryAvailable(toCategoryId, monthKey, input);
  const deficit = toAvailable < 0 ? -toAvailable : 0;
  const fromAvailable = computeFinanceCategoryAvailable(fromCategoryId, monthKey, input);
  const amountMinor = Math.max(0, Math.min(deficit, fromAvailable));
  const fromAssigned = getAssignedMinor(fromCategoryId, monthKey, input);
  const toAssigned = getAssignedMinor(toCategoryId, monthKey, input);
  return {
    amountMinor,
    fromNewAssignedMinor: fromAssigned - amountMinor,
    toNewAssignedMinor: toAssigned + amountMinor,
  };
};

/** "Assign all Ready to Assign" to one category — the new total assignment for that category. */
export const computeAssignAllReadyToAssign = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
): number => {
  const readyToAssignMinor = computeFinanceReadyToAssign(monthKey, input);
  const assignedMinor = getAssignedMinor(categoryId, monthKey, input);
  return assignedMinor + Math.max(0, readyToAssignMinor);
};

export interface UnbudgetedCategoryActivity {
  categoryId: string;
  activityMinor: number;
}

/**
 * "Non budgété" band — every expense category with activity this month and
 * no assignment. Assigning `0` deletes the budget entry row (see
 * `assertFinanceCategoryAssignable`'s caller), so `assignedMinor === 0`
 * always means "never assigned", not "assigned to zero".
 */
export const listUnbudgetedCategoryActivity = (
  monthKey: string,
  input: FinanceBudgetComputationInput,
): UnbudgetedCategoryActivity[] => {
  const activityMap = buildActivityByCategoryMonth(input);
  const result: UnbudgetedCategoryActivity[] = [];
  for (const category of input.categories) {
    if (category.kind !== "expense") {
      continue;
    }
    const assignedMinor = getAssignedMinor(category.id, monthKey, input);
    const activityMinor = activityMap.get(category.id)?.get(monthKey) ?? 0;
    if (assignedMinor === 0 && activityMinor !== 0) {
      result.push({ categoryId: category.id, activityMinor });
    }
  }
  return result;
};

/** The one-click "Assigner" amount for an unbudgeted category — the positive size of its activity. */
export const computeUnbudgetedAssignAmountMinor = (activityMinor: number): number =>
  Math.abs(activityMinor);

/** Every category in `state.categories` with activity and no assignment — the "Non budgété" band. */
export const selectUnbudgetedCategories = (
  state: Pick<FinanceBudgetState, "categories">,
): FinanceBudgetCategoryState[] =>
  state.categories.filter(
    (category) => category.assignedMinor === 0 && category.activityMinor !== 0,
  );

export interface FinanceEnvelopePace {
  categoryId: string;
  /** `assigned(cat, M) + carryIn(cat, M)` — the budget for the month, not the remaining available. */
  envelopeMinor: number;
  /** Positive magnitude of this month's spending so far. */
  spentMinor: number;
  /** `0` when the envelope is `<= 0` (unbudgeted — see "Non budgété"). */
  fractionSpent: number;
  fractionElapsed: number;
}

const buildEnvelopePace = (
  categoryId: string,
  assignedMinor: number,
  carryInMinor: number,
  activityMinor: number,
  elapsedDays: number,
  totalDays: number,
): FinanceEnvelopePace => {
  const envelopeMinor = assignedMinor + carryInMinor;
  const spentMinor = activityMinor < 0 ? -activityMinor : 0;
  const fractionSpent = envelopeMinor > 0 ? spentMinor / envelopeMinor : 0;
  const fractionElapsed = totalDays > 0 ? Math.min(1, Math.max(0, elapsedDays / totalDays)) : 0;
  return { categoryId, envelopeMinor, spentMinor, fractionSpent, fractionElapsed };
};

/**
 * Simple spent-vs-elapsed pace, no forecasting (that is `src/domain/finance/forecast.ts`,
 * a later phase). Used to render "day 10 of 30, 40% of envelope spent" in the budget grid.
 */
export const computeEnvelopePace = (
  categoryId: string,
  monthKey: string,
  input: FinanceBudgetComputationInput,
  elapsedDays: number,
  totalDays: number,
): FinanceEnvelopePace =>
  buildEnvelopePace(
    categoryId,
    getAssignedMinor(categoryId, monthKey, input),
    computeFinanceCategoryCarryIn(categoryId, monthKey, input),
    computeFinanceCategoryActivity(categoryId, monthKey, input),
    elapsedDays,
    totalDays,
  );

/**
 * Same pace calculation, but reads `assignedMinor`/`carryInMinor`/`activityMinor` off an
 * already-computed `FinanceBudgetCategoryState` instead of the raw input — what the budget
 * page uses, since it already holds `computeFinanceBudgetState`'s result.
 */
export const computeEnvelopePaceFromState = (
  category: FinanceBudgetCategoryState,
  elapsedDays: number,
  totalDays: number,
): FinanceEnvelopePace =>
  buildEnvelopePace(
    category.categoryId,
    category.assignedMinor,
    category.carryInMinor,
    category.activityMinor,
    elapsedDays,
    totalDays,
  );
