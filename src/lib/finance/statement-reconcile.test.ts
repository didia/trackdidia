import { describe, expect, it } from "vitest";
import { reconcileStatementExtractions } from "./statement-reconcile";
import { emptyStatementExtraction, type StatementExtraction } from "./statement-parser";

const reading = (overrides: Partial<StatementExtraction>): StatementExtraction => ({
  ...emptyStatementExtraction(),
  ...overrides,
});

describe("reconcileStatementExtractions", () => {
  it("returns the parser reading untouched when there is no AI reading", () => {
    const parser = reading({
      closingBalanceMinor: 100,
      statementDate: "2026-09-20",
      confidence: "high",
    });
    expect(reconcileStatementExtractions(parser, null)).toEqual({
      extraction: parser,
      disagreements: [],
    });
  });

  it("is high confidence when both readings agree on balance and date", () => {
    const parser = reading({
      closingBalanceMinor: 656_674,
      statementDate: "2026-09-20",
      confidence: "medium", // e.g. the parser saw a competing "balance due" candidate
    });
    const ai = reading({ closingBalanceMinor: 656_674, statementDate: "2026-09-20", source: "ai" });
    const result = reconcileStatementExtractions(parser, ai);
    expect(result.disagreements).toEqual([]);
    expect(result.extraction.confidence).toBe("high");
    expect(result.extraction.source).toBe("pdf-text+ai");
  });

  it("compares balances by magnitude so a printed CR is not a disagreement", () => {
    const parser = reading({
      closingBalanceMinor: 4_510,
      closingBalanceMarker: "CR",
      statementDate: "2026-03-31",
    });
    const ai = reading({ closingBalanceMinor: -4_510, statementDate: "2026-03-31", source: "ai" });
    const result = reconcileStatementExtractions(parser, ai);
    expect(result.disagreements).toEqual([]);
    expect(result.extraction.closingBalanceMinor).toBe(4_510);
    expect(result.extraction.closingBalanceMarker).toBe("CR");
  });

  it("keeps the parser value and reports the AI value when they differ", () => {
    const parser = reading({
      closingBalanceMinor: 656_674,
      statementDate: "2026-08-20",
      accountLast4: "4113",
      confidence: "high",
    });
    const ai = reading({
      closingBalanceMinor: 506_745,
      statementDate: "2026-09-20",
      accountLast4: "9999",
      source: "ai",
    });
    const result = reconcileStatementExtractions(parser, ai);
    expect(result.extraction.closingBalanceMinor).toBe(656_674);
    expect(result.extraction.statementDate).toBe("2026-08-20");
    expect(result.extraction.accountLast4).toBe("4113");
    expect(result.extraction.confidence).toBe("medium");
    expect(result.disagreements).toEqual([
      { field: "closingBalance", parserValue: 656_674, aiValue: 506_745 },
      { field: "statementDate", parserValue: "2026-08-20", aiValue: "2026-09-20" },
      { field: "accountLast4", parserValue: "4113", aiValue: "9999" },
    ]);
  });

  it("lets the AI fill what the parser could not find, but never as high confidence", () => {
    const parser = reading({ confidence: "low", suggestedAccountType: "checking" });
    const ai = reading({
      closingBalanceMinor: 12_345,
      statementDate: "2026-09-20",
      accountLast4: "7713",
      currency: "CAD",
      suggestedAccountName: "Forfait courant",
      suggestedInstitution: "RBC",
      suggestedAccountType: "savings",
      source: "ai",
    });
    const { extraction } = reconcileStatementExtractions(parser, ai);
    expect(extraction).toMatchObject({
      closingBalanceMinor: 12_345,
      closingBalanceMarker: null,
      statementDate: "2026-09-20",
      accountLast4: "7713",
      currency: "CAD",
      suggestedAccountName: "Forfait courant",
      suggestedInstitution: "RBC",
      // the parser's non-null value wins
      suggestedAccountType: "checking",
      confidence: "medium",
    });
  });

  it("keeps the parser confidence when the AI adds nothing, and stays low when only a balance is found", () => {
    const parser = reading({ statementDate: "2026-09-20", confidence: "medium" });
    const ai = reading({ closingBalanceMinor: null, statementDate: "2026-09-20", source: "ai" });
    expect(reconcileStatementExtractions(parser, ai).extraction.confidence).toBe("medium");
    const onlyBalance = reconcileStatementExtractions(
      reading({ confidence: "low" }),
      reading({ closingBalanceMinor: 5, source: "ai" }),
    );
    expect(onlyBalance.extraction.confidence).toBe("low");
  });

  it("does not upgrade to high when the parser flagged the date as ambiguous", () => {
    const parser = reading({
      closingBalanceMinor: 100,
      statementDate: "2026-05-04",
      dateAmbiguous: true,
      confidence: "medium",
    });
    const ai = reading({ closingBalanceMinor: 100, statementDate: "2026-05-04", source: "ai" });
    expect(reconcileStatementExtractions(parser, ai).extraction.confidence).toBe("medium");
  });
});
