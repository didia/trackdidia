// Pure arithmetic for "use the latest statement as the account's starting balance".
// See docs/finance.md "Statement import". No I/O.
//
// The app derives every balance as `openingBalanceMinor + Σ transactions`. A statement
// closing balance is therefore applied by re-basing the opening balance so the derived balance
// *as of the statement date* equals the statement — later transactions then flow on top of it.

import type { FinanceAccountType, FinanceTransaction } from "../finance";

const LIABILITY_TYPES: ReadonlySet<FinanceAccountType> = new Set([
  "credit_card",
  "line_of_credit",
  "loan",
  "mortgage",
]);

export const isLiabilityAccountType = (type: FinanceAccountType): boolean =>
  LIABILITY_TYPES.has(type);

/**
 * Converts the amount as printed on a statement into the account's signed balance. A liability
 * statement prints what is owed as a positive number ("Nouveau solde 1 234,56 $"), whereas the
 * app stores liabilities as negative balances; a printed credit (negative / CR) becomes positive.
 */
export const statementAmountToAccountBalanceMinor = (
  accountType: FinanceAccountType,
  printedMinor: number,
): number => (isLiabilityAccountType(accountType) ? -printedMinor : printedMinor);

/**
 * The opening balance that makes `opening + Σ(transactions posted on or before statementDate)`
 * equal `statementBalanceMinor`. Transactions strictly after the statement date are untouched.
 */
export const computeOpeningBalanceForStatement = (
  statementBalanceMinor: number,
  statementDate: string,
  transactions: Pick<FinanceTransaction, "postedDate" | "amountMinor">[],
): number =>
  statementBalanceMinor -
  transactions.reduce(
    (total, txn) => (txn.postedDate <= statementDate ? total + txn.amountMinor : total),
    0,
  );
