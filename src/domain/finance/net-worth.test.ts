import { describe, expect, it } from "vitest";
import {
  buildFinanceNetWorthHistory,
  classifyFinanceAccountKind,
  computeFinanceNetWorth,
  type FinanceNetWorthAccountInput,
  type FinanceNetWorthTransactionInput,
} from "./net-worth";

const CHECKING = "account-checking";
const INVESTMENT = "account-investment";
const CREDIT_CARD = "account-credit-card";
const MORTGAGE = "account-mortgage";
const EUR_SAVINGS = "account-eur-savings";

const accounts: FinanceNetWorthAccountInput[] = [
  { id: CHECKING, type: "checking", currency: "CAD", closed: false, openingBalanceMinor: 100_00 },
  {
    id: INVESTMENT,
    type: "investment",
    currency: "CAD",
    closed: false,
    openingBalanceMinor: 5_000_00,
  },
  {
    id: CREDIT_CARD,
    type: "credit_card",
    currency: "CAD",
    closed: false,
    openingBalanceMinor: 0,
  },
  { id: MORTGAGE, type: "mortgage", currency: "CAD", closed: false, openingBalanceMinor: 0 },
  {
    id: EUR_SAVINGS,
    type: "savings",
    currency: "EUR",
    closed: false,
    openingBalanceMinor: 1_000_00,
  },
];

const transactions: FinanceNetWorthTransactionInput[] = [
  { accountId: CHECKING, postedDate: "2026-01-05", amountMinor: 200_00 },
  { accountId: CHECKING, postedDate: "2026-02-10", amountMinor: -50_00 }, // after asOfDate
  { accountId: CREDIT_CARD, postedDate: "2026-01-10", amountMinor: -300_00 }, // owe 300
  { accountId: MORTGAGE, postedDate: "2026-01-01", amountMinor: -200_000_00 }, // owe 200000
  { accountId: EUR_SAVINGS, postedDate: "2026-01-02", amountMinor: 50_00 },
];

describe("classifyFinanceAccountKind", () => {
  it("classifies credit/loan/mortgage/line-of-credit as liabilities, everything else as assets", () => {
    expect(classifyFinanceAccountKind("credit_card")).toBe("liability");
    expect(classifyFinanceAccountKind("line_of_credit")).toBe("liability");
    expect(classifyFinanceAccountKind("loan")).toBe("liability");
    expect(classifyFinanceAccountKind("mortgage")).toBe("liability");
    expect(classifyFinanceAccountKind("checking")).toBe("asset");
    expect(classifyFinanceAccountKind("investment")).toBe("asset");
    expect(classifyFinanceAccountKind("asset")).toBe("asset");
  });
});

describe("computeFinanceNetWorth", () => {
  it("matches a hand-computed assets-minus-liabilities fixture, as of a date", () => {
    const snapshot = computeFinanceNetWorth({
      asOfDate: "2026-01-31",
      baseCurrency: "CAD",
      accounts,
      transactions,
    });

    // Assets (CAD only): checking 100+200=300; investment 5000 (off-budget, still counted).
    expect(snapshot.assetsMinor).toBe(300_00 + 5_000_00);
    // Liabilities (CAD only): credit card owes 300; mortgage owes 200000.
    expect(snapshot.liabilitiesMinor).toBe(300_00 + 200_000_00);
    expect(snapshot.netWorthMinor).toBe(snapshot.assetsMinor - snapshot.liabilitiesMinor);
  });

  it("excludes a transaction dated after asOfDate", () => {
    const snapshot = computeFinanceNetWorth({
      asOfDate: "2026-01-31",
      baseCurrency: "CAD",
      accounts: [accounts[0]],
      transactions,
    });
    const checkingLine = snapshot.accounts.find((line) => line.accountId === CHECKING);
    expect(checkingLine?.balanceMinor).toBe(100_00 + 200_00);
  });

  it("excludes non-base-currency accounts from totals and lists them in excludedCurrencies", () => {
    const snapshot = computeFinanceNetWorth({
      asOfDate: "2026-01-31",
      baseCurrency: "CAD",
      accounts,
      transactions,
    });
    expect(snapshot.excludedCurrencies).toEqual(["EUR"]);
    const eurLine = snapshot.accounts.find((line) => line.accountId === EUR_SAVINGS);
    expect(eurLine?.includedInTotal).toBe(false);
    // 1000 opening + 50 txn = 1050, but not counted in assetsMinor above.
    expect(eurLine?.balanceMinor).toBe(1_050_00);
  });

  it("includes off-budget accounts in the per-account list", () => {
    const snapshot = computeFinanceNetWorth({
      asOfDate: "2026-01-31",
      baseCurrency: "CAD",
      accounts,
      transactions,
    });
    expect(snapshot.accounts.some((line) => line.accountId === INVESTMENT)).toBe(true);
  });
});

describe("buildFinanceNetWorthHistory", () => {
  it("sums signed account balances per day across base-currency accounts only", () => {
    const history = buildFinanceNetWorthHistory(
      [
        { accountId: CHECKING, asOfDate: "2026-01-01", balanceMinor: 100_00 },
        { accountId: CREDIT_CARD, asOfDate: "2026-01-01", balanceMinor: -300_00 },
        { accountId: EUR_SAVINGS, asOfDate: "2026-01-01", balanceMinor: 1_000_00 },
        { accountId: CHECKING, asOfDate: "2026-01-02", balanceMinor: 150_00 },
        { accountId: CREDIT_CARD, asOfDate: "2026-01-02", balanceMinor: -300_00 },
      ],
      accounts,
      "CAD",
    );
    expect(history).toEqual([
      { asOfDate: "2026-01-01", netWorthMinor: 100_00 - 300_00 },
      { asOfDate: "2026-01-02", netWorthMinor: 150_00 - 300_00 },
    ]);
  });
});
