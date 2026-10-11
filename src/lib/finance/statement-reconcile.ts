// Compares the deterministic parser's reading of a statement with the AI's reading and produces
// the values the review form starts from. Pure — no I/O. See docs/finance.md "Statement import".
//
// Rules, in order of trust:
// - The parser's value is the default whenever it found one: it is deterministic and tested.
// - The AI fills whatever the parser could not find (and only that).
// - Where both found a value and they differ, the parser's value stays and the difference is
//   reported so the form can offer the AI's value with one click — never applied silently.
// - Balances are compared by magnitude: the parser keeps the printed CR/DR sign, the AI is told to
//   use a negative number for a credit, so only the figure is comparable.
// - An AI-only reading is never "high" confidence.

import type { StatementExtraction } from "./statement-parser";

export type StatementDisagreementField = "closingBalance" | "statementDate" | "accountLast4";

export interface StatementDisagreement {
  field: StatementDisagreementField;
  parserValue: string | number;
  aiValue: string | number;
}

export interface ReconciledStatement {
  extraction: StatementExtraction;
  disagreements: StatementDisagreement[];
}

const sameMagnitude = (a: number, b: number): boolean => Math.abs(a) === Math.abs(b);

export const reconcileStatementExtractions = (
  parser: StatementExtraction,
  ai: StatementExtraction | null,
): ReconciledStatement => {
  if (!ai) {
    return { extraction: parser, disagreements: [] };
  }

  const disagreements: StatementDisagreement[] = [];

  let closingBalanceMinor = parser.closingBalanceMinor;
  let closingBalanceMarker = parser.closingBalanceMarker;
  let balanceAgrees = false;
  if (parser.closingBalanceMinor === null) {
    closingBalanceMinor = ai.closingBalanceMinor;
    closingBalanceMarker = null;
  } else if (ai.closingBalanceMinor !== null) {
    if (sameMagnitude(parser.closingBalanceMinor, ai.closingBalanceMinor)) {
      balanceAgrees = true;
    } else {
      disagreements.push({
        field: "closingBalance",
        parserValue: parser.closingBalanceMinor,
        aiValue: ai.closingBalanceMinor,
      });
    }
  }

  let statementDate = parser.statementDate;
  let dateAgrees = false;
  if (parser.statementDate === null) {
    statementDate = ai.statementDate;
  } else if (ai.statementDate !== null) {
    if (parser.statementDate === ai.statementDate) {
      dateAgrees = true;
    } else {
      disagreements.push({
        field: "statementDate",
        parserValue: parser.statementDate,
        aiValue: ai.statementDate,
      });
    }
  }

  let accountLast4 = parser.accountLast4;
  if (parser.accountLast4 === null) {
    accountLast4 = ai.accountLast4;
  } else if (ai.accountLast4 !== null && ai.accountLast4 !== parser.accountLast4) {
    disagreements.push({
      field: "accountLast4",
      parserValue: parser.accountLast4,
      aiValue: ai.accountLast4,
    });
  }

  const aiOnlyBalance = parser.closingBalanceMinor === null && ai.closingBalanceMinor !== null;
  const aiOnlyDate = parser.statementDate === null && ai.statementDate !== null;

  let confidence = parser.confidence;
  if (disagreements.length > 0) {
    confidence = "medium";
  } else if (balanceAgrees && dateAgrees && !parser.dateAmbiguous) {
    // Two independent readings of the same figure and date: the strongest signal we have.
    confidence = "high";
  } else if (aiOnlyBalance || aiOnlyDate) {
    // Only the AI saw it; never better than "medium", never "high".
    confidence = closingBalanceMinor !== null && statementDate !== null ? "medium" : "low";
  }

  return {
    extraction: {
      ...parser,
      closingBalanceMinor,
      closingBalanceMarker,
      statementDate,
      periodStart: parser.periodStart ?? ai.periodStart,
      periodEnd: parser.periodEnd ?? ai.periodEnd,
      openingBalanceMinor: parser.openingBalanceMinor ?? ai.openingBalanceMinor,
      accountLast4,
      currency: parser.currency ?? ai.currency,
      suggestedAccountName: parser.suggestedAccountName ?? ai.suggestedAccountName,
      suggestedInstitution: parser.suggestedInstitution ?? ai.suggestedInstitution,
      suggestedAccountType: parser.suggestedAccountType ?? ai.suggestedAccountType,
      confidence,
      source: "pdf-text+ai",
    },
    disagreements,
  };
};
