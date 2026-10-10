import { describe, expect, it } from "vitest";
import { parseStatementText } from "../../lib/finance/statement-parser";
import {
  isLiabilityAccountType,
  statementAmountToAccountBalanceMinor,
  statementInputToAccountBalanceMinor,
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

describe("statementInputToAccountBalanceMinor", () => {
  it("keeps the printed convention when there is no marker", () => {
    expect(statementInputToAccountBalanceMinor("credit_card", "1046.17", 104_617)).toBe(-104_617);
    expect(statementInputToAccountBalanceMinor("credit_card", "-45.10", -4_510)).toBe(4_510);
    expect(statementInputToAccountBalanceMinor("checking", "10.00", 1_000)).toBe(1_000);
  });

  it("uses CR as a credit and DR as owed on a card, without negating again", () => {
    expect(statementInputToAccountBalanceMinor("credit_card", "45.10 CR", 4_510)).toBe(4_510);
    expect(statementInputToAccountBalanceMinor("credit_card", "1046.17 DR", -104_617)).toBe(
      -104_617,
    );
  });

  it("uses markers the same way on an asset account", () => {
    expect(statementInputToAccountBalanceMinor("checking", "20.00 DR", -2_000)).toBe(-2_000);
    expect(statementInputToAccountBalanceMinor("checking", "20.00 cr", 2_000)).toBe(2_000);
  });

  it("parses the marker from a real statement line end to end", () => {
    const owed = parseStatementText("New balance 1,046.17 DR\nStatement date 2026-03-31");
    const credit = parseStatementText("New balance 45.10 CR\nStatement date 2026-03-31");
    expect(owed.closingBalanceMarker).toBe("DR");
    expect(credit.closingBalanceMarker).toBe("CR");
    expect(
      statementInputToAccountBalanceMinor(
        "credit_card",
        "1046.17 DR",
        owed.closingBalanceMinor ?? 0,
      ),
    ).toBe(-104_617);
    expect(
      statementInputToAccountBalanceMinor(
        "credit_card",
        "45.10 CR",
        credit.closingBalanceMinor ?? 0,
      ),
    ).toBe(4_510);
  });
});
