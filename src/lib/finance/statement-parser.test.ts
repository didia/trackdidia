import { describe, expect, it } from "vitest";
import { findAmounts, findDates, parseStatementText } from "./statement-parser";

describe("findAmounts", () => {
  it("reads French and English formatted amounts", () => {
    expect(findAmounts("Nouveau solde 1 234,56 $")[0].amountMinor).toBe(123_456);
    expect(findAmounts("Closing balance $1,234.56")[0].amountMinor).toBe(123_456);
    expect(findAmounts("Solde 1 234,56 $")[0].amountMinor).toBe(123_456);
  });

  it("handles negatives, parentheses, and CR/DR markers", () => {
    expect(findAmounts("Balance -45.10")[0].amountMinor).toBe(-4_510);
    expect(findAmounts("Balance (45.10)")[0].amountMinor).toBe(-4_510);
    expect(findAmounts("Balance 45.10 DR")[0].amountMinor).toBe(-4_510);
    expect(findAmounts("Balance 45.10 CR")[0].amountMinor).toBe(4_510);
  });

  it("does not read dates or reference numbers as amounts", () => {
    expect(findAmounts("Relevé du 31.03.2026")).toEqual([]);
    expect(findAmounts("Date 2026-03-31 réf 12345")).toEqual([]);
  });

  it("returns every amount in a row in reading order", () => {
    expect(
      findAmounts("Solde précédent 100,00 Nouveau solde 250,50").map((a) => a.amountMinor),
    ).toEqual([10_000, 25_050]);
  });
});

describe("findDates", () => {
  it("parses ISO, numeric, and month-name dates", () => {
    expect(findDates("2026-03-31")[0].iso).toBe("2026-03-31");
    expect(findDates("31/03/2026")[0]).toMatchObject({ iso: "2026-03-31", ambiguous: false });
    expect(findDates("03/31/2026")[0].iso).toBe("2026-03-31");
    expect(findDates("31 mars 2026")[0].iso).toBe("2026-03-31");
    expect(findDates("1er février 2026")[0].iso).toBe("2026-02-01");
    expect(findDates("8 août 2026")[0].iso).toBe("2026-08-08");
    expect(findDates("March 31, 2026")[0].iso).toBe("2026-03-31");
    expect(findDates("Dec 5 2025")[0].iso).toBe("2025-12-05");
  });

  it("flags day/month ambiguity and honours the configured order", () => {
    expect(findDates("04/05/2026")[0]).toMatchObject({ iso: "2026-05-04", ambiguous: true });
    expect(findDates("04/05/2026", "MDY")[0]).toMatchObject({ iso: "2026-04-05", ambiguous: true });
  });

  it("rejects impossible dates", () => {
    expect(findDates("2026-02-31")).toEqual([]);
    expect(findDates("31/02/2026")).toEqual([]);
  });
});

describe("parseStatementText", () => {
  it("reads a French chequing statement", () => {
    const result = parseStatementText(
      [
        "RELEVÉ DE COMPTE",
        "Compte chèques n° 1234-5678901",
        "Période du 1er mars 2026 au 31 mars 2026",
        "Solde précédent 2 000,00 $",
        "Dépôts 1 500,00 $",
        "Nouveau solde 1 234,56 $",
        "Solde disponible 1 200,00 $",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      closingBalanceMinor: 123_456,
      openingBalanceMinor: 200_000,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      statementDate: "2026-03-31",
      accountLast4: "8901",
      confidence: "high",
      source: "pdf-text",
    });
  });

  it("reads an English credit-card statement and ignores credit limit / minimum payment", () => {
    const result = parseStatementText(
      [
        "Visa Statement",
        "Card number: **** **** **** 4242",
        "Statement date: March 31, 2026",
        "Credit limit $5,000.00",
        "Minimum payment $25.00",
        "Previous balance $800.00",
        "New balance $1,046.17",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      closingBalanceMinor: 104_617,
      openingBalanceMinor: 80_000,
      statementDate: "2026-03-31",
      accountLast4: "4242",
      confidence: "high",
    });
  });

  it("falls back to the date printed on the balance line", () => {
    const result = parseStatementText("Solde au 31 mars 2026   5 678,90 $");
    expect(result).toMatchObject({ closingBalanceMinor: 567_890, statementDate: "2026-03-31" });
  });

  it("reads a balance whose figure is on the next line", () => {
    const result = parseStatementText("Closing balance\n$9,999.99\nStatement date 2026-01-31");
    expect(result).toMatchObject({ closingBalanceMinor: 999_999, statementDate: "2026-01-31" });
  });

  it("reads a period range split across two lines", () => {
    const result = parseStatementText(
      "Période du 1er avril 2026\nau 30 avril 2026\nSolde final 10,00 $",
    );
    expect(result).toMatchObject({ periodEnd: "2026-04-30", statementDate: "2026-04-30" });
  });

  it("downgrades confidence for ambiguous dates and competing balances", () => {
    const ambiguous = parseStatementText("Statement date 04/05/2026\nClosing balance 10.00");
    expect(ambiguous.dateAmbiguous).toBe(true);
    expect(ambiguous.confidence).toBe("medium");

    const multi = parseStatementText(
      "Statement date 2026-03-31\nClosing balance 10.00\nNew balance 20.00",
    );
    expect(multi.balanceCandidates).toHaveLength(2);
    expect(multi.confidence).toBe("medium");
  });

  it("returns nothing with low confidence for unrelated text", () => {
    const result = parseStatementText("Bonjour, voici votre facture d'électricité.");
    expect(result).toMatchObject({
      closingBalanceMinor: null,
      statementDate: null,
      confidence: "low",
    });
  });

  it("detects currency codes", () => {
    expect(parseStatementText("Statement CAD\nClosing balance 1.00").currency).toBe("CAD");
  });
});
