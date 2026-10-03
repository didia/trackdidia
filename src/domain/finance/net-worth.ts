// Pure net-worth arithmetic. See specs/done/finance.md "Phase 6". No I/O.
//
// Net worth counts every account regardless of `onBudget`/`excludedFromBudget` —
// those flags are budget-only exclusions and must never remove money from net
// worth (see AGENTS.md "Repository parity" / the net-worth balance rule). The
// only exclusion here is currency: an account whose currency differs from the
// household's base currency is left out of the assets/liabilities totals and
// surfaced instead in `excludedCurrencies`, so the caller can show a banner.

import type { FinanceAccount, FinanceAccountType } from "../finance";

export type FinanceNetWorthAccountKind = "asset" | "liability";

const LIABILITY_ACCOUNT_TYPES = new Set<FinanceAccountType>([
  "credit_card",
  "line_of_credit",
  "loan",
  "mortgage",
]);

export const classifyFinanceAccountKind = (type: FinanceAccountType): FinanceNetWorthAccountKind =>
  LIABILITY_ACCOUNT_TYPES.has(type) ? "liability" : "asset";

export type FinanceNetWorthAccountInput = Pick<
  FinanceAccount,
  "id" | "type" | "currency" | "closed" | "openingBalanceMinor"
>;

export interface FinanceNetWorthTransactionInput {
  accountId: string;
  postedDate: string;
  amountMinor: number;
}

/**
 * `balances` must be every transaction on every account (regardless of
 * `excludedFromBudget`/`excludedFromReports`/`onBudget`) up to and including
 * `asOfDate` — the balance/net-worth rule in AGENTS.md. Both repositories
 * load the same rows and hand them to `computeFinanceNetWorth`.
 */
export interface FinanceNetWorthComputationInput {
  asOfDate: string;
  baseCurrency: string;
  accounts: FinanceNetWorthAccountInput[];
  transactions: FinanceNetWorthTransactionInput[];
}

export interface FinanceNetWorthAccountLine {
  accountId: string;
  type: FinanceAccountType;
  kind: FinanceNetWorthAccountKind;
  currency: string;
  balanceMinor: number;
  /** `false` when `currency !== baseCurrency` — excluded from the totals below. */
  includedInTotal: boolean;
}

export interface FinanceNetWorthSnapshot {
  asOfDate: string;
  baseCurrency: string;
  /** Sum of asset-kind account balances in `baseCurrency` only. */
  assetsMinor: number;
  /** Positive magnitude owed across liability-kind accounts in `baseCurrency` only. */
  liabilitiesMinor: number;
  netWorthMinor: number;
  accounts: FinanceNetWorthAccountLine[];
  /** Distinct non-base currencies present among accounts, excluded from the totals. */
  excludedCurrencies: string[];
}

const computeAccountBalanceMinor = (
  account: FinanceNetWorthAccountInput,
  transactions: FinanceNetWorthTransactionInput[],
  asOfDate: string,
): number => {
  let balance = account.openingBalanceMinor;
  for (const txn of transactions) {
    if (txn.accountId === account.id && txn.postedDate <= asOfDate) {
      balance += txn.amountMinor;
    }
  }
  return balance;
};

/** Assets minus liabilities, as of `asOfDate`, split by account type. Off-budget accounts included. */
export const computeFinanceNetWorth = (
  input: FinanceNetWorthComputationInput,
): FinanceNetWorthSnapshot => {
  const { asOfDate, baseCurrency } = input;
  let assetsMinor = 0;
  let liabilitiesMinor = 0;
  const excludedCurrencies = new Set<string>();

  const accounts: FinanceNetWorthAccountLine[] = input.accounts.map((account) => {
    const kind = classifyFinanceAccountKind(account.type);
    const balanceMinor = computeAccountBalanceMinor(account, input.transactions, asOfDate);
    const includedInTotal = account.currency === baseCurrency;

    if (includedInTotal) {
      if (kind === "asset") {
        assetsMinor += balanceMinor;
      } else {
        liabilitiesMinor += -balanceMinor;
      }
    } else {
      excludedCurrencies.add(account.currency);
    }

    return {
      accountId: account.id,
      type: account.type,
      kind,
      currency: account.currency,
      balanceMinor,
      includedInTotal,
    };
  });

  return {
    asOfDate,
    baseCurrency,
    assetsMinor,
    liabilitiesMinor,
    netWorthMinor: assetsMinor - liabilitiesMinor,
    accounts,
    excludedCurrencies: [...excludedCurrencies].sort(),
  };
};

export interface FinanceNetWorthHistoryPoint {
  asOfDate: string;
  netWorthMinor: number;
}

/** Builds a net-worth-over-time series from daily `finance_account_balance_snapshots`. */
export const buildFinanceNetWorthHistory = (
  snapshots: Array<{ accountId: string; asOfDate: string; balanceMinor: number }>,
  accounts: FinanceNetWorthAccountInput[],
  baseCurrency: string,
): FinanceNetWorthHistoryPoint[] => {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const byDate = new Map<string, number>();

  // A liability account's balance is conventionally already negative (money
  // owed), so a plain sum of raw balances across all accounts is net worth —
  // no sign flip by kind, matching `computeFinanceNetWorth`'s
  // `assetsMinor - liabilitiesMinor` (liabilitiesMinor there is a positive
  // magnitude obtained by negating the raw, already-negative balance).
  for (const snapshot of snapshots) {
    const account = accountById.get(snapshot.accountId);
    if (!account || account.currency !== baseCurrency) {
      continue;
    }
    byDate.set(snapshot.asOfDate, (byDate.get(snapshot.asOfDate) ?? 0) + snapshot.balanceMinor);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([asOfDate, netWorthMinor]) => ({ asOfDate, netWorthMinor }));
};
