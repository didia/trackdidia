// AI reading of a statement, used alongside the deterministic parser
// (`../finance/statement-parser.ts`); `../finance/statement-reconcile.ts` compares the two.
// It runs automatically only when the user opted in (`financeAiStatementEnabled`); otherwise
// only after a click, having been shown what is sent.
//
// Privacy contract (docs/ai-settings-and-privacy.md "Finance statement extraction"):
// - Only a *summary window* of the statement text is sent — the first lines of the document plus
//   lines (±1) that mention a balance, a period, or a statement date — capped at 8 000
//   characters. Lines that look like transaction rows are filtered out first (a heuristic).
// - Long digit runs (account / card numbers), email addresses and phone-looking groups are masked
//   first. Names and addresses in the header are NOT redacted: do not describe this as removing
//   personal information.
// - Disabled entirely when AI is off, no key is set, or `aiPayloadScope` is `metrics`.
// - The result is never applied on its own; it only pre-fills or challenges the review form.

import type { FinanceAccountType } from "../../domain/finance";
import type { AppSettings } from "../../domain/types";
import { parseAmountToMinor } from "../finance/money";
import { findAmounts, findDates, type StatementExtraction } from "../finance/statement-parser";
import { chatCompletion } from "./openrouter-client";

const HEADER_LINES = 40;
const MAX_CHARS = 8_000;
const KEYWORD_PATTERN =
  /(solde|balance|relev[eé]|statement|p[eé]riode|period|closing|ending|opening|cl[oô]ture|nouveau|pr[eé]c[eé]dent|previous|date\s+(?:du|de|d['’]|of)|billing)/i;

const maskedRun = (run: string): string => `…${run.replace(/\D/g, "").slice(-4)}`;

/** Account / card numbers, however they are grouped, plus emails and phone-shaped groups. */
export const maskStatementText = (text: string): string =>
  text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // Grouped card numbers: 4532 1234 5678 4242, 4532-1234-5678-4242, Amex 3782 822463 10005.
    .replace(/\b\d{4}(?:[ -]\d{4}){2,4}\b/g, maskedRun)
    .replace(/\b\d{4}[ -]\d{6}[ -]\d{5}\b/g, maskedRun)
    // Hyphen-grouped account / transit numbers (1234-5678901) — but never ISO dates (8 digits).
    .replace(/\b\d{3,}(?:-\d{2,})+\b/g, (run) =>
      run.replace(/\D/g, "").length >= 9 ? maskedRun(run) : run,
    )
    // Contiguous long digit runs, unless they are the whole part of an amount.
    .replace(/\b\d{6,}\b(?![.,]\d{2}\b)/g, maskedRun)
    .replace(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "[tel]");

/** A row that starts with a date and carries an amount without being a balance / period line. */
export const looksLikeTransactionLine = (line: string): boolean => {
  if (KEYWORD_PATTERN.test(line)) {
    return false;
  }
  const [firstDate] = findDates(line);
  return firstDate !== undefined && firstDate.index <= 2 && findAmounts(line).length > 0;
};

/** The bounded, masked excerpt of the statement that would be sent. Exposed for the UI preview. */
export const buildStatementAiExcerpt = (text: string): string => {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !looksLikeTransactionLine(line));
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(HEADER_LINES, lines.length); index += 1) {
    keep.add(index);
  }
  lines.forEach((line, index) => {
    if (KEYWORD_PATTERN.test(line)) {
      keep.add(index - 1);
      keep.add(index);
      keep.add(index + 1);
    }
  });
  const excerpt = [...keep]
    .filter((index) => index >= 0 && index < lines.length)
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join("\n");
  return maskStatementText(excerpt).slice(0, MAX_CHARS);
};

export const isStatementAiAvailable = (settings: AppSettings): boolean =>
  settings.aiEnabled &&
  settings.aiApiKey.trim().length > 0 &&
  settings.aiPayloadScope !== "metrics";

const SYSTEM_PROMPT = `Tu extrais les chiffres cles d'un releve de compte bancaire ou de carte de credit a partir d'extraits de texte (francais ou anglais).
Reponds uniquement avec un objet JSON de la forme:
{"closingBalance": string|null, "openingBalance": string|null, "statementDate": "YYYY-MM-DD"|null, "periodStart": "YYYY-MM-DD"|null, "periodEnd": "YYYY-MM-DD"|null, "accountLast4": string|null, "currency": string|null, "accountName": string|null, "accountType": "checking"|"savings"|"credit_card"|"line_of_credit"|"loan"|"mortgage"|"other"|null, "institution": string|null}
Regles:
- closingBalance: le solde total du compte a la fin de la periode, tel qu'imprime, en notation decimale avec un point (ex "1234.56"), negatif seulement si le releve indique un credit ou un montant negatif. Pour une carte de credit, c'est le solde total / nouveau solde (y compris les versements echelonnes pas encore echus), PAS le montant exigible ce mois-ci, ni le paiement minimum, ni le credit disponible, ni la limite de credit, ni un solde de points ou de remises.
- statementDate: la date de cloture / d'emission du releve (pas la date d'echeance). Les dates peuvent etre ecrites annee-mois-jour (ex "26 09 17" = 2026-09-17).
- accountLast4: les 4 derniers chiffres du numero de carte ou de compte, si visibles.
- accountType: deduis-le de l'en-tete du releve, pas des noms de cartes qui apparaissent dans les transactions.
- N'invente rien: mets null si l'information est absente.`;

const AI_ACCOUNT_TYPES: FinanceAccountType[] = [
  "checking",
  "savings",
  "credit_card",
  "line_of_credit",
  "loan",
  "mortgage",
  "other",
];

export const stripJsonFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

const asIsoDate = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const [date] = findDates(value.trim());
  return date && date.iso === value.trim() ? date.iso : null;
};

const asMinor = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/[$\s]/g, "");
  // The prompt asks for a dot decimal; tolerate a lone decimal comma ("12,50") and stray groupings.
  const dotted = /^-?\d+,\d{2}$/.test(trimmed)
    ? trimmed.replace(",", ".")
    : trimmed.replace(/,/g, "");
  const parsed = parseAmountToMinor(dotted, { decimalSeparator: ".", thousandsSeparator: "" });
  return parsed.ok ? parsed.amountMinor : null;
};

export const parseStatementAiResponse = (text: string): StatementExtraction | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFences(text));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const closingBalanceMinor = asMinor(record.closingBalance);
  const periodEnd = asIsoDate(record.periodEnd);
  const statementDate = asIsoDate(record.statementDate) ?? periodEnd;
  const last4 =
    typeof record.accountLast4 === "string" && /^\d{4}$/.test(record.accountLast4.trim())
      ? record.accountLast4.trim()
      : null;
  const currency =
    typeof record.currency === "string" && /^[A-Za-z]{3}$/.test(record.currency.trim())
      ? record.currency.trim().toUpperCase()
      : null;
  if (closingBalanceMinor === null && statementDate === null) {
    return null;
  }
  const shortText = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
      ? value.trim()
      : null;
  const accountType = AI_ACCOUNT_TYPES.find((type) => type === record.accountType) ?? null;
  return {
    closingBalanceMinor,
    closingBalanceMarker: null,
    openingBalanceMinor: asMinor(record.openingBalance),
    statementDate,
    periodStart: asIsoDate(record.periodStart),
    periodEnd,
    accountLast4: last4,
    currency,
    suggestedAccountName: shortText(record.accountName, 60),
    suggestedInstitution: shortText(record.institution, 40),
    suggestedAccountType: accountType,
    balanceCandidates: [],
    dateAmbiguous: false,
    // An AI reading is never "high": the user must confirm it against the statement.
    confidence: closingBalanceMinor !== null && statementDate !== null ? "medium" : "low",
    source: "ai",
  };
};

export const extractStatementWithAi = async (
  text: string,
  settings: AppSettings,
): Promise<StatementExtraction | null> => {
  if (!isStatementAiAvailable(settings)) {
    return null;
  }
  const result = await chatCompletion({
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiSurfaceModels.finance_categorization?.trim() || settings.aiModel,
    temperature: 0,
    maxTokens: Math.min(settings.aiMaxTokens, 600),
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildStatementAiExcerpt(text) },
    ],
    timeoutMs: settings.aiTimeoutMs,
    transport: "fetch",
    retry: true,
  });
  return parseStatementAiResponse(result.text);
};
