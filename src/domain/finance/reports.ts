// Pure reporting engines: category/merchant/person spend, trend, and
// month-over-month comparison. See specs/done/finance.md "Phase 6". No I/O.
//
// Every report starts from `buildFinanceReportLines`, which applies the one
// split aggregation rule (`hasSplits` → splits, parent excluded), drops
// transfers and `excludedFromReports` rows, and drops non-base-currency
// accounts (see AGENTS.md "cross-account rollups"). Both repositories load
// the same transactions/splits/categories and call the same functions here —
// never a SQL `GROUP BY` in one and a JS reduce in the other.

import { getWeekStartSunday } from "../../lib/gtd/shared";
import { UNCATEGORIZED_CATEGORY_ID } from "../../lib/finance/classify";
import { getMonthKey } from "../monthly-review";
import type { FinanceCategory, FinanceTransaction, FinanceTransactionSplit } from "../finance";

export interface FinanceDateRange {
  from: string;
  to: string;
}

export type FinanceReportGroupBy = "category" | "group";

export type FinanceReportTransactionInput = Pick<
  FinanceTransaction,
  | "id"
  | "postedDate"
  | "amountMinor"
  | "currency"
  | "categoryId"
  | "merchantKey"
  | "merchantDisplay"
  | "personId"
  | "isTransfer"
  | "excludedFromReports"
  | "hasSplits"
>;

export type FinanceReportSplitInput = Pick<
  FinanceTransactionSplit,
  "id" | "transactionId" | "amountMinor" | "categoryId"
>;

export type FinanceReportCategoryInput = Pick<FinanceCategory, "id" | "parentId" | "name">;

export interface FinanceReportComputationInput {
  baseCurrency: string;
  transactions: FinanceReportTransactionInput[];
  splits: FinanceReportSplitInput[];
  categories: FinanceReportCategoryInput[];
}

/**
 * One expanded, filtered line of report-eligible activity. `lineId` is the
 * split id for a split line, or the transaction id otherwise, so every line
 * has a stable identity distinct from its parent transaction.
 */
export interface FinanceReportLine {
  lineId: string;
  transactionId: string;
  postedDate: string;
  amountMinor: number;
  categoryId: string | null;
  merchantKey: string;
  merchantDisplay: string | null;
  personId: string | null;
}

export const buildFinanceReportLines = (
  input: FinanceReportComputationInput,
): FinanceReportLine[] => {
  const splitsByTransactionId = new Map<string, FinanceReportSplitInput[]>();
  for (const split of input.splits) {
    const bucket = splitsByTransactionId.get(split.transactionId);
    if (bucket) {
      bucket.push(split);
    } else {
      splitsByTransactionId.set(split.transactionId, [split]);
    }
  }

  const lines: FinanceReportLine[] = [];
  for (const txn of input.transactions) {
    if (txn.isTransfer || txn.excludedFromReports || txn.currency !== input.baseCurrency) {
      continue;
    }
    if (txn.hasSplits) {
      for (const split of splitsByTransactionId.get(txn.id) ?? []) {
        lines.push({
          lineId: split.id,
          transactionId: txn.id,
          postedDate: txn.postedDate,
          amountMinor: split.amountMinor,
          categoryId: split.categoryId,
          merchantKey: txn.merchantKey,
          merchantDisplay: txn.merchantDisplay,
          personId: txn.personId,
        });
      }
    } else {
      lines.push({
        lineId: txn.id,
        transactionId: txn.id,
        postedDate: txn.postedDate,
        amountMinor: txn.amountMinor,
        categoryId: txn.categoryId,
        merchantKey: txn.merchantKey,
        merchantDisplay: txn.merchantDisplay,
        personId: txn.personId,
      });
    }
  }
  return lines;
};

export const filterFinanceReportLinesByRange = (
  lines: FinanceReportLine[],
  range: FinanceDateRange,
): FinanceReportLine[] =>
  lines.filter((line) => line.postedDate >= range.from && line.postedDate <= range.to);

/**
 * `group` resolves a category to its parent group id, or itself when it has
 * no parent. A `null` `categoryId` maps to the real `fincat:non-categorise`
 * system category — never a bare literal — so the UI resolves its name the
 * same way it resolves every other category, through
 * `listFinanceCategories()`, instead of needing a special-cased label.
 */
const resolveGroupKey = (
  categoryId: string | null,
  groupBy: FinanceReportGroupBy,
  categoriesById: Map<string, FinanceReportCategoryInput>,
): string => {
  const resolvedCategoryId = categoryId ?? UNCATEGORIZED_CATEGORY_ID;
  if (groupBy === "category") {
    return resolvedCategoryId;
  }
  const category = categoriesById.get(resolvedCategoryId);
  return category?.parentId ?? resolvedCategoryId;
};

export interface FinanceCategorySpendRow {
  key: string;
  groupBy: FinanceReportGroupBy;
  totalMinor: number;
  lineIds: string[];
}

/** Spend only (negative lines), grouped by category or category group, with rollup. */
export const computeFinanceCategorySpend = (
  input: FinanceReportComputationInput,
  range: FinanceDateRange,
  groupBy: FinanceReportGroupBy,
): FinanceCategorySpendRow[] => {
  const categoriesById = new Map(input.categories.map((category) => [category.id, category]));
  const lines = filterFinanceReportLinesByRange(buildFinanceReportLines(input), range);

  const byKey = new Map<string, { totalMinor: number; lineIds: string[] }>();
  for (const line of lines) {
    if (line.amountMinor >= 0) {
      continue;
    }
    const key = resolveGroupKey(line.categoryId, groupBy, categoriesById);
    const bucket = byKey.get(key) ?? { totalMinor: 0, lineIds: [] };
    bucket.totalMinor += -line.amountMinor;
    bucket.lineIds.push(line.lineId);
    byKey.set(key, bucket);
  }

  return [...byKey.entries()]
    .map(([key, bucket]) => ({
      key,
      groupBy,
      totalMinor: bucket.totalMinor,
      lineIds: bucket.lineIds,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor);
};

/**
 * The exact lines summing to one `FinanceCategorySpendRow.totalMinor` — the
 * drill-down input. The caller hydrates `transactionId`s into full
 * `FinanceTransaction` rows for display.
 */
export const listFinanceCategorySpendDrilldown = (
  input: FinanceReportComputationInput,
  range: FinanceDateRange,
  groupBy: FinanceReportGroupBy,
  key: string,
): FinanceReportLine[] => {
  const categoriesById = new Map(input.categories.map((category) => [category.id, category]));
  const lines = filterFinanceReportLinesByRange(buildFinanceReportLines(input), range);
  return lines.filter(
    (line) =>
      line.amountMinor < 0 && resolveGroupKey(line.categoryId, groupBy, categoriesById) === key,
  );
};

export interface FinanceMerchantSpendRow {
  merchantKey: string;
  merchantDisplay: string | null;
  totalMinor: number;
  lineIds: string[];
}

/** Spend only, grouped by merchant, sorted descending, sliced to `limit`. */
export const computeFinanceMerchantSpend = (
  input: FinanceReportComputationInput,
  range: FinanceDateRange,
  limit: number,
): FinanceMerchantSpendRow[] => {
  const lines = filterFinanceReportLinesByRange(buildFinanceReportLines(input), range);
  const byMerchant = new Map<
    string,
    { merchantDisplay: string | null; totalMinor: number; lineIds: string[] }
  >();
  for (const line of lines) {
    if (line.amountMinor >= 0) {
      continue;
    }
    const bucket = byMerchant.get(line.merchantKey) ?? {
      merchantDisplay: line.merchantDisplay,
      totalMinor: 0,
      lineIds: [],
    };
    bucket.totalMinor += -line.amountMinor;
    bucket.lineIds.push(line.lineId);
    bucket.merchantDisplay = bucket.merchantDisplay ?? line.merchantDisplay;
    byMerchant.set(line.merchantKey, bucket);
  }

  return [...byMerchant.entries()]
    .map(([merchantKey, bucket]) => ({
      merchantKey,
      merchantDisplay: bucket.merchantDisplay,
      totalMinor: bucket.totalMinor,
      lineIds: bucket.lineIds,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, limit);
};

export interface FinancePersonSpendRow {
  personId: string | null;
  totalMinor: number;
  lineIds: string[];
}

/** Spend only, grouped by person (`null` = unassigned). */
export const computeFinancePersonSpend = (
  input: FinanceReportComputationInput,
  range: FinanceDateRange,
): FinancePersonSpendRow[] => {
  const lines = filterFinanceReportLinesByRange(buildFinanceReportLines(input), range);
  const byPerson = new Map<string | null, { totalMinor: number; lineIds: string[] }>();
  for (const line of lines) {
    if (line.amountMinor >= 0) {
      continue;
    }
    const bucket = byPerson.get(line.personId) ?? { totalMinor: 0, lineIds: [] };
    bucket.totalMinor += -line.amountMinor;
    bucket.lineIds.push(line.lineId);
    byPerson.set(line.personId, bucket);
  }
  return [...byPerson.entries()]
    .map(([personId, bucket]) => ({
      personId,
      totalMinor: bucket.totalMinor,
      lineIds: bucket.lineIds,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor);
};

export type FinanceTrendGranularity = "month" | "week";

export interface FinanceTrendPoint {
  periodKey: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

const resolvePeriodKey = (date: string, granularity: FinanceTrendGranularity): string =>
  granularity === "month" ? getMonthKey(date) : getWeekStartSunday(date);

/** Income vs expense per period (month or week), all categories, over `range`. */
export const computeFinanceTrend = (
  input: FinanceReportComputationInput,
  range: FinanceDateRange,
  granularity: FinanceTrendGranularity,
): FinanceTrendPoint[] => {
  const lines = filterFinanceReportLinesByRange(buildFinanceReportLines(input), range);
  const byPeriod = new Map<string, { incomeMinor: number; expenseMinor: number }>();
  for (const line of lines) {
    const periodKey = resolvePeriodKey(line.postedDate, granularity);
    const bucket = byPeriod.get(periodKey) ?? { incomeMinor: 0, expenseMinor: 0 };
    if (line.amountMinor > 0) {
      bucket.incomeMinor += line.amountMinor;
    } else if (line.amountMinor < 0) {
      bucket.expenseMinor += -line.amountMinor;
    }
    byPeriod.set(periodKey, bucket);
  }
  return [...byPeriod.entries()]
    .map(([periodKey, bucket]) => ({
      periodKey,
      incomeMinor: bucket.incomeMinor,
      expenseMinor: bucket.expenseMinor,
      netMinor: bucket.incomeMinor - bucket.expenseMinor,
    }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey));
};

export interface FinanceMonthOverMonthRow {
  key: string;
  groupBy: FinanceReportGroupBy;
  currentMinor: number;
  previousMinor: number;
  deltaMinor: number;
}

/** Per-category (or group) spend comparison between two arbitrary ranges. */
export const computeFinanceMonthOverMonth = (
  input: FinanceReportComputationInput,
  currentRange: FinanceDateRange,
  previousRange: FinanceDateRange,
  groupBy: FinanceReportGroupBy,
): FinanceMonthOverMonthRow[] => {
  const current = computeFinanceCategorySpend(input, currentRange, groupBy);
  const previous = computeFinanceCategorySpend(input, previousRange, groupBy);
  const previousByKey = new Map(previous.map((row) => [row.key, row.totalMinor]));
  const keys = new Set([...current.map((row) => row.key), ...previous.map((row) => row.key)]);

  const currentByKey = new Map(current.map((row) => [row.key, row.totalMinor]));
  return [...keys]
    .map((key) => {
      const currentMinor = currentByKey.get(key) ?? 0;
      const previousMinor = previousByKey.get(key) ?? 0;
      return {
        key,
        groupBy,
        currentMinor,
        previousMinor,
        deltaMinor: currentMinor - previousMinor,
      };
    })
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor));
};
