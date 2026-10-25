// Pure "when do I pay, and how much at least" engine for credit cards and lines of credit.
// See docs/finance.md "Credit payment due date and minimum". Balances are derived elsewhere; this
// module only turns a balance and an account's due day into the next due date and a minimum.

import { addMonths, atLocalNoon } from "../../lib/date";
import { currencyExponent } from "../../lib/finance/money";
import type { FinanceAccount, FinanceAccountType } from "../finance";

export const FINANCE_MIN_PAYMENT_DUE_DAY = 1;
export const FINANCE_MAX_PAYMENT_DUE_DAY = 31;

/** Typical Canadian card rule: the greater of a flat floor (10.00) and 3% of the balance owed. */
export const FINANCE_MINIMUM_PAYMENT_RATE = 0.03;
export const FINANCE_MINIMUM_PAYMENT_FLOOR_MAJOR = 10;

/** Days ahead at which a due date is flagged as soon. */
export const FINANCE_PAYMENT_SOON_DAYS = 7;

export type FinanceCreditAccountInput = Pick<
  FinanceAccount,
  "type" | "closed" | "currency" | "paymentDueDay" | "minimumPaymentMinor"
>;

export interface FinanceCreditPaymentDue {
  /** Next local `YYYY-MM-DD` due date (today counts), or null when no due day is set. */
  dueDate: string | null;
  /** Whole local days from today to `dueDate`, or null without a due date. */
  daysUntil: number | null;
  /** Amount currently owed on the account (never negative). */
  owedMinor: number;
  /** Minimum to pay, capped at what is owed; 0 when nothing is owed. */
  minimumMinor: number;
  /** True when the minimum was inferred because the account stores none. */
  minimumIsEstimate: boolean;
}

const CREDIT_TYPES: ReadonlySet<FinanceAccountType> = new Set(["credit_card", "line_of_credit"]);

export const isFinanceCreditPaymentAccount = (type: FinanceAccountType): boolean =>
  CREDIT_TYPES.has(type);

/** A stored due day is honoured only when it is a whole number from 1 to 31. */
export const normalizePaymentDueDay = (value: number | null | undefined): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= FINANCE_MIN_PAYMENT_DUE_DAY &&
  value <= FINANCE_MAX_PAYMENT_DUE_DAY
    ? value
    : null;

/** A stored minimum is honoured only when it is a positive whole number of minor units. */
export const normalizeMinimumPaymentMinor = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

const daysInMonth = (monthKey: string): number => {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(year, month, 0).getDate();
};

const dateInMonth = (monthKey: string, day: number): string =>
  `${monthKey}-${String(Math.min(day, daysInMonth(monthKey))).padStart(2, "0")}`;

const daysBetween = (from: string, to: string): number =>
  Math.round((atLocalNoon(to).getTime() - atLocalNoon(from).getTime()) / 86_400_000);

/**
 * Next occurrence of a monthly due day on or after `today`. A day past the end of a short month
 * (31 in April, 30 in February) falls on that month's last day.
 */
export const computeNextPaymentDueDate = (dueDay: number, today: string): string => {
  const thisMonth = today.slice(0, 7);
  const candidate = dateInMonth(thisMonth, dueDay);
  return candidate >= today ? candidate : dateInMonth(addMonths(thisMonth, 1), dueDay);
};

/** Inferred minimum: max(floor, rate × owed), rounded up to a minor unit, never above `owed`. */
export const inferMinimumPaymentMinor = (owedMinor: number, currency: string): number => {
  if (owedMinor <= 0) {
    return 0;
  }
  const floorMinor = FINANCE_MINIMUM_PAYMENT_FLOOR_MAJOR * 10 ** currencyExponent(currency);
  const rateMinor = Math.ceil(owedMinor * FINANCE_MINIMUM_PAYMENT_RATE);
  return Math.min(owedMinor, Math.max(floorMinor, rateMinor));
};

/**
 * Next payment for a credit card or line of credit. `balanceMinor` is the signed derived balance
 * (negative = owed). Returns null for other account types, closed accounts, and accounts that
 * set neither a due day nor a minimum — an account only shows this once it opts in.
 */
export const computeFinanceCreditPaymentDue = (
  account: FinanceCreditAccountInput,
  balanceMinor: number,
  today: string,
): FinanceCreditPaymentDue | null => {
  if (account.closed || !isFinanceCreditPaymentAccount(account.type)) {
    return null;
  }
  const dueDay = normalizePaymentDueDay(account.paymentDueDay);
  const storedMinimum = normalizeMinimumPaymentMinor(account.minimumPaymentMinor);
  if (dueDay === null && storedMinimum === null) {
    return null;
  }

  const dueDate = dueDay === null ? null : computeNextPaymentDueDate(dueDay, today);
  const owedMinor = Math.max(0, -balanceMinor);
  const minimumMinor =
    storedMinimum === null
      ? inferMinimumPaymentMinor(owedMinor, account.currency)
      : Math.min(storedMinimum, owedMinor);

  return {
    dueDate,
    daysUntil: dueDate === null ? null : daysBetween(today, dueDate),
    owedMinor,
    minimumMinor,
    minimumIsEstimate: storedMinimum === null,
  };
};
