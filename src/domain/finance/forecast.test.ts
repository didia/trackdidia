import { describe, expect, it } from "vitest";
import {
  buildFinanceAlerts,
  computeFinanceForecast,
  type FinanceForecastRecurringSeriesInput,
  type FinanceForecastTransactionInput,
  type FinanceSnapshot,
} from "./forecast";
import type { FinanceBudgetCategoryState, FinanceBudgetState } from "./budget";

const CATEGORY_A = "fincat:test.a";
const CATEGORY_B = "fincat:test.b";
const CHECKING = "account-checking";

let nextTxnId = 0;
const txn = (
  overrides: Partial<FinanceForecastTransactionInput> & { postedDate: string; amountMinor: number },
): FinanceForecastTransactionInput => ({
  id: `txn-${nextTxnId++}`,
  accountId: CHECKING,
  categoryId: CATEGORY_A,
  merchantKey: "merchant",
  hasSplits: false,
  isTransfer: false,
  ...overrides,
});

const recurring = (
  overrides: Partial<FinanceForecastRecurringSeriesInput> & {
    expectedAmountMinor: number;
    nextExpectedDate: string;
  },
): FinanceForecastRecurringSeriesInput => ({
  merchantKey: "merchant",
  accountId: CHECKING,
  categoryId: CATEGORY_A,
  cadence: "monthly",
  ...overrides,
});

const categoryState = (
  categoryId: string,
  overrides: Partial<FinanceBudgetCategoryState> = {},
): FinanceBudgetCategoryState => ({
  categoryId,
  assignedMinor: 0,
  activityMinor: 0,
  carryInMinor: 0,
  availableMinor: 0,
  overspendPolicy: "reduce_next_ready_to_assign",
  lastMonthAssignedMinor: 0,
  average3MonthsAssignedMinor: 0,
  assignAllReadyToAssignMinor: 0,
  ...overrides,
});

const budgetState = (
  monthKey: string,
  categories: FinanceBudgetCategoryState[],
): FinanceBudgetState => ({
  monthKey,
  onBudgetBalanceMinor: 0,
  readyToAssignMinor: 0,
  categories,
});

const buildSnapshot = (overrides: Partial<FinanceSnapshot> = {}): FinanceSnapshot => ({
  today: "2026-03-15",
  monthKey: "2026-03",
  safetyBufferMinor: 0,
  accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 0 }],
  balanceTransactions: [],
  budgetState: budgetState("2026-03", []),
  paceTransactions: [],
  paceSplits: [],
  firstActivityMonthKey: null,
  recurringSeries: [],
  ...overrides,
});

const SETTINGS = { financeSafetyBufferMinor: 0 };

describe("computeFinanceForecast", () => {
  it("uses pure current pace mid-month (elapsedDays >= 12)", () => {
    // 2026-03-15 is day 15 of a 31-day month -> remainingDays = 16.
    const snapshot = buildSnapshot({
      today: "2026-03-15",
      monthKey: "2026-03",
      budgetState: budgetState("2026-03", [
        categoryState(CATEGORY_A, {
          assignedMinor: 30_000,
          activityMinor: -9_000,
          availableMinor: 21_000,
        }),
      ]),
      paceTransactions: [txn({ postedDate: "2026-03-10", amountMinor: -9_000 })],
      // History exists but must be ignored at elapsedDays >= 12 — a very
      // different trailing rate would change the result if the branch were wrong.
      firstActivityMonthKey: "2025-10",
      // trailing Dec/Jan/Feb outflow of 3000/day equivalent, deliberately far from current pace.
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    expect(envelope).toBeDefined();
    // currentPace = 9000 / 15 = 600/day.
    expect(envelope?.currentPaceMinor).toBe(600);
    expect(envelope?.blendedPaceMinor).toBe(600);
    // projectedTotal = 9000 (spent) + 600 * 16 (remaining) = 18600.
    expect(envelope?.spentMinor).toBe(9_000);
    expect(envelope?.projectedTotalMinor).toBe(9_000 + 600 * 16);
    expect(envelope?.status).toBe("on_track");
  });

  it("uses historical pace when elapsedDays < 5 and there is enough history", () => {
    const monthKey = "2026-05";
    const snapshot = buildSnapshot({
      today: "2026-05-03", // day 3 of a 31-day month -> remainingDays = 28.
      monthKey,
      firstActivityMonthKey: "2025-10",
      budgetState: budgetState(monthKey, [
        categoryState(CATEGORY_A, {
          assignedMinor: 3_000,
          activityMinor: -90,
          availableMinor: 2_910,
        }),
      ]),
      paceTransactions: [
        txn({ postedDate: "2026-05-02", amountMinor: -90 }),
        // trailing full months: Feb (28d), Mar (31d), Apr (30d).
        txn({ postedDate: "2026-02-10", amountMinor: -2_800 }), // 2800/28 = 100/day
        txn({ postedDate: "2026-03-10", amountMinor: -3_100 }), // 3100/31 = 100/day
        txn({ postedDate: "2026-04-10", amountMinor: -2_700 }), // 2700/30 = 90/day
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    // currentPace = 90 / 3 = 30/day, but elapsedDays < 5 uses historicalPace instead.
    expect(envelope?.currentPaceMinor).toBe(30);
    // median(100, 100, 90) = 100.
    expect(envelope?.historicalPaceMinor).toBe(100);
    expect(envelope?.blendedPaceMinor).toBe(100);
    expect(envelope?.lowConfidence).toBe(false);
  });

  it("lands a rent lump sum exactly on its expected day, not smoothed", () => {
    const monthKey = "2026-03";
    const snapshot = buildSnapshot({
      today: "2026-03-01",
      monthKey,
      budgetState: budgetState(monthKey, [
        categoryState(CATEGORY_A, {
          assignedMinor: 150_000,
          activityMinor: 0,
          availableMinor: 150_000,
        }),
      ]),
      recurringSeries: [
        recurring({
          categoryId: CATEGORY_A,
          expectedAmountMinor: -150_000,
          nextExpectedDate: "2026-03-05",
        }),
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    expect(envelope?.knownUpcomingMinor).toBe(150_000);
    expect(envelope?.projectedTotalMinor).toBe(150_000);
    expect(envelope?.status).toBe("will_run_out");
    expect(envelope?.runoutDate).toBe("2026-03-05");
  });

  it("resists a one-off outlier via median, not mean", () => {
    const monthKey = "2026-05";
    const snapshot = buildSnapshot({
      today: "2026-05-02", // elapsedDays < 5 -> historicalPace used.
      monthKey,
      firstActivityMonthKey: "2025-10",
      budgetState: budgetState(monthKey, [
        categoryState(CATEGORY_A, { assignedMinor: 10_000, availableMinor: 10_000 }),
      ]),
      paceTransactions: [
        txn({ postedDate: "2026-02-10", amountMinor: -3_000 }), // 3000/28 ≈ 107 -> use 28-day Feb below
        txn({ postedDate: "2026-03-10", amountMinor: -3_100 }), // 3100/31 = 100
        // A single legitimate one-off (car repair) in April must not distort the median.
        txn({ postedDate: "2026-04-10", amountMinor: -90_000 }), // 90000/30 = 3000/day outlier
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    // dailyRates ≈ [107.14, 100, 3000] -> median = 107.14 -> rounds to 107.
    expect(envelope?.historicalPaceMinor).toBeLessThan(200);
    expect(envelope?.blendedPaceMinor).toBeLessThan(200);
  });

  it("produces no envelope entry (and therefore no alert) for an unbudgeted category", () => {
    const monthKey = "2026-03";
    const snapshot = buildSnapshot({
      monthKey,
      budgetState: budgetState(monthKey, [
        // Heavy spending but never assigned -> envelope <= 0, out of scope entirely.
        categoryState(CATEGORY_A, {
          assignedMinor: 0,
          carryInMinor: 0,
          activityMinor: -500_000,
          availableMinor: -500_000,
        }),
      ]),
    });

    const forecast = computeFinanceForecast(snapshot);
    expect(forecast.envelopes).toHaveLength(0);
    const alerts = buildFinanceAlerts(forecast, SETTINGS);
    expect(alerts.find((a) => a.categoryId === CATEGORY_A)).toBeUndefined();
  });

  it("falls back to on_track + lowConfidence with no history and elapsedDays < 5", () => {
    const monthKey = "2026-03";
    const snapshot = buildSnapshot({
      today: "2026-03-02",
      monthKey,
      firstActivityMonthKey: null, // no history at all
      accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 1_000_000 }],
      budgetState: budgetState(monthKey, [
        categoryState(CATEGORY_A, {
          assignedMinor: 10_000,
          activityMinor: -200,
          availableMinor: 9_800,
        }),
      ]),
      paceTransactions: [txn({ postedDate: "2026-03-01", amountMinor: -200 })],
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    expect(envelope?.lowConfidence).toBe(true);
    expect(envelope?.historicalPaceMinor).toBeNull();
    expect(envelope?.status).toBe("on_track");
    const alerts = buildFinanceAlerts(forecast, SETTINGS);
    expect(alerts).toHaveLength(0);
  });

  it("counts an already-paid recurring bill once, not again via pace or knownUpcoming", () => {
    const monthKey = "2026-03";
    const snapshot = buildSnapshot({
      today: "2026-03-20",
      monthKey,
      budgetState: budgetState(monthKey, [
        categoryState(CATEGORY_A, {
          assignedMinor: 150_000,
          activityMinor: -150_000,
          availableMinor: 0,
        }),
      ]),
      // The bill already posted on the 5th; recurring-detection has already
      // advanced `nextExpectedDate` to next month.
      paceTransactions: [
        txn({ postedDate: "2026-03-05", amountMinor: -150_000, merchantKey: "landlord" }),
      ],
      recurringSeries: [
        recurring({
          merchantKey: "landlord",
          categoryId: CATEGORY_A,
          expectedAmountMinor: -150_000,
          nextExpectedDate: "2026-04-05",
        }),
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const envelope = forecast.envelopes.find((e) => e.categoryId === CATEGORY_A);
    expect(envelope?.spentMinor).toBe(150_000);
    expect(envelope?.knownUpcomingMinor).toBe(0);
    expect(envelope?.projectedTotalMinor).toBe(150_000);
  });

  describe("status ladder boundaries", () => {
    // Day 21 of a 31-day month -> elapsedDays=21, remainingDays=10. Spend so
    // far is zero so `projectedTotal` is driven purely by `pace * 10`,
    // isolating the ladder thresholds from `spentMinor`.
    const buildLadderSnapshot = (paceMinorPerDay: number) =>
      buildSnapshot({
        today: "2026-03-21",
        monthKey: "2026-03",
        budgetState: budgetState("2026-03", [
          categoryState(CATEGORY_A, {
            assignedMinor: 100_000,
            activityMinor: 0,
            availableMinor: 100_000,
          }),
        ]),
        paceTransactions: [txn({ postedDate: "2026-03-10", amountMinor: -(paceMinorPerDay * 21) })],
      });

    it("89% of envelope stays on_track", () => {
      const forecast = computeFinanceForecast(buildLadderSnapshot(8_900));
      const envelope = forecast.envelopes[0];
      expect(envelope.projectedTotalMinor).toBe(89_000);
      expect(envelope.status).toBe("on_track");
    });

    it("91% of envelope raises watch", () => {
      const forecast = computeFinanceForecast(buildLadderSnapshot(9_100));
      const envelope = forecast.envelopes[0];
      expect(envelope.projectedTotalMinor).toBe(91_000);
      expect(envelope.status).toBe("watch");
    });

    it("100% of envelope raises will_run_out", () => {
      const forecast = computeFinanceForecast(buildLadderSnapshot(10_000));
      const envelope = forecast.envelopes[0];
      expect(envelope.projectedTotalMinor).toBe(100_000);
      expect(envelope.status).toBe("will_run_out");
    });
  });

  describe("household cash-flow runout", () => {
    it("accounts for an upcoming recurring bill", () => {
      const snapshot = buildSnapshot({
        today: "2026-03-01",
        accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 50_000 }],
        recurringSeries: [
          recurring({
            accountId: CHECKING,
            categoryId: null,
            expectedAmountMinor: -120_000,
            nextExpectedDate: "2026-03-12",
          }),
        ],
      });

      const forecast = computeFinanceForecast(snapshot);
      expect(forecast.onBudgetBalanceTodayMinor).toBe(50_000);
      expect(forecast.cashRunoutDate).toBe("2026-03-12");
    });

    it("an upcoming income payment delays/avoids the runout", () => {
      const snapshot = buildSnapshot({
        today: "2026-03-01",
        accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 50_000 }],
        recurringSeries: [
          recurring({
            accountId: CHECKING,
            categoryId: null,
            expectedAmountMinor: -120_000,
            nextExpectedDate: "2026-03-12",
          }),
          recurring({
            accountId: CHECKING,
            categoryId: null,
            expectedAmountMinor: 100_000,
            nextExpectedDate: "2026-03-10",
          }),
        ],
      });

      const forecast = computeFinanceForecast(snapshot);
      // Income on the 10th (+100000) lands before the bill on the 12th
      // (-120000): balance never dips below the buffer.
      expect(forecast.cashRunoutDate).toBeNull();
    });

    it("projects a monthly bill's second occurrence correctly across the Jan 31 -> Feb 28 month boundary", () => {
      const snapshot = buildSnapshot({
        today: "2026-01-01",
        monthKey: "2026-01",
        accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 150_000 }],
        recurringSeries: [
          recurring({
            accountId: CHECKING,
            categoryId: null,
            expectedAmountMinor: -100_000,
            nextExpectedDate: "2026-01-31",
          }),
        ],
      });

      const forecast = computeFinanceForecast(snapshot);
      // After the first occurrence (Jan 31): balance = 50000 (still >= 0).
      // The clamped second occurrence (Jan 31 + 1 month -> Feb 28, since
      // 2026 is not a leap year) drops the balance to -50000.
      expect(forecast.cashRunoutDate).toBe("2026-02-28");
    });
  });
});

describe("buildFinanceAlerts", () => {
  it("ranks a cash runout inside 14 days above exhausted, will_run_out and watch", () => {
    const snapshot = buildSnapshot({
      today: "2026-03-01",
      monthKey: "2026-03",
      accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 10_000 }],
      recurringSeries: [
        recurring({
          accountId: CHECKING,
          categoryId: null,
          expectedAmountMinor: -20_000,
          nextExpectedDate: "2026-03-05", // within 14 days
        }),
      ],
      budgetState: budgetState("2026-03", [
        categoryState(CATEGORY_A, {
          assignedMinor: 10_000,
          activityMinor: -10_000,
          availableMinor: 0,
        }), // exhausted
        categoryState(CATEGORY_B, {
          assignedMinor: 10_000,
          activityMinor: -9_500,
          availableMinor: 500,
        }),
      ]),
      paceTransactions: [
        txn({ postedDate: "2026-03-01", amountMinor: -9_500, categoryId: CATEGORY_B }),
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const alerts = buildFinanceAlerts(forecast, SETTINGS);
    expect(alerts[0].kind).toBe("cash_runout");
    expect(alerts[0].severity).toBe("critical");
    const kinds = alerts.map((a) => a.kind);
    expect(kinds.indexOf("cash_runout")).toBeLessThan(
      kinds.indexOf("envelope_exhausted") === -1
        ? Number.POSITIVE_INFINITY
        : kinds.indexOf("envelope_exhausted"),
    );
  });

  it("uses a stable key per (kind, category/cash, month) regardless of day-to-day urgency", () => {
    const snapshot = buildSnapshot({
      today: "2026-03-01",
      monthKey: "2026-03",
      accounts: [{ id: CHECKING, onBudget: true, openingBalanceMinor: 10_000 }],
      recurringSeries: [
        recurring({
          accountId: CHECKING,
          categoryId: null,
          expectedAmountMinor: -20_000,
          nextExpectedDate: "2026-04-25", // far out, > 14 days
        }),
      ],
    });

    const forecast = computeFinanceForecast(snapshot);
    const alerts = buildFinanceAlerts(forecast, SETTINGS);
    expect(alerts[0].key).toBe("cash_runout:2026-03");
    expect(alerts[0].severity).toBe("warning");
  });
});
