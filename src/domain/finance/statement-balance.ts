// Pure arithmetic for "use the latest statement as the account's starting balance".
// See docs/finance.md "Statement import". No I/O.
//
// The app derives every balance as `openingBalanceMinor + Σ transactions`. A statement
// closing balance is therefore applied by re-basing the opening balance so the derived balance
// *as of the statement date* equals the statement — later transactions then flow on top of it.

import type { FinanceAccountType } from "../finance";

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

const MARKER_PATTERN = /\b(?:CR|DR)\s*$/i;

/** True when the typed/printed balance ends with a CR / DR marker. */
export const hasStatementAmountMarker = (input: string): boolean =>
  MARKER_PATTERN.test(input.trim());

/**
 * Converts the balance field (already parsed to `parsedMinor`) into the account's signed balance.
 * A CR / DR marker states the direction explicitly — `CR` is in the customer's favour (positive
 * balance), `DR` is owed (negative) — for assets and liabilities alike, so it is used as parsed.
 * Without a marker the printed convention applies (`statementAmountToAccountBalanceMinor`).
 */
export const statementInputToAccountBalanceMinor = (
  accountType: FinanceAccountType,
  input: string,
  parsedMinor: number,
): number =>
  hasStatementAmountMarker(input)
    ? parsedMinor
    : statementAmountToAccountBalanceMinor(accountType, parsedMinor);
