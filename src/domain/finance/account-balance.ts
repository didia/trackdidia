// Pure derived-balance arithmetic for finance accounts. See
// docs/finance.md "Data model" — current_balance_minor is a reconciliation
// check only; the derived balance is always opening + Σ transactions.

import type { FinanceAccount, FinanceTransaction } from "../finance";

/**
 * Derived balance in minor units: the account's opening balance plus the sum
 * of every (non-excluded by this function's contract: all) transaction on
 * that account. Callers pass exactly the transactions they want summed
 * (e.g. already filtered to the account).
 */
export const computeDerivedBalanceMinor = (
  account: Pick<FinanceAccount, "openingBalanceMinor">,
  transactions: Pick<FinanceTransaction, "amountMinor">[],
): number =>
  transactions.reduce((total, txn) => total + txn.amountMinor, account.openingBalanceMinor);

export interface ReconciliationDiscrepancy {
  derivedBalanceMinor: number;
  currentBalanceMinor: number;
  differenceMinor: number;
}

/**
 * Compares the derived balance against the account's manually-entered
 * `currentBalanceMinor` reconciliation check. Returns null when there is
 * nothing to reconcile (no manual balance set) or the two agree.
 */
export const computeReconciliationDiscrepancy = (
  account: Pick<FinanceAccount, "openingBalanceMinor" | "currentBalanceMinor">,
  transactions: Pick<FinanceTransaction, "amountMinor">[],
): ReconciliationDiscrepancy | null => {
  if (account.currentBalanceMinor === null) {
    return null;
  }

  const derivedBalanceMinor = computeDerivedBalanceMinor(account, transactions);
  const differenceMinor = account.currentBalanceMinor - derivedBalanceMinor;

  if (differenceMinor === 0) {
    return null;
  }

  return {
    derivedBalanceMinor,
    currentBalanceMinor: account.currentBalanceMinor,
    differenceMinor,
  };
};
