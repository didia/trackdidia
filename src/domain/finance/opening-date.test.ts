import { describe, expect, it } from "vitest";
import type { FinanceImportRow } from "../finance";
import {
  effectiveOpeningDate,
  openingDateSkipWarning,
  partitionRowsByOpeningDate,
  selectTransactionsBeforeOpeningDate,
} from "./opening-date";

const row = (accountId: string, postedDate: string): FinanceImportRow => ({
  accountId,
  postedDate,
  amountMinor: -100,
  currency: "CAD",
  descriptionRaw: "IGA",
  descriptionOriginal: null,
  merchantKey: "IGA",
  categoryHint: null,
  personId: null,
  notes: null,
  labelsJson: null,
  sourceRowJson: null,
});

describe("partitionRowsByOpeningDate", () => {
  const accounts = new Map([
    ["a", { balanceAsOf: "2026-03-01" }],
    ["b", { balanceAsOf: null }],
    ["c", { balanceAsOf: "2026-06-01" }],
  ]);

  it("skips rows strictly before the date and keeps the date itself", () => {
    const result = partitionRowsByOpeningDate(
      [row("a", "2026-02-28"), row("a", "2026-03-01"), row("a", "2026-03-02")],
      accounts,
    );
    expect(result.kept.map((r) => r.postedDate)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual([{ accountId: "a", openingDate: "2026-03-01", count: 1 }]);
  });

  it("never skips an account without an opening date or an unknown account", () => {
    const result = partitionRowsByOpeningDate(
      [row("b", "2000-01-01"), row("missing", "2000-01-01")],
      accounts,
    );
    expect(result.kept).toHaveLength(2);
    expect(result.skippedCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("counts per account and keeps the original order", () => {
    const result = partitionRowsByOpeningDate(
      [
        row("a", "2026-01-01"),
        row("c", "2026-07-01"),
        row("c", "2026-01-01"),
        row("a", "2026-01-02"),
      ],
      accounts,
    );
    expect(result.kept.map((r) => `${r.accountId}:${r.postedDate}`)).toEqual(["c:2026-07-01"]);
    expect(result.skipped).toEqual([
      { accountId: "a", openingDate: "2026-03-01", count: 2 },
      { accountId: "c", openingDate: "2026-06-01", count: 1 },
    ]);
    expect(result.skippedCount).toBe(3);
  });
});

describe("selectTransactionsBeforeOpeningDate", () => {
  const txns = [
    { id: "1", postedDate: "2026-02-28" },
    { id: "2", postedDate: "2026-03-01" },
    { id: "3", postedDate: "2026-04-01" },
  ];

  it("returns only transactions strictly before the opening date", () => {
    expect(
      selectTransactionsBeforeOpeningDate({ balanceAsOf: "2026-03-01" }, txns).map((t) => t.id),
    ).toEqual(["1"]);
  });

  it("returns nothing without an opening date", () => {
    expect(selectTransactionsBeforeOpeningDate({ balanceAsOf: null }, txns)).toEqual([]);
  });
});

describe("openingDateSkipWarning", () => {
  it("names the account, the count and the date", () => {
    expect(
      openingDateSkipWarning({ accountId: "a", openingDate: "2026-03-01", count: 4 }, "Chèques"),
    ).toContain('4 row(s) for "Chèques" dated before its opening balance date (2026-03-01)');
  });
});

describe("effectiveOpeningDate", () => {
  it("is the stored date for an account without a statement anchor", () => {
    expect(effectiveOpeningDate({ balanceAsOf: "2026-03-01" }, false)).toBe("2026-03-01");
  });

  it("is null when a statement anchors the account, whatever the stored date", () => {
    expect(effectiveOpeningDate({ balanceAsOf: "2026-03-01" }, true)).toBeNull();
  });

  it("is null for a missing or empty date", () => {
    expect(effectiveOpeningDate({ balanceAsOf: null }, false)).toBeNull();
    expect(effectiveOpeningDate({ balanceAsOf: "" }, false)).toBeNull();
  });
});
