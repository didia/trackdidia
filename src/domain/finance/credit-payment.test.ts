import { describe, expect, it } from "vitest";
import {
  computeFinanceCreditPaymentDue,
  computeNextPaymentDueDate,
  inferMinimumPaymentMinor,
  normalizeMinimumPaymentMinor,
  normalizePaymentDueDay,
} from "./credit-payment";

const card = (overrides: Record<string, unknown> = {}) => ({
  type: "credit_card" as const,
  closed: false,
  currency: "CAD",
  paymentDueDay: 15,
  minimumPaymentMinor: null,
  ...overrides,
});

describe("computeNextPaymentDueDate", () => {
  it("uses this month while the due day has not passed, and counts today", () => {
    expect(computeNextPaymentDueDate(15, "2026-10-10")).toBe("2026-10-15");
    expect(computeNextPaymentDueDate(15, "2026-10-15")).toBe("2026-10-15");
  });

  it("rolls to next month once the due day has passed, across a year boundary", () => {
    expect(computeNextPaymentDueDate(15, "2026-10-16")).toBe("2026-11-15");
    expect(computeNextPaymentDueDate(5, "2026-12-20")).toBe("2027-01-05");
  });

  it("falls on the last day of a month too short for the due day", () => {
    expect(computeNextPaymentDueDate(31, "2026-04-10")).toBe("2026-04-30");
    expect(computeNextPaymentDueDate(30, "2027-02-01")).toBe("2027-02-28");
    expect(computeNextPaymentDueDate(30, "2028-02-01")).toBe("2028-02-29");
    expect(computeNextPaymentDueDate(31, "2026-01-31")).toBe("2026-01-31");
    expect(computeNextPaymentDueDate(31, "2026-04-30")).toBe("2026-04-30");
  });

  it("clamps in the following month when this month's date has passed", () => {
    expect(computeNextPaymentDueDate(31, "2026-01-31")).toBe("2026-01-31");
    expect(computeNextPaymentDueDate(30, "2026-01-31")).toBe("2026-02-28");
  });
});

describe("inferMinimumPaymentMinor", () => {
  it("is the 10.00 floor for small balances", () => {
    expect(inferMinimumPaymentMinor(20_000, "CAD")).toBe(1_000);
  });

  it("is 3% of the balance above the floor, rounded up", () => {
    expect(inferMinimumPaymentMinor(150_000, "CAD")).toBe(4_500);
    expect(inferMinimumPaymentMinor(123_457, "CAD")).toBe(3_704);
  });

  it("never exceeds what is owed, and is zero when nothing is owed", () => {
    expect(inferMinimumPaymentMinor(650, "CAD")).toBe(650);
    expect(inferMinimumPaymentMinor(0, "CAD")).toBe(0);
    expect(inferMinimumPaymentMinor(-500, "CAD")).toBe(0);
  });

  it("scales the floor with the currency exponent", () => {
    expect(inferMinimumPaymentMinor(1_000_000, "JPY")).toBe(30_000);
    expect(inferMinimumPaymentMinor(100, "JPY")).toBe(10);
    expect(inferMinimumPaymentMinor(5, "JPY")).toBe(5);
    expect(inferMinimumPaymentMinor(5_000, "JPY")).toBe(150);
  });
});

describe("normalizers", () => {
  it("honours only a whole due day from 1 to 31", () => {
    expect(normalizePaymentDueDay(1)).toBe(1);
    expect(normalizePaymentDueDay(31)).toBe(31);
    expect(normalizePaymentDueDay(0)).toBeNull();
    expect(normalizePaymentDueDay(32)).toBeNull();
    expect(normalizePaymentDueDay(15.5)).toBeNull();
    expect(normalizePaymentDueDay(null)).toBeNull();
    expect(normalizePaymentDueDay(undefined)).toBeNull();
  });

  it("honours only a positive whole minimum", () => {
    expect(normalizeMinimumPaymentMinor(2_500)).toBe(2_500);
    expect(normalizeMinimumPaymentMinor(0)).toBeNull();
    expect(normalizeMinimumPaymentMinor(-1)).toBeNull();
    expect(normalizeMinimumPaymentMinor(10.5)).toBeNull();
    expect(normalizeMinimumPaymentMinor(null)).toBeNull();
  });
});

describe("computeFinanceCreditPaymentDue", () => {
  it("infers the minimum from the balance owed when none is stored", () => {
    expect(computeFinanceCreditPaymentDue(card(), -150_000, "2026-10-10")).toEqual({
      dueDate: "2026-10-15",
      daysUntil: 5,
      owedMinor: 150_000,
      minimumMinor: 4_500,
      minimumIsEstimate: true,
    });
  });

  it("uses the stored minimum as typed, not estimated", () => {
    expect(
      computeFinanceCreditPaymentDue(card({ minimumPaymentMinor: 6_000 }), -150_000, "2026-10-15"),
    ).toEqual({
      dueDate: "2026-10-15",
      daysUntil: 0,
      owedMinor: 150_000,
      minimumMinor: 6_000,
      minimumIsEstimate: false,
    });
  });

  it("caps a stored minimum at what is owed", () => {
    const due = computeFinanceCreditPaymentDue(
      card({ minimumPaymentMinor: 6_000 }),
      -2_500,
      "2026-10-10",
    );
    expect(due?.minimumMinor).toBe(2_500);
  });

  it("owes nothing when the balance is zero or in credit", () => {
    expect(computeFinanceCreditPaymentDue(card(), 0, "2026-10-10")).toMatchObject({
      owedMinor: 0,
      minimumMinor: 0,
    });
    expect(
      computeFinanceCreditPaymentDue(card({ minimumPaymentMinor: 6_000 }), 12_000, "2026-10-10"),
    ).toMatchObject({ owedMinor: 0, minimumMinor: 0 });
  });

  it("supports a line of credit and a minimum without a due day", () => {
    expect(
      computeFinanceCreditPaymentDue(
        card({ type: "line_of_credit", paymentDueDay: 28 }),
        -100_000,
        "2026-10-10",
      ),
    ).toMatchObject({ dueDate: "2026-10-28", daysUntil: 18, minimumMinor: 3_000 });
    expect(
      computeFinanceCreditPaymentDue(
        card({ paymentDueDay: null, minimumPaymentMinor: 4_000 }),
        -100_000,
        "2026-10-10",
      ),
    ).toMatchObject({ dueDate: null, minimumMinor: 4_000, minimumIsEstimate: false });
  });

  it("returns null for other account types, closed accounts and accounts that did not opt in", () => {
    expect(computeFinanceCreditPaymentDue(card({ type: "loan" }), -100, "2026-10-10")).toBeNull();
    expect(
      computeFinanceCreditPaymentDue(card({ type: "checking" }), -100, "2026-10-10"),
    ).toBeNull();
    expect(computeFinanceCreditPaymentDue(card({ closed: true }), -100, "2026-10-10")).toBeNull();
    expect(
      computeFinanceCreditPaymentDue(card({ paymentDueDay: null }), -100, "2026-10-10"),
    ).toBeNull();
    expect(
      computeFinanceCreditPaymentDue(card({ paymentDueDay: 40 }), -100, "2026-10-10"),
    ).toBeNull();
  });
});
