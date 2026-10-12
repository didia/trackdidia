// Pure "which accounts need fresh data" engine. See docs/finance.md
// "Account update tracking". Balances are derived from imported transactions or an
// applied statement, so an account is only as current as the newest of those.

import { atLocalNoon } from "../../lib/date";
import type { FinanceAccount } from "../finance";

/** On-budget accounts drive the weekly budget review; every other account is checked monthly. */
export const FINANCE_BUDGET_ACCOUNT_CADENCE_DAYS = 7;
export const FINANCE_OTHER_ACCOUNT_CADENCE_DAYS = 30;

export type FinanceAccountFreshnessStatus = "fresh" | "due" | "never";

export interface FinanceAccountFreshnessInput {
  account: Pick<
    FinanceAccount,
    "id" | "name" | "institution" | "type" | "onBudget" | "closed" | "updateCadenceDays"
  >;
  /** Newest `posted_date` of any transaction on the account, or null when it has none. */
  latestTransactionDate: string | null;
  /** Newest applied statement date for the account (`source = 'statement'` snapshot), or null. */
  latestStatementDate: string | null;
}

export interface FinanceAccountFreshness {
  accountId: string;
  name: string;
  institution: string | null;
  onBudget: boolean;
  cadenceDays: number;
  /** True when the account carries its own cadence instead of the weekly/monthly default. */
  cadenceIsCustom: boolean;
  /** Newest date the account's data is known to cover; null when nothing was ever loaded. */
  dataThroughDate: string | null;
  dataThroughSource: "transaction" | "statement" | null;
  /** Whole local days between `dataThroughDate` and today; null when `dataThroughDate` is. */
  ageDays: number | null;
  /** Days past the cadence (0 when exactly due, negative when still inside it); null when never loaded. */
  overdueDays: number | null;
  status: FinanceAccountFreshnessStatus;
}

export const FINANCE_MIN_CADENCE_DAYS = 1;
export const FINANCE_MAX_CADENCE_DAYS = 365;

/** A stored override is honoured only when it is a whole number inside the supported range. */
const hasCustomCadence = (account: Pick<FinanceAccount, "updateCadenceDays">): boolean =>
  typeof account.updateCadenceDays === "number" &&
  Number.isInteger(account.updateCadenceDays) &&
  account.updateCadenceDays >= FINANCE_MIN_CADENCE_DAYS &&
  account.updateCadenceDays <= FINANCE_MAX_CADENCE_DAYS;

/** The account's own cadence when it set one, otherwise weekly (on-budget) or monthly. */
export const cadenceDaysForAccount = (
  account: Pick<FinanceAccount, "onBudget" | "updateCadenceDays">,
): number =>
  hasCustomCadence(account)
    ? (account.updateCadenceDays as number)
    : account.onBudget
      ? FINANCE_BUDGET_ACCOUNT_CADENCE_DAYS
      : FINANCE_OTHER_ACCOUNT_CADENCE_DAYS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole local days from `from` to `to`; noon anchoring keeps DST shifts from skewing the count. */
const daysBetween = (from: string, to: string): number =>
  Math.round((atLocalNoon(to).getTime() - atLocalNoon(from).getTime()) / MS_PER_DAY);

/**
 * Freshness of one account at `today`. The newer of the latest transaction date and the
 * latest statement date is the "data through" date. An account is `due` once that date is
 * at least one full cadence old (a Sunday review sees last Sunday's data as due), and
 * `never` when nothing was ever loaded.
 */
export const computeFinanceAccountFreshness = (
  input: FinanceAccountFreshnessInput,
  today: string,
): FinanceAccountFreshness => {
  const { account, latestTransactionDate, latestStatementDate } = input;
  const cadenceDays = cadenceDaysForAccount(account);
  const cadenceIsCustom = hasCustomCadence(account);

  let dataThroughDate: string | null = null;
  let dataThroughSource: FinanceAccountFreshness["dataThroughSource"] = null;
  if (latestTransactionDate) {
    dataThroughDate = latestTransactionDate;
    dataThroughSource = "transaction";
  }
  if (latestStatementDate && (dataThroughDate === null || latestStatementDate > dataThroughDate)) {
    dataThroughDate = latestStatementDate;
    dataThroughSource = "statement";
  }

  if (dataThroughDate === null) {
    return {
      accountId: account.id,
      name: account.name,
      institution: account.institution,
      onBudget: account.onBudget,
      cadenceDays,
      cadenceIsCustom,
      dataThroughDate: null,
      dataThroughSource: null,
      ageDays: null,
      overdueDays: null,
      status: "never",
    };
  }

  // A future-dated row (e.g. a pending posting) never makes an account look younger than today.
  const ageDays = Math.max(0, daysBetween(dataThroughDate, today));
  const overdueDays = ageDays - cadenceDays;
  return {
    accountId: account.id,
    name: account.name,
    institution: account.institution,
    onBudget: account.onBudget,
    cadenceDays,
    cadenceIsCustom,
    dataThroughDate,
    dataThroughSource,
    ageDays,
    overdueDays,
    status: overdueDays >= 0 ? "due" : "fresh",
  };
};

const STATUS_RANK: Record<FinanceAccountFreshnessStatus, number> = {
  due: 0,
  never: 1,
  fresh: 2,
};

/**
 * Freshness for every open account, the ones to update first: budget accounts before the
 * others, then the most overdue, then never-loaded, then fresh accounts oldest-first.
 */
export const computeFinanceAccountsFreshness = (
  inputs: FinanceAccountFreshnessInput[],
  today: string,
): FinanceAccountFreshness[] =>
  inputs
    .filter((input) => !input.account.closed)
    .map((input) => computeFinanceAccountFreshness(input, today))
    .sort((left, right) => {
      if (left.status !== right.status) {
        return STATUS_RANK[left.status] - STATUS_RANK[right.status];
      }
      if (left.onBudget !== right.onBudget) {
        return left.onBudget ? -1 : 1;
      }
      return (
        (right.overdueDays ?? 0) - (left.overdueDays ?? 0) || left.name.localeCompare(right.name)
      );
    });
