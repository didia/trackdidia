// Pure month cash-flow arithmetic. See specs/done/finance.md "Phase 6". No I/O.
//
// Transfers and `excludedFromReports` rows are left out entirely (unlike the
// budget's `balanceTransactions`, cash flow is a reporting view, not a stock
// balance). Splits are expanded once per the split aggregation rule:
// `hasSplits` → each split contributes on its own, the parent never does.

import { getMonthEndDate, getMonthStartDate } from "../monthly-review";
import type { FinanceTransaction, FinanceTransactionSplit } from "../finance";

export type FinanceCashFlowTransactionInput = Pick<
  FinanceTransaction,
  | "id"
  | "postedDate"
  | "amountMinor"
  | "currency"
  | "isTransfer"
  | "excludedFromReports"
  | "hasSplits"
>;

export type FinanceCashFlowSplitInput = Pick<
  FinanceTransactionSplit,
  "transactionId" | "amountMinor"
>;

export interface FinanceCashFlowComputationInput {
  monthKey: string;
  baseCurrency: string;
  transactions: FinanceCashFlowTransactionInput[];
  splits: FinanceCashFlowSplitInput[];
}

export interface FinanceCashFlowSummary {
  monthKey: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

/** Expands `hasSplits` transactions into their splits; everything else is a single line. */
const buildCashFlowLines = (input: FinanceCashFlowComputationInput): number[] => {
  const monthStart = getMonthStartDate(input.monthKey);
  const monthEnd = getMonthEndDate(input.monthKey);
  const splitsByTransactionId = new Map<string, number[]>();
  for (const split of input.splits) {
    const bucket = splitsByTransactionId.get(split.transactionId);
    if (bucket) {
      bucket.push(split.amountMinor);
    } else {
      splitsByTransactionId.set(split.transactionId, [split.amountMinor]);
    }
  }

  const lines: number[] = [];
  for (const txn of input.transactions) {
    if (txn.isTransfer || txn.excludedFromReports || txn.currency !== input.baseCurrency) {
      continue;
    }
    if (txn.postedDate < monthStart || txn.postedDate > monthEnd) {
      continue;
    }
    if (txn.hasSplits) {
      for (const amountMinor of splitsByTransactionId.get(txn.id) ?? []) {
        lines.push(amountMinor);
      }
    } else {
      lines.push(txn.amountMinor);
    }
  }
  return lines;
};

/** Income/expense/net for one month, splits expanded, transfers and `excludedFromReports` honored. */
export const computeFinanceCashFlow = (
  input: FinanceCashFlowComputationInput,
): FinanceCashFlowSummary => {
  const lines = buildCashFlowLines(input);
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const amountMinor of lines) {
    if (amountMinor > 0) {
      incomeMinor += amountMinor;
    } else if (amountMinor < 0) {
      expenseMinor += -amountMinor;
    }
  }
  return {
    monthKey: input.monthKey,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
  };
};
