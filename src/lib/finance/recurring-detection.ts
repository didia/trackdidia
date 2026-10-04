// Pure recurring-bill detection over the full transaction history. See
// specs/todo/finance.md "Recurring bills". No I/O; `today` is injected so
// tests are deterministic.

import { addDays } from "../gtd/shared";
import type { FinanceRecurringCadence, FinanceRecurringStatus } from "../../domain/finance";

export interface RecurringDetectionTransactionInput {
  merchantKey: string;
  accountId: string;
  categoryId: string | null;
  amountMinor: number;
  postedDate: string;
}

export type FinanceRecurringFlag = "missed" | "amount_changed" | "ended";

/** The subset of a persisted series re-detection needs to merge against. */
export interface RecurringDetectionExistingSeriesInput {
  id: string;
  merchantKey: string;
  accountId: string;
  categoryId: string | null;
  cadence: FinanceRecurringCadence;
  expectedAmountMinor: number;
  amountToleranceMinor: number;
  dayOfMonth: number | null;
  lastSeenDate: string;
  nextExpectedDate: string;
  occurrenceCount: number;
  status: FinanceRecurringStatus;
  confirmedByUser: boolean;
}

export interface DetectedRecurringSeries {
  /** Empty string means "not yet persisted" — the caller assigns a new id. */
  id: string;
  merchantKey: string;
  accountId: string;
  categoryId: string | null;
  cadence: FinanceRecurringCadence;
  expectedAmountMinor: number;
  amountToleranceMinor: number;
  dayOfMonth: number | null;
  lastSeenDate: string;
  nextExpectedDate: string;
  occurrenceCount: number;
  status: FinanceRecurringStatus;
  confirmedByUser: boolean;
  flags: FinanceRecurringFlag[];
}

interface CadenceBand {
  cadence: FinanceRecurringCadence;
  min: number;
  max: number;
  monthsAnchored: number | null;
}

// weekly 7±2, biweekly 14±3, semimonthly 15±3, monthly 28–33, quarterly 88–95,
// annual 360–370 — see specs/todo/finance.md "Recurring bills".
const CADENCE_BANDS: CadenceBand[] = [
  { cadence: "weekly", min: 5, max: 9, monthsAnchored: null },
  { cadence: "biweekly", min: 11, max: 17, monthsAnchored: null },
  { cadence: "semimonthly", min: 12, max: 18, monthsAnchored: null },
  { cadence: "monthly", min: 28, max: 33, monthsAnchored: 1 },
  { cadence: "quarterly", min: 88, max: 95, monthsAnchored: 3 },
  { cadence: "annual", min: 360, max: 370, monthsAnchored: 12 },
];

/**
 * Half the band width — e.g. weekly's 7±2 band is [5,9], so this is `2`,
 * matching the spec's explicit "7±2" tolerance. Used as the stddev gate
 * (the median gap's cadence is rejected when the gap stddev exceeds it) and
 * as the day tolerance for the `missed` flag.
 */
const cadenceToleranceDays = (band: CadenceBand): number => (band.max - band.min) / 2;

/**
 * `median` can land on a half-integer for an even-length list (e.g. two
 * occurrences of -1000 and -1003 median to -1001.5). Callers that feed this
 * into a day-gap calculation only ever consume it through `Math.round` (see
 * `computeNextExpectedDate`/`missedAfterDate` below — never pass a raw
 * fractional gap further), and callers that feed it into
 * `expectedAmountMinor` must round via `roundHalfAwayFromZero` before it
 * reaches a minor-units (integer) column.
 */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/** Symmetric round-half-away-from-zero — `roundHalfAwayFromZero(-1001.5) === -1002`, not `-1001`. */
const roundHalfAwayFromZero = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

const stdDev = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const SEMIMONTHLY_DAY_TOLERANCE = 3;

/**
 * Two stable days of the month (e.g. the 1st and the 15th) when every charge
 * sits within a few days of one of two anchors. Returns the sorted anchor
 * days, or null when the dates do not form such a pair.
 */
const semimonthlyAnchors = (dates: string[]): [number, number] | null => {
  const days = dates.map((date) => parseDate(date).day).sort((a, b) => a - b);
  const low = days.filter((day) => day - days[0] <= SEMIMONTHLY_DAY_TOLERANCE);
  const high = days.filter((day) => day - days[0] > SEMIMONTHLY_DAY_TOLERANCE);
  if (low.length === 0 || high.length === 0) {
    return null;
  }
  if (high[high.length - 1] - high[0] > SEMIMONTHLY_DAY_TOLERANCE) {
    return null;
  }
  const lowAnchor = low[Math.floor(low.length / 2)];
  const highAnchor = high[Math.floor(high.length / 2)];
  const spread = highAnchor - lowAnchor;
  return spread >= 10 && spread <= 20 ? [lowAnchor, highAnchor] : null;
};

/** Picks the cadence whose target midpoint is closest to `medianGap`, if the stddev gate passes. */
const classifyCadence = (
  medianGap: number,
  gapStdDev: number,
  anchors: [number, number] | null,
): CadenceBand | null => {
  const candidates = CADENCE_BANDS.filter((band) => medianGap >= band.min && medianGap <= band.max);
  if (candidates.length === 0) {
    return null;
  }
  const semimonthly = candidates.find((band) => band.cadence === "semimonthly");
  if (semimonthly && anchors && gapStdDev <= cadenceToleranceDays(semimonthly)) {
    // Biweekly and semimonthly bands overlap; two stable days of the month
    // is the semimonthly pattern, so it wins over the closer-midpoint rule.
    return semimonthly;
  }
  candidates.sort(
    (a, b) => Math.abs(medianGap - (a.min + a.max) / 2) - Math.abs(medianGap - (b.min + b.max) / 2),
  );
  const best = candidates[0];
  return gapStdDev <= cadenceToleranceDays(best) ? best : null;
};

const parseDate = (date: string): { year: number; month: number; day: number } => {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
};

const formatDate = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const daysInMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

/** Adds calendar months to `date`, clamping the day to the target month's last day if needed. */
export const addMonthsClamped = (date: string, months: number): string => {
  const { year, month, day } = parseDate(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatDate(targetYear, targetMonth, clampedDay);
};

/** The first anchor-day date strictly after `date`. */
const nextSemimonthlyDate = (date: string, anchors: [number, number]): string => {
  const { year, month } = parseDate(date);
  const monthStart = formatDate(year, month, 1);
  const candidates = [0, 1].flatMap((offset) => {
    const base = addMonthsClamped(monthStart, offset);
    const parsed = parseDate(base);
    return anchors.map((anchor) =>
      formatDate(
        parsed.year,
        parsed.month,
        Math.min(anchor, daysInMonth(parsed.year, parsed.month)),
      ),
    );
  });
  return candidates.filter((candidate) => candidate > date).sort()[0];
};

const computeNextExpectedDate = (
  lastSeenDate: string,
  band: CadenceBand,
  medianGap: number,
  anchors: [number, number] | null = null,
): string => {
  if (band.cadence === "semimonthly" && anchors) {
    return nextSemimonthlyDate(lastSeenDate, anchors);
  }
  return band.monthsAnchored !== null
    ? addMonthsClamped(lastSeenDate, band.monthsAnchored)
    : addDays(lastSeenDate, Math.round(medianGap));
};

const seriesKey = (merchantKey: string, accountId: string, sign: -1 | 1): string =>
  `${merchantKey}\u0000${accountId}\u0000${sign}`;

const mostCommonCategoryId = (categoryIds: Array<string | null>): string | null => {
  const counts = new Map<string | null, number>();
  for (const id of categoryIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
};

/**
 * Detects recurring series over the full history, grouped by
 * `merchantKey` + account + sign, requiring at least 3 occurrences. A series the user
 * has confirmed (`confirmedByUser`) is always included in the result —
 * re-detection can update its stats but never drops it, even if the fresh
 * group no longer meets the 3-occurrence/cadence threshold.
 */
export const detectFinanceRecurringSeries = (
  transactions: RecurringDetectionTransactionInput[],
  existingSeries: RecurringDetectionExistingSeriesInput[],
  today: string,
): DetectedRecurringSeries[] => {
  const groups = new Map<string, RecurringDetectionTransactionInput[]>();
  for (const txn of transactions) {
    if (txn.amountMinor === 0) {
      continue;
    }
    const sign: -1 | 1 = txn.amountMinor > 0 ? 1 : -1;
    const key = seriesKey(txn.merchantKey, txn.accountId, sign);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(txn);
    } else {
      groups.set(key, [txn]);
    }
  }

  const existingByKey = new Map<string, RecurringDetectionExistingSeriesInput>();
  for (const series of existingSeries) {
    const sign: -1 | 1 = series.expectedAmountMinor > 0 ? 1 : -1;
    existingByKey.set(seriesKey(series.merchantKey, series.accountId, sign), series);
  }

  const detected = new Map<string, DetectedRecurringSeries>();

  for (const [key, occurrences] of groups) {
    if (occurrences.length < 3) {
      continue;
    }
    const sorted = [...occurrences].sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const diffMs =
        new Date(sorted[i].postedDate).getTime() - new Date(sorted[i - 1].postedDate).getTime();
      gaps.push(Math.round(diffMs / (24 * 60 * 60 * 1000)));
    }
    const medianGap = median(gaps);
    const gapStdDev = stdDev(gaps);
    const anchors = semimonthlyAnchors(sorted.map((txn) => txn.postedDate));
    const band = classifyCadence(medianGap, gapStdDev, anchors);
    if (!band) {
      continue;
    }

    const amounts = sorted.map((txn) => txn.amountMinor);
    // `median` can be a half-integer for an even occurrence count; minor
    // units are always integers, so round before this leaves the engine.
    const expectedAmountMinor = roundHalfAwayFromZero(median(amounts));
    const amountToleranceMinor = Math.max(Math.round(Math.abs(expectedAmountMinor) * 0.05), 100);
    const lastSeen = sorted[sorted.length - 1];
    const nextExpectedDate = computeNextExpectedDate(lastSeen.postedDate, band, medianGap, anchors);
    const dayOfMonth = band.monthsAnchored !== null ? parseDate(lastSeen.postedDate).day : null;

    const existing = existingByKey.get(key);
    const newestAmount = lastSeen.amountMinor;
    const flags: FinanceRecurringFlag[] = [];
    if (Math.abs(newestAmount - expectedAmountMinor) > amountToleranceMinor) {
      flags.push("amount_changed");
    }

    const toleranceDays = cadenceToleranceDays(band);
    const missedAfterDate = addDays(nextExpectedDate, Math.round(toleranceDays));
    if (today > missedAfterDate) {
      flags.push("missed");
      const secondCycleExpected = computeNextExpectedDate(
        nextExpectedDate,
        band,
        medianGap,
        anchors,
      );
      const endedAfterDate = addDays(secondCycleExpected, Math.round(toleranceDays));
      if (today > endedAfterDate) {
        flags.push("ended");
      }
    }

    const categoryId =
      existing?.categoryId ?? mostCommonCategoryId(sorted.map((txn) => txn.categoryId));
    const confirmedByUser = existing?.confirmedByUser ?? false;
    // Only auto-derive status when the user has not confirmed the series —
    // a confirmed series's status (active/paused/ended) is user-owned.
    const status: FinanceRecurringStatus = confirmedByUser
      ? (existing?.status ?? "active")
      : flags.includes("ended")
        ? "ended"
        : "active";

    detected.set(key, {
      id: existing?.id ?? "",
      merchantKey: lastSeen.merchantKey,
      accountId: lastSeen.accountId,
      categoryId,
      cadence: band.cadence,
      expectedAmountMinor,
      amountToleranceMinor,
      dayOfMonth,
      lastSeenDate: lastSeen.postedDate,
      nextExpectedDate,
      occurrenceCount: sorted.length,
      status,
      confirmedByUser,
      flags,
    });
  }

  // Confirmed series not re-derived this run (too few/no matching occurrences
  // anymore) are still returned, untouched — re-detection must never drop them.
  for (const [key, series] of existingByKey) {
    if (series.confirmedByUser && !detected.has(key)) {
      detected.set(key, { ...series, flags: [] });
    }
  }

  return [...detected.values()].sort(
    (a, b) => a.merchantKey.localeCompare(b.merchantKey) || a.accountId.localeCompare(b.accountId),
  );
};
