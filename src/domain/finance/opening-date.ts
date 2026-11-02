// Pure rule for CSV rows that predate an account's opening balance date. See
// docs/finance.md "Opening balance date": the opening balance is the balance at the START of
// `balanceAsOf`, so a row posted strictly before that date is already inside it and is skipped
// at import (a row on the date itself is kept).

import type { FinanceAccount, FinanceImportRow, FinanceTransaction } from "../finance";

export interface OpeningDateSkip {
  accountId: string;
  /** The account's `balanceAsOf`, the date the rows predate. */
  openingDate: string;
  count: number;
}

export interface OpeningDatePartition {
  /** Rows to import, in their original order. */
  kept: FinanceImportRow[];
  /** One entry per account that lost rows, in first-seen order. */
  skipped: OpeningDateSkip[];
  skippedCount: number;
}

/**
 * Splits import rows into those on or after their account's opening balance date and those
 * strictly before it. An account with no date (`null`/missing, e.g. one created from a
 * statement) never skips anything. Dates are local `YYYY-MM-DD`, so a string comparison is a
 * calendar comparison.
 */
export const partitionRowsByOpeningDate = (
  rows: readonly FinanceImportRow[],
  accounts: ReadonlyMap<string, Pick<FinanceAccount, "balanceAsOf">>,
): OpeningDatePartition => {
  const kept: FinanceImportRow[] = [];
  const skippedByAccount = new Map<string, OpeningDateSkip>();

  for (const row of rows) {
    const openingDate = accounts.get(row.accountId)?.balanceAsOf ?? null;
    if (openingDate === null || openingDate === "" || row.postedDate >= openingDate) {
      kept.push(row);
      continue;
    }
    const existing = skippedByAccount.get(row.accountId);
    if (existing) {
      existing.count += 1;
    } else {
      skippedByAccount.set(row.accountId, { accountId: row.accountId, openingDate, count: 1 });
    }
  }

  const skipped = [...skippedByAccount.values()];
  return {
    kept,
    skipped,
    skippedCount: skipped.reduce((total, entry) => total + entry.count, 0),
  };
};

/**
 * Transactions already stored for an account that predate its opening balance date. They were
 * imported before the import-time skip existed (or before the date was set or moved later) and
 * are counted on top of an opening balance that already includes them. `null` date -> none.
 */
export const selectTransactionsBeforeOpeningDate = <
  T extends Pick<FinanceTransaction, "postedDate">,
>(
  account: Pick<FinanceAccount, "balanceAsOf">,
  transactions: readonly T[],
): T[] => {
  const openingDate = account.balanceAsOf;
  if (openingDate === null || openingDate === "") {
    return [];
  }
  return transactions.filter((txn) => txn.postedDate < openingDate);
};

/** The import-summary warning for one account's skipped rows. */
export const openingDateSkipWarning = (skip: OpeningDateSkip, accountName: string): string =>
  `${skip.count} row(s) for "${accountName}" dated before its opening balance date (${skip.openingDate}) were skipped; the opening balance already includes them.`;
