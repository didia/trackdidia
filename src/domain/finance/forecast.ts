// Pure proactive runout forecasting. See specs/todo/finance.md "Proactive
// runout forecasting". No I/O; `today` is injected via `FinanceSnapshot` so
// tests are deterministic. Both repository implementations load the same
// rows (via `buildFinanceSnapshot`) and hand them to `computeFinanceForecast`
// — never a SQL aggregate in one and a JS reduce in the other.

import type { AppSettings } from "../types";
import { UNCATEGORIZED_CATEGORY_ID } from "../../lib/finance/classify";
import { addDays } from "../../lib/gtd/shared";
import { addMonthsClamped } from "../../lib/finance/recurring-detection";
import { addMonthsToMonthKey, type FinanceBudgetState } from "./budget";
import { getMonthEndDate, getMonthKey } from "../monthly-review";
import type { FinanceAccount, FinanceRecurringCadence } from "../finance";

// --- Input shapes -----------------------------------------------------------------------------

export type FinanceForecastAccountInput = Pick<
  FinanceAccount,
  "id" | "onBudget" | "openingBalanceMinor"
>;

/** Every transaction on an on-budget account regardless of `excludedFromBudget` — for `onBudgetBalance(today)`. */
export interface FinanceForecastBalanceTransactionInput {
  accountId: string;
  postedDate: string;
  amountMinor: number;
}

export interface FinanceForecastTransactionInput {
  id: string;
  accountId: string;
  postedDate: string;
  amountMinor: number;
  categoryId: string | null;
  merchantKey: string;
  hasSplits: boolean;
  isTransfer: boolean;
}

export interface FinanceForecastSplitInput {
  transactionId: string;
  amountMinor: number;
  categoryId: string | null;
}

/** Active recurring series only — the repository filters `status === "active"`. */
export interface FinanceForecastRecurringSeriesInput {
  merchantKey: string;
  accountId: string;
  categoryId: string | null;
  cadence: FinanceRecurringCadence;
  expectedAmountMinor: number;
  nextExpectedDate: string;
}

/**
 * The single input shape `computeFinanceForecast` takes. Both repository
 * implementations build this the same way (see `buildFinanceSnapshot` in
 * `AppRepository`): `paceTransactions`/`paceSplits` cover the current month
 * plus the three trailing calendar months, already restricted to on-budget
 * accounts with `excludedFromBudget = 0` (the same filter `budget.ts`'s
 * `activity` uses) so pace math and envelope activity agree on what counts
 * as spending. `budgetState` is `computeFinanceBudgetState(monthKey)` —
 * reused, never recomputed, for `envelope`/`available`/`activity`.
 */
export interface FinanceSnapshot {
  today: string;
  monthKey: string;
  safetyBufferMinor: number;
  accounts: FinanceForecastAccountInput[];
  balanceTransactions: FinanceForecastBalanceTransactionInput[];
  budgetState: FinanceBudgetState;
  paceTransactions: FinanceForecastTransactionInput[];
  paceSplits: FinanceForecastSplitInput[];
  /** Earliest month with any on-budget, non-excluded activity; `null` when there is none. Drives `lowConfidence`. */
  firstActivityMonthKey: string | null;
  recurringSeries: FinanceForecastRecurringSeriesInput[];
}

// --- Small pure helpers ------------------------------------------------------------------------

/** `median` can land on a half-integer; callers round via `roundHalfAwayFromZero` before storage. */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/** Symmetric round-half-away-from-zero — every pace/projection stored or displayed as money goes through this. */
const roundHalfAwayFromZero = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

const dayOfMonth = (date: string): number => Number(date.slice(8, 10));

const daysInMonth = (monthKey: string): number => Number(getMonthEndDate(monthKey).slice(8, 10));

const diffDays = (fromDate: string, toDate: string): number =>
  Math.round(
    (new Date(`${toDate}T12:00:00`).getTime() - new Date(`${fromDate}T12:00:00`).getTime()) /
      86_400_000,
  );

/** `opening + Σ ALL transactions through asOfDate` across on-budget accounts — the stock-balance rule. */
export const computeOnBudgetBalanceAsOf = (
  asOfDate: string,
  accounts: FinanceForecastAccountInput[],
  balanceTransactions: FinanceForecastBalanceTransactionInput[],
): number => {
  const onBudgetAccountIds = new Set(
    accounts.filter((account) => account.onBudget).map((account) => account.id),
  );
  let total = 0;
  for (const account of accounts) {
    if (account.onBudget) {
      total += account.openingBalanceMinor;
    }
  }
  for (const txn of balanceTransactions) {
    if (onBudgetAccountIds.has(txn.accountId) && txn.postedDate <= asOfDate) {
      total += txn.amountMinor;
    }
  }
  return total;
};

/** Matches a transaction to an active recurring series by `merchantKey` + `accountId` + sign. */
const matchesActiveRecurringSeries = (
  txn: Pick<FinanceForecastTransactionInput, "merchantKey" | "accountId" | "amountMinor">,
  recurringSeries: FinanceForecastRecurringSeriesInput[],
): boolean =>
  recurringSeries.some(
    (series) =>
      series.merchantKey === txn.merchantKey &&
      series.accountId === txn.accountId &&
      Math.sign(series.expectedAmountMinor) === Math.sign(txn.amountMinor),
  );

/**
 * Non-recurring outflow (positive minor units), split-expanded per the split
 * aggregation rule, bucketed by category then month-key. Recurring-matched
 * transactions are skipped entirely here — they are lump sums counted once
 * in `spent` (from `budgetState`) and in `knownUpcoming`/bill projections,
 * never smoothed into a pace.
 */
const buildNonRecurringOutflowByCategoryMonth = (
  transactions: FinanceForecastTransactionInput[],
  splits: FinanceForecastSplitInput[],
  recurringSeries: FinanceForecastRecurringSeriesInput[],
): Map<string, Map<string, number>> => {
  const splitsByTransactionId = new Map<string, FinanceForecastSplitInput[]>();
  for (const split of splits) {
    const bucket = splitsByTransactionId.get(split.transactionId);
    if (bucket) {
      bucket.push(split);
    } else {
      splitsByTransactionId.set(split.transactionId, [split]);
    }
  }

  const byCategory = new Map<string, Map<string, number>>();
  const add = (categoryId: string | null, monthKey: string, amountMinor: number) => {
    if (amountMinor >= 0) {
      return;
    }
    const resolvedCategoryId = categoryId ?? UNCATEGORIZED_CATEGORY_ID;
    let byMonth = byCategory.get(resolvedCategoryId);
    if (!byMonth) {
      byMonth = new Map();
      byCategory.set(resolvedCategoryId, byMonth);
    }
    byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + -amountMinor);
  };

  for (const txn of transactions) {
    if (txn.isTransfer || matchesActiveRecurringSeries(txn, recurringSeries)) {
      continue;
    }
    const monthKey = getMonthKey(txn.postedDate);
    if (txn.hasSplits) {
      for (const split of splitsByTransactionId.get(txn.id) ?? []) {
        add(split.categoryId, monthKey, split.amountMinor);
      }
    } else {
      add(txn.categoryId, monthKey, txn.amountMinor);
    }
  }
  return byCategory;
};

const sumMonthAcrossCategories = (
  byCategory: Map<string, Map<string, number>>,
  monthKey: string,
): number => {
  let total = 0;
  for (const byMonth of byCategory.values()) {
    total += byMonth.get(monthKey) ?? 0;
  }
  return total;
};

/** Number of trailing *full* calendar months with any data, capped at 3 — drives `lowConfidence`. */
const countPriorMonthsAvailable = (
  firstActivityMonthKey: string | null,
  monthKey: string,
): number => {
  if (!firstActivityMonthKey) {
    return 0;
  }
  let count = 0;
  let cursor = addMonthsToMonthKey(monthKey, -1);
  while (count < 3 && cursor >= firstActivityMonthKey) {
    count += 1;
    cursor = addMonthsToMonthKey(cursor, -1);
  }
  return count;
};

export interface FinancePace {
  currentPaceMinor: number;
  /** `null` when there are fewer than 3 trailing full months of data (`lowConfidence`). */
  historicalPaceMinor: number | null;
  blendedPaceMinor: number;
}

/**
 * `blendedPace` per specs/todo/finance.md: `elapsedDays < 5` uses history,
 * `< 12` blends 50/50, otherwise pure current pace — **unless** there is
 * fewer than 3 trailing full months of data, in which case the whole ladder
 * collapses to `currentPace` (the `lowConfidence` override: it would
 * otherwise read an undefined `historicalPace`).
 */
const computeBlendedPace = (
  currentOutflowMinor: number,
  elapsedDays: number,
  trailingMonthlyOutflowsMinor: number[],
  trailingDaysInMonth: number[],
  hasEnoughHistory: boolean,
): FinancePace => {
  const currentPace = currentOutflowMinor / Math.max(elapsedDays, 1);

  let historicalPace: number | null = null;
  if (hasEnoughHistory) {
    const dailyRates = trailingMonthlyOutflowsMinor.map(
      (outflow, index) => outflow / trailingDaysInMonth[index],
    );
    historicalPace = median(dailyRates);
  }

  let blendedPaceRaw: number;
  if (historicalPace === null) {
    blendedPaceRaw = currentPace;
  } else if (elapsedDays < 5) {
    blendedPaceRaw = historicalPace;
  } else if (elapsedDays < 12) {
    blendedPaceRaw = 0.5 * currentPace + 0.5 * historicalPace;
  } else {
    blendedPaceRaw = currentPace;
  }

  return {
    currentPaceMinor: roundHalfAwayFromZero(currentPace),
    historicalPaceMinor: historicalPace === null ? null : roundHalfAwayFromZero(historicalPace),
    blendedPaceMinor: roundHalfAwayFromZero(blendedPaceRaw),
  };
};

// --- Per-envelope forecast ---------------------------------------------------------------------

export type FinanceEnvelopeForecastStatus = "on_track" | "watch" | "will_run_out" | "exhausted";

export interface FinanceEnvelopeForecast {
  categoryId: string;
  /** `assigned(cat, M) + carryIn(cat, M)` — the budget for the month, not the remaining `available`. */
  envelopeMinor: number;
  /** Positive magnitude of the full actual activity so far this month. */
  spentMinor: number;
  currentPaceMinor: number;
  historicalPaceMinor: number | null;
  blendedPaceMinor: number;
  /** Σ expected amount of active recurring bills for this category still due this month. */
  knownUpcomingMinor: number;
  projectedTotalMinor: number;
  runoutDate: string | null;
  status: FinanceEnvelopeForecastStatus;
  lowConfidence: boolean;
}

export interface FinanceForecast {
  today: string;
  monthKey: string;
  /** Only budgeted categories (`envelope > 0`) — see the ladder guard in the spec. */
  envelopes: FinanceEnvelopeForecast[];
  cashRunoutDate: string | null;
  discretionaryPaceMinor: number;
  onBudgetBalanceTodayMinor: number;
}

const advanceByCadence = (date: string, cadence: FinanceRecurringCadence): string => {
  switch (cadence) {
    case "weekly":
      return addDays(date, 7);
    case "biweekly":
      return addDays(date, 14);
    case "semimonthly":
      return addDays(date, 15);
    case "monthly":
      return addMonthsClamped(date, 1);
    case "quarterly":
      return addMonthsClamped(date, 3);
    case "annual":
      return addMonthsClamped(date, 12);
    default:
      return date;
  }
};

/** Every occurrence date of `series` strictly after `afterDateExclusive`, through `throughDateInclusive`. */
const projectRecurringOccurrences = (
  series: FinanceForecastRecurringSeriesInput,
  afterDateExclusive: string,
  throughDateInclusive: string,
): string[] => {
  const dates: string[] = [];
  let cursor = series.nextExpectedDate;
  let guard = 0;
  while (cursor <= throughDateInclusive && guard < 500) {
    if (cursor > afterDateExclusive) {
      dates.push(cursor);
    }
    cursor = advanceByCadence(cursor, series.cadence);
    guard += 1;
  }
  return dates;
};

const CASH_RUNOUT_HORIZON_DAYS = 60;

/**
 * First date within a 60-day horizon where `projectedBalance(d) <
 * safetyBufferMinor`. Recurring series are advanced past
 * `nextExpectedDate` so a monthly bill due the 5th is projected again next
 * month within the horizon — see "month-boundary... project repeated
 * occurrences" in the spec.
 */
const computeCashRunoutDate = (
  today: string,
  onBudgetBalanceTodayMinor: number,
  discretionaryPaceMinor: number,
  recurringSeries: FinanceForecastRecurringSeriesInput[],
  safetyBufferMinor: number,
): string | null => {
  const horizonEnd = addDays(today, CASH_RUNOUT_HORIZON_DAYS);
  const occurrences: Array<{ date: string; amountMinor: number }> = [];
  for (const series of recurringSeries) {
    for (const date of projectRecurringOccurrences(series, today, horizonEnd)) {
      occurrences.push({ date, amountMinor: series.expectedAmountMinor });
    }
  }
  occurrences.sort((a, b) => a.date.localeCompare(b.date));

  let cumulativeNet = 0;
  let occurrenceIndex = 0;
  for (let offset = 1; offset <= CASH_RUNOUT_HORIZON_DAYS; offset += 1) {
    const d = addDays(today, offset);
    while (occurrenceIndex < occurrences.length && occurrences[occurrenceIndex].date <= d) {
      // Income amounts are positive, bill amounts are negative — a single
      // running sum is `+ income - bills` exactly per the spec's formula.
      cumulativeNet += occurrences[occurrenceIndex].amountMinor;
      occurrenceIndex += 1;
    }
    const projectedBalance =
      onBudgetBalanceTodayMinor + cumulativeNet - discretionaryPaceMinor * offset;
    if (projectedBalance < safetyBufferMinor) {
      return d;
    }
  }
  return null;
};

/** Per-envelope forecasts + the household cash-flow runout date — the one function both repositories call. */
export const computeFinanceForecast = (snapshot: FinanceSnapshot): FinanceForecast => {
  const { today, monthKey } = snapshot;
  const elapsedDays = dayOfMonth(today);
  const totalDays = daysInMonth(monthKey);
  const remainingDays = totalDays - elapsedDays;
  const monthEnd = getMonthEndDate(monthKey);

  const trailingMonthKeys = [
    addMonthsToMonthKey(monthKey, -3),
    addMonthsToMonthKey(monthKey, -2),
    addMonthsToMonthKey(monthKey, -1),
  ];
  const trailingDaysInMonth = trailingMonthKeys.map(daysInMonth);
  const hasEnoughHistory = countPriorMonthsAvailable(snapshot.firstActivityMonthKey, monthKey) >= 3;

  const nonRecurringByCategoryMonth = buildNonRecurringOutflowByCategoryMonth(
    snapshot.paceTransactions,
    snapshot.paceSplits,
    snapshot.recurringSeries,
  );
  const activeBillSeries = snapshot.recurringSeries.filter(
    (series) => series.expectedAmountMinor < 0,
  );

  const envelopes: FinanceEnvelopeForecast[] = snapshot.budgetState.categories
    .filter((category) => category.assignedMinor + category.carryInMinor > 0)
    .map((category) => {
      const envelopeMinor = category.assignedMinor + category.carryInMinor;
      const spentMinor = category.activityMinor < 0 ? -category.activityMinor : 0;

      const currentOutflow =
        nonRecurringByCategoryMonth.get(category.categoryId)?.get(monthKey) ?? 0;
      const trailingOutflows = trailingMonthKeys.map(
        (m) => nonRecurringByCategoryMonth.get(category.categoryId)?.get(m) ?? 0,
      );
      const pace = computeBlendedPace(
        currentOutflow,
        elapsedDays,
        trailingOutflows,
        trailingDaysInMonth,
        hasEnoughHistory,
      );

      const upcomingThrough = (d: string) =>
        activeBillSeries
          .filter(
            (series) =>
              series.categoryId === category.categoryId &&
              series.nextExpectedDate > today &&
              series.nextExpectedDate <= d,
          )
          .reduce((sum, series) => sum + -series.expectedAmountMinor, 0);

      const knownUpcomingMinor = upcomingThrough(monthEnd);
      const projectedTotalMinor =
        spentMinor + pace.blendedPaceMinor * remainingDays + knownUpcomingMinor;

      const lowConfidence = !hasEnoughHistory;
      let status: FinanceEnvelopeForecastStatus;
      if (category.availableMinor <= 0) {
        status = "exhausted";
      } else if (projectedTotalMinor >= envelopeMinor) {
        status = "will_run_out";
      } else if (10 * projectedTotalMinor >= 9 * envelopeMinor) {
        status = "watch";
      } else {
        status = "on_track";
      }

      let runoutDate: string | null = null;
      if (status === "will_run_out") {
        for (let offset = 1; offset <= remainingDays; offset += 1) {
          const d = addDays(today, offset);
          const cumulative = spentMinor + pace.blendedPaceMinor * offset + upcomingThrough(d);
          if (cumulative >= envelopeMinor) {
            runoutDate = d;
            break;
          }
        }
      }

      return {
        categoryId: category.categoryId,
        envelopeMinor,
        spentMinor,
        currentPaceMinor: pace.currentPaceMinor,
        historicalPaceMinor: pace.historicalPaceMinor,
        blendedPaceMinor: pace.blendedPaceMinor,
        knownUpcomingMinor,
        projectedTotalMinor,
        runoutDate,
        status,
        lowConfidence,
      };
    });

  const totalCurrentOutflow = sumMonthAcrossCategories(nonRecurringByCategoryMonth, monthKey);
  const totalTrailingOutflows = trailingMonthKeys.map((m) =>
    sumMonthAcrossCategories(nonRecurringByCategoryMonth, m),
  );
  const discretionaryPace = computeBlendedPace(
    totalCurrentOutflow,
    elapsedDays,
    totalTrailingOutflows,
    trailingDaysInMonth,
    hasEnoughHistory,
  );

  const onBudgetBalanceTodayMinor = computeOnBudgetBalanceAsOf(
    today,
    snapshot.accounts,
    snapshot.balanceTransactions,
  );
  const cashRunoutDate = computeCashRunoutDate(
    today,
    onBudgetBalanceTodayMinor,
    discretionaryPace.blendedPaceMinor,
    snapshot.recurringSeries,
    snapshot.safetyBufferMinor,
  );

  return {
    today,
    monthKey,
    envelopes,
    cashRunoutDate,
    discretionaryPaceMinor: discretionaryPace.blendedPaceMinor,
    onBudgetBalanceTodayMinor,
  };
};

// --- Alerts --------------------------------------------------------------------------------

export type FinanceAlertSeverity = "critical" | "warning" | "info";
export type FinanceAlertKind =
  | "cash_runout"
  | "envelope_exhausted"
  | "envelope_will_run_out"
  | "envelope_watch";

export interface FinanceAlert {
  /** Stable per (kind, category id or "cash", month) — independent of day-to-day urgency changes. */
  key: string;
  kind: FinanceAlertKind;
  severity: FinanceAlertSeverity;
  /** Sort rank, ascending = more severe. Not part of the stable key. */
  rank: number;
  categoryId: string | null;
  monthKey: string;
  envelopeMinor: number | null;
  runoutDate: string | null;
  daysUntilRunout: number | null;
  lowConfidence: boolean;
}

const CASH_RUNOUT_URGENT_WITHIN_DAYS = 14;

/**
 * Ranked alerts: a cash runout inside 14 days outranks everything, then
 * `exhausted`, then `will_run_out`, then `watch`; a cash runout further out
 * than 14 days still surfaces (the full `/finances` list), just at the
 * lowest rank. `watch` never escalates to a notification (see
 * `src/lib/finance/alert-notification-policy.ts`) but is listed here so the
 * full page can show it.
 */
export const buildFinanceAlerts = (
  forecast: FinanceForecast,
  settings: Pick<AppSettings, "financeSafetyBufferMinor">,
): FinanceAlert[] => {
  void settings; // reserved for future threshold-driven filtering; buffer is already baked into `forecast`.
  const alerts: FinanceAlert[] = [];

  if (forecast.cashRunoutDate) {
    const daysUntilRunout = diffDays(forecast.today, forecast.cashRunoutDate);
    const urgent = daysUntilRunout <= CASH_RUNOUT_URGENT_WITHIN_DAYS;
    alerts.push({
      key: `cash_runout:${forecast.monthKey}`,
      kind: "cash_runout",
      severity: urgent ? "critical" : "warning",
      rank: urgent ? 0 : 4,
      categoryId: null,
      monthKey: forecast.monthKey,
      envelopeMinor: null,
      runoutDate: forecast.cashRunoutDate,
      daysUntilRunout,
      lowConfidence: false,
    });
  }

  for (const envelope of forecast.envelopes) {
    if (envelope.status === "on_track") {
      continue;
    }
    const kind: FinanceAlertKind =
      envelope.status === "exhausted"
        ? "envelope_exhausted"
        : envelope.status === "will_run_out"
          ? "envelope_will_run_out"
          : "envelope_watch";
    const rank = envelope.status === "exhausted" ? 1 : envelope.status === "will_run_out" ? 2 : 3;
    const severity: FinanceAlertSeverity =
      envelope.status === "exhausted"
        ? "critical"
        : envelope.status === "will_run_out"
          ? "warning"
          : "info";

    alerts.push({
      key: `${kind}:${envelope.categoryId}:${forecast.monthKey}`,
      kind,
      severity,
      rank,
      categoryId: envelope.categoryId,
      monthKey: forecast.monthKey,
      envelopeMinor: envelope.envelopeMinor,
      runoutDate: envelope.runoutDate,
      daysUntilRunout: envelope.runoutDate ? diffDays(forecast.today, envelope.runoutDate) : null,
      lowConfidence: envelope.lowConfidence,
    });
  }

  return alerts.sort(
    (a, b) => a.rank - b.rank || (a.categoryId ?? "").localeCompare(b.categoryId ?? ""),
  );
};
