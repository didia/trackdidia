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

  it("prefers an explicit statement date over an earlier unrelated date range", () => {
    const fr = parseStatementText(
      [
        "Taux promotionnel du 1er janvier 2026 au 31 décembre 2026",
        "Date du relevé : 31 mars 2026",
        "Nouveau solde 1 000,00 $",
      ].join("\n"),
    );
    expect(fr).toMatchObject({ statementDate: "2026-03-31", closingBalanceMinor: 100_000 });
    expect(fr.confidence).toBe("high");

    const en = parseStatementText(
      [
        "Rate effective from January 1, 2026 to December 31, 2026",
        "Statement date: March 31, 2026",
        "New balance $1,000.00",
      ].join("\n"),
    );
    expect(en.statementDate).toBe("2026-03-31");
  });

  it("does not treat an unlabelled range as a trustworthy statement period", () => {
    const result = parseStatementText(
      "Offre du 1er janvier 2026 au 31 décembre 2026\nNouveau solde 10,00 $",
    );
    expect(result.statementDate).toBe("2026-12-31");
    expect(result.confidence).toBe("medium");
  });

  it("lowers confidence when two labelled periods disagree", () => {
    const result = parseStatementText(
      [
        "Période du 1er mars 2026 au 31 mars 2026",
        "Période précédente du 1er février 2026 au 28 février 2026",
        "Nouveau solde 10,00 $",
      ].join("\n"),
    );
    expect(result.confidence).toBe("medium");
  });

  it("reports CR / DR markers on the closing balance", () => {
    expect(parseStatementText("New balance 45.10 CR\nStatement date 2026-03-31")).toMatchObject({
      closingBalanceMinor: 4_510,
      closingBalanceMarker: "CR",
    });
    expect(parseStatementText("New balance 45.10 DR\nStatement date 2026-03-31")).toMatchObject({
      closingBalanceMinor: -4_510,
      closingBalanceMarker: "DR",
    });
    expect(parseStatementText("New balance 45.10").closingBalanceMarker).toBeNull();
  });

  it("reads a two-column credit-card summary where several figures share one visual line", () => {
    // Mirrors a real bank layout (synthetic figures): left and right columns interleave, a rewards
    // balance sits beside the real balance, rates print as "21.99 %", and a foreign purchase
    // mentions USD with a conversion fee.
    const result = parseStatementText(
      [
        "Summary of your account   PAGE 1 of 3",
        "STATEMENT PERIOD AUG 24, 2026 – SEP 23, 2026",
        "PAYMENT INFORMATION   CALCULATING YOUR BALANCE",
        "Minimum Payment   $120.00 Previous balance   $1,000.00",
        "Credit limit   $5,000.00 Payment & credits   -$900.00",
        "Available credit   $3,500.00 New purchases & debits   $1,400.00",
        "$9,250.00   $1,400.00",
        "Available cash limit   Total New Charges   YOUR REWARDS",
        "(included in credit limit)   Total new balance   $1,500.00 Previous Rewards balance   $9.17",
        "Annual Interest Rates   In stores   $0.00",
        "Account Balance   21.99 % Cash Advances   21.99 % Other retailers   $64.57",
        "Based on the rate shown above, we estimate it will take 10 year(s) to repay the Balance",
        "including promotional payment plans not yet due shown above.   New Rewards balance   $73.74",
        "Example Rewards Mastercard",
        "JANE DOE — **** **** **** 2035",
        "15   Sep 03   Sep 04   SNBRU AIR BRUSSELS   $20.81",
        "14.60 USD @ 1.425342465 incl. 2.5% conversion fee",
        "Account number   **** **** **** 2035",
        "Please return this stub with your payment.   Account balance   $1,500.00",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      closingBalanceMinor: 150_000,
      openingBalanceMinor: 100_000,
      statementDate: "2026-09-23",
      periodStart: "2026-08-24",
      accountLast4: "2035",
      currency: null,
      suggestedAccountName: "Example Rewards Mastercard",
      suggestedAccountType: "credit_card",
      confidence: "high",
    });
    // The summary and the payment stub print the same figure: one candidate, not a conflict.
    expect(result.balanceCandidates).toHaveLength(1);
  });

  it("does not read a rewards or available balance as the closing balance", () => {
    const result = parseStatementText(
      "Available balance $900.00\nNew Rewards balance $73.74\nStatement date 2026-03-31",
    );
    expect(result.closingBalanceMinor).toBeNull();
  });

  it("suggests an account type from the wording", () => {
    expect(
      parseStatementText("Chequing account statement\nClosing balance 1.00").suggestedAccountType,
    ).toBe("checking");
    expect(
      parseStatementText("Relevé compte épargne\nSolde de clôture 1,00").suggestedAccountType,
    ).toBe("savings");
    expect(parseStatementText("Closing balance 1.00").suggestedAccountType).toBeNull();
  });

  it("reads a bilingual year-first statement whose captions sit above their values", () => {
    // Synthetic figures in the layout of a Quebec bank card statement: captions on one row, the
    // values on a later row; dates print as "AA MM JJ"; a summary table ends with the new balance.
    const result = parseStatementText(
      [
        "BANQUE EXEMPLE",
        "MASTERCARD EXEMPLE   PAIEMENT",
        "600 RUE EXEMPLE   PAYMENT",
        "NOUVEAU SOLDE   PAIEMENT MIN. DÛ   DATE D’ÉCHÉANCE",
        "NEW BALANCE   MIN. PAYMENT DUE   DUE DATE",
        "DATE DU RELEVÉ",
        "STATEMENT DATE 26 09 17   $170.80   $10.00   2026 10 08",
        "A.- Y .   MO.   J.- D.   A.- Y.   MO.   J.- D.",
        "**** ****** **6651",
        "09 17   I260115550   09 17 FRAIS INTERET   0.13",
        "08 24   0612425659   08 24 PAIEMENT RECU MERCI!   10.00-",
        "NOUVEAU SOLDE DE POINTS   :   19,335",
        "TAUX D’INTÉRÊT / ACHATS   PÉRIODE DU RELEVÉ   DATE DU RELEVÉ",
        "INTEREST RATE / PURCHASES   STATEMENT PERIOD   STATEMENT DATE",
        "20.99 %   22.49 %   26/08/18 AU 26/09/17   26/09/17",
        "SOLDE PRÉCÉDENT   TRANSACTIONS DU MOIS   INTÉRÊTS   FRAIS   PAIEMENTS / CRÉDITS   NOUVEAU SOLDE",
        "PREVIOUS BALANCE   MONTHLY TRANSACTIONS   INTEREST   FEES   PAYMENTS / CREDITS   NEW BALANCE",
        "15.86   170.67   0.00   0.00   15.86   170.67",
        "AVANCES DE FONDS   0.00   212.52   0.13   212.52   0.13",
        "TOTAL   15.86   383.19   0.13   0.00   228.38   170.80",
        "LIMITE DE CRÉDIT   CRÉDIT DISPONIBLE",
        "28,250   28,079",
        "MONTANT ORIGINAL EN DEVISE CAD   50.59",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      closingBalanceMinor: 17_080,
      statementDate: "2026-09-17",
      periodStart: "2026-08-18",
      periodEnd: "2026-09-17",
      accountLast4: "6651",
      currency: "CAD",
      suggestedAccountName: "Mastercard Exemple",
      suggestedInstitution: null,
      suggestedAccountType: "credit_card",
      confidence: "high",
    });
    expect(result.balanceCandidates).toHaveLength(1);
  });

  it("reads year-first dates only when the statement declares year-month-day", () => {
    expect(findDates("26 09 17", "YMD")[0]?.iso).toBe("2026-09-17");
    expect(findDates("26/08/18", "YMD")[0]?.iso).toBe("2026-08-18");
    expect(findDates("2026/10/08")[0]?.iso).toBe("2026-10-08");
    expect(findDates("2026 10 08")[0]?.iso).toBe("2026-10-08");
    expect(findDates("26 09 17")).toEqual([]);
  });

  it("takes the first date after a statement-date label, not the due date", () => {
    const result = parseStatementText(
      "Statement date 2026-03-31   Due date 2026-04-20\nNew balance $10.00",
    );
    expect(result.statementDate).toBe("2026-03-31");
  });

  it("recognises well-known banks", () => {
    expect(
      parseStatementText("National Bank of Canada\nNew balance 1.00").suggestedInstitution,
    ).toBe("Banque Nationale");
    expect(parseStatementText("Relevé Desjardins\nNouveau solde 1,00").suggestedInstitution).toBe(
      "Desjardins",
    );
  });
});
