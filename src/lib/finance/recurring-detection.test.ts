import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  detectFinanceRecurringSeries,
  type RecurringDetectionExistingSeriesInput,
  type RecurringDetectionTransactionInput,
} from "./recurring-detection";

const txn = (
  postedDate: string,
  amountMinor: number,
  overrides: Partial<RecurringDetectionTransactionInput> = {},
): RecurringDetectionTransactionInput => ({
  merchantKey: "NETFLIX",
  accountId: "account-checking",
  categoryId: "fincat:divertissement",
  amountMinor,
  postedDate,
  ...overrides,
});

describe("addMonthsClamped", () => {
  it("clamps the 31st to the last day of a 30-day or shorter month", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2024-01-31", 1)).toBe("2024-02-29"); // leap year
    expect(addMonthsClamped("2026-03-31", 1)).toBe("2026-04-30");
  });
});

describe("detectFinanceRecurringSeries", () => {
  it("classifies a monthly cadence and computes the correct next date", () => {
    const transactions = [
      txn("2026-01-15", -1599),
      txn("2026-02-15", -1599),
      txn("2026-03-15", -1599),
      txn("2026-04-15", -1599),
    ];
    const [series] = detectFinanceRecurringSeries(transactions, [], "2026-04-16");
    expect(series.cadence).toBe("monthly");
    expect(series.expectedAmountMinor).toBe(-1599);
    expect(series.nextExpectedDate).toBe("2026-05-15");
    expect(series.occurrenceCount).toBe(4);
  });

  it("classifies a biweekly cadence", () => {
    const transactions = [
      txn("2026-01-01", -500, { merchantKey: "GYM" }),
      txn("2026-01-15", -500, { merchantKey: "GYM" }),
      txn("2026-01-29", -500, { merchantKey: "GYM" }),
      txn("2026-02-12", -500, { merchantKey: "GYM" }),
    ];
    const [series] = detectFinanceRecurringSeries(transactions, [], "2026-02-13");
    expect(series.cadence).toBe("biweekly");
  });

  it("classifies an annual cadence", () => {
    const transactions = [
      txn("2023-06-01", -12000, { merchantKey: "INSURANCE" }),
      txn("2024-06-01", -12000, { merchantKey: "INSURANCE" }),
      txn("2025-06-01", -12000, { merchantKey: "INSURANCE" }),
    ];
    const [series] = detectFinanceRecurringSeries(transactions, [], "2025-06-02");
    expect(series.cadence).toBe("annual");
    expect(series.nextExpectedDate).toBe("2026-06-01");
  });

  it("clamps the next expected date for a monthly series anchored on the 31st, landing in February", () => {
    const transactions = [
      txn("2025-11-30", -999, { merchantKey: "RENT" }),
      txn("2025-12-31", -999, { merchantKey: "RENT" }),
      txn("2026-01-31", -999, { merchantKey: "RENT" }),
    ];
    const [series] = detectFinanceRecurringSeries(transactions, [], "2026-02-01");
    expect(series.cadence).toBe("monthly");
    expect(series.nextExpectedDate).toBe("2026-02-28");
  });

  it("requires at least 3 occurrences", () => {
    const transactions = [txn("2026-01-15", -1599), txn("2026-02-15", -1599)];
    const result = detectFinanceRecurringSeries(transactions, [], "2026-03-01");
    expect(result).toHaveLength(0);
  });

  it("flags a missed series and ended after two consecutive misses", () => {
    const transactions = [
      txn("2026-01-15", -1599),
      txn("2026-02-15", -1599),
      txn("2026-03-15", -1599),
    ];
    // Next expected ~2026-04-15; tolerance for monthly is 2.5 days.
    const missedOnly = detectFinanceRecurringSeries(transactions, [], "2026-04-25");
    expect(missedOnly[0].flags).toContain("missed");
    expect(missedOnly[0].flags).not.toContain("ended");

    const endedToo = detectFinanceRecurringSeries(transactions, [], "2026-06-01");
    expect(endedToo[0].flags).toContain("ended");
  });

  it("flags amount_changed when the newest occurrence is outside tolerance", () => {
    const transactions = [
      txn("2026-01-15", -1599),
      txn("2026-02-15", -1599),
      txn("2026-03-15", -1599),
      txn("2026-04-15", -3000),
    ];
    const [series] = detectFinanceRecurringSeries(transactions, [], "2026-04-16");
    expect(series.flags).toContain("amount_changed");
  });

  it("keeps a confirmed series even when re-detection no longer finds a matching group", () => {
    const existing: RecurringDetectionExistingSeriesInput[] = [
      {
        id: "series-1",
        merchantKey: "NETFLIX",
        accountId: "account-checking",
        categoryId: "fincat:divertissement",
        cadence: "monthly",
        expectedAmountMinor: -1599,
        amountToleranceMinor: 100,
        dayOfMonth: 15,
        lastSeenDate: "2026-01-15",
        nextExpectedDate: "2026-02-15",
        occurrenceCount: 3,
        status: "active",
        confirmedByUser: true,
      },
    ];
    const result = detectFinanceRecurringSeries([], existing, "2026-02-16");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("series-1");
    expect(result[0].confirmedByUser).toBe(true);
  });

  it("re-detection preserves a confirmed series's id and confirmation when it still matches", () => {
    const transactions = [
      txn("2026-01-15", -1599),
      txn("2026-02-15", -1599),
      txn("2026-03-15", -1599),
      txn("2026-04-15", -1599),
    ];
    const existing: RecurringDetectionExistingSeriesInput[] = [
      {
        id: "series-1",
        merchantKey: "NETFLIX",
        accountId: "account-checking",
        categoryId: "fincat:divertissement",
        cadence: "monthly",
        expectedAmountMinor: -1599,
        amountToleranceMinor: 100,
        dayOfMonth: 15,
        lastSeenDate: "2026-03-15",
        nextExpectedDate: "2026-04-15",
        occurrenceCount: 3,
        status: "active",
        confirmedByUser: true,
      },
    ];
    const [series] = detectFinanceRecurringSeries(transactions, existing, "2026-04-16");
    expect(series.id).toBe("series-1");
    expect(series.confirmedByUser).toBe(true);
    expect(series.occurrenceCount).toBe(4);
  });
});
