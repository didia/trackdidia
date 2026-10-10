import { describe, expect, it } from "vitest";
import {
  computeOpeningBalanceForStatement,
  isLiabilityAccountType,
  statementAmountToAccountBalanceMinor,
} from "./statement-balance";

describe("statementAmountToAccountBalanceMinor", () => {
  it("keeps asset balances as printed", () => {
    expect(statementAmountToAccountBalanceMinor("checking", 123_456)).toBe(123_456);
    expect(statementAmountToAccountBalanceMinor("savings", 0)).toBe(0);
  });

  it("stores an amount owed on a liability as a negative balance", () => {
    expect(statementAmountToAccountBalanceMinor("credit_card", 98_765)).toBe(-98_765);
    expect(statementAmountToAccountBalanceMinor("mortgage", 250_000_00)).toBe(-250_000_00);
  });

  it("turns a printed credit on a liability into a positive balance", () => {
    expect(statementAmountToAccountBalanceMinor("credit_card", -5_000)).toBe(5_000);
  });

  it("classifies liability account types", () => {
    expect(isLiabilityAccountType("line_of_credit")).toBe(true);
    expect(isLiabilityAccountType("investment")).toBe(false);
  });
});

describe("computeOpeningBalanceForStatement", () => {
  it("re-bases the opening balance so the balance at the statement date matches", () => {
    const transactions = [
      { postedDate: "2026-02-10", amountMinor: -40_00 },
      { postedDate: "2026-03-31", amountMinor: 100_00 },
      { postedDate: "2026-04-02", amountMinor: -25_00 },
    ];
    const opening = computeOpeningBalanceForStatement(1_000_00, "2026-03-31", transactions);
    expect(opening).toBe(1_000_00 - 60_00);
    // balance at statement date equals the statement; the later txn flows on top
    const atStatement = opening + 60_00;
    expect(atStatement).toBe(1_000_00);
    expect(opening + transactions.reduce((sum, txn) => sum + txn.amountMinor, 0)).toBe(975_00);
  });

  it("equals the statement balance when the account has no transactions", () => {
    expect(computeOpeningBalanceForStatement(-300_00, "2026-03-31", [])).toBe(-300_00);
  });
});
