// Deterministic extraction of the headline figures of a bank / credit-card statement from its
// plain text (as produced by `statement-pdf.ts`). Pure — no I/O. French and English labels.
// See docs/finance.md "Statement import".
//
// This is a best-effort heuristic: the UI always shows what was found and lets the user correct
// it before anything is written. `balanceCandidates` exposes every plausible closing-balance line
// so a multi-account statement can be resolved with one click.

import { parseAmountToMinor } from "./money";

export interface StatementBalanceCandidate {
  /** The amount exactly as printed (liabilities print what is owed as a positive number). */
  amountMinor: number;
  /** The statement line the amount was read from, trimmed. */
  line: string;
}

export interface StatementExtraction {
  /** Closing / new balance as printed. */
  closingBalanceMinor: number | null;
  /** Opening / previous balance as printed. */
  openingBalanceMinor: number | null;
  /** Closing date of the statement (`YYYY-MM-DD`). */
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Last four digits of the account / card number when the statement masks it. */
  accountLast4: string | null;
  currency: string | null;
  balanceCandidates: StatementBalanceCandidate[];
  /** True when the only date readings were `dd/mm` vs `mm/dd` ambiguous. */
  dateAmbiguous: boolean;
  confidence: "high" | "medium" | "low";
  source: "pdf-text" | "ai";
}

export type StatementDateOrder = "DMY" | "MDY";

export interface ParseStatementOptions {
  /** How to read an all-numeric `a/b/yyyy` date when both parts are ≤ 12. Defaults to `DMY`. */
  dateOrder?: StatementDateOrder;
}

const MONTHS: Record<string, number> = {
  janvier: 1,
  janv: 1,
  jan: 1,
  january: 1,
  fevrier: 2,
  fevr: 2,
  fev: 2,
  feb: 2,
  february: 2,
  mars: 3,
  mar: 3,
  march: 3,
  avril: 4,
  avr: 4,
  apr: 4,
  april: 4,
  mai: 5,
  may: 5,
  juin: 6,
  jun: 6,
  june: 6,
  juillet: 7,
  juil: 7,
  jul: 7,
  july: 7,
  aout: 8,
  aug: 8,
  august: 8,
  septembre: 9,
  sept: 9,
  sep: 9,
  september: 9,
  octobre: 10,
  oct: 10,
  october: 10,
  novembre: 11,
  nov: 11,
  november: 11,
  decembre: 12,
  dec: 12,
  december: 12,
};

const stripAccents = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "");

const normalizeText = (text: string): string =>
  text
    .replace(/[\u00a0\u202f\u2009]/g, " ")
    .replace(/\u2212/g, "-")
    .replace(/\r\n?/g, "\n");

const isRealDate = (year: number, month: number, day: number): boolean => {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
};

const toIso = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

interface FoundDate {
  iso: string;
  index: number;
  length: number;
  ambiguous: boolean;
}

const MONTH_WORD = "[A-Za-zÀ-ÿ]{3,9}\\.?";

/** Every date mentioned in `line`, in reading order. */
export const findDates = (line: string, dateOrder: StatementDateOrder = "DMY"): FoundDate[] => {
  const found: FoundDate[] = [];
  const text = normalizeText(line);

  const consumed: [number, number][] = [];
  const overlaps = (start: number, end: number) =>
    consumed.some(([from, to]) => start < to && end > from);
  const push = (date: FoundDate) => {
    if (!overlaps(date.index, date.index + date.length)) {
      consumed.push([date.index, date.index + date.length]);
      found.push(date);
    }
  };

  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [raw, year, month, day] = match;
    if (isRealDate(Number(year), Number(month), Number(day))) {
      push({
        iso: toIso(Number(year), Number(month), Number(day)),
        index: match.index ?? 0,
        length: raw.length,
        ambiguous: false,
      });
    }
  }

  // "31 mars 2026", "1er mars 2026", "31 Mar. 2026"
  for (const match of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(${MONTH_WORD})\\s*,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    const month = MONTHS[stripAccents(match[2].replace(/\.$/, "")).toLowerCase()];
    if (month && isRealDate(Number(match[3]), month, Number(match[1]))) {
      push({
        iso: toIso(Number(match[3]), month, Number(match[1])),
        index: match.index ?? 0,
        length: match[0].length,
        ambiguous: false,
      });
    }
  }

  // "March 31, 2026", "Mar 31 2026"
  for (const match of text.matchAll(
    new RegExp(`\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    const month = MONTHS[stripAccents(match[1].replace(/\.$/, "")).toLowerCase()];
    if (month && isRealDate(Number(match[3]), month, Number(match[2]))) {
      push({
        iso: toIso(Number(match[3]), month, Number(match[2])),
        index: match.index ?? 0,
        length: match[0].length,
        ambiguous: false,
      });
    }
  }

  // "31/03/2026", "03-31-2026", "31.03.2026"
  for (const match of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    let day: number;
    let month: number;
    let ambiguous = false;
    if (first > 12) {
      day = first;
      month = second;
    } else if (second > 12) {
      month = first;
      day = second;
    } else {
      ambiguous = first !== second;
      [day, month] = dateOrder === "DMY" ? [first, second] : [second, first];
    }
    if (isRealDate(year, month, day)) {
      push({
        iso: toIso(year, month, day),
        index: match.index ?? 0,
        length: match[0].length,
        ambiguous,
      });
    }
  }

  return found.sort((a, b) => a.index - b.index);
};

const AMOUNT_PATTERN =
  /(-)?\s?\(?\$?\s?((?:\d{1,3}(?:[ ,.]\d{3})+|\d+)[.,]\d{2})(?![\d])\s?\)?\s?\$?(?:\s?(CR|DR|Cr|Dr))?/g;

interface FoundAmount {
  amountMinor: number;
  index: number;
  length: number;
}

/** Every money amount (with exactly two decimals) in `line`, in reading order. */
export const findAmounts = (line: string): FoundAmount[] => {
  const text = normalizeText(line);
  const found: FoundAmount[] = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const start = match.index ?? 0;
    const body = match[2];
    const bodyStart = start + match[0].indexOf(body);
    const before = text[bodyStart - 1];
    const after = text[bodyStart + body.length];
    // Skip fragments of dates (31.03.2026), longer digit runs, and reference numbers.
    if (
      (before !== undefined && /[\d/]/.test(before)) ||
      (after !== undefined && /[./]\d/.test(after + (text[bodyStart + body.length + 1] ?? "")))
    ) {
      continue;
    }
    const wrappedInParens = /\(/.test(match[0]) && /\)/.test(match[0]);
    const signed = `${match[1] ? "-" : ""}${wrappedInParens ? "(" : ""}${body}${wrappedInParens ? ")" : ""}${match[3] ? ` ${match[3]}` : ""}`;
    const parsed = parseAmountToMinor(signed);
    if (parsed.ok) {
      found.push({ amountMinor: parsed.amountMinor, index: start, length: match[0].length });
    }
  }
  return found;
};

const CLOSING_LABELS = [
  /nouveau\s+solde/i,
  /new\s+balance/i,
  /closing\s+balance/i,
  /ending\s+balance/i,
  /statement\s+balance/i,
  /solde\s+de\s+cl[oô]ture/i,
  /solde\s+(?:final|de\s+fin|en\s+fin|de\s+fermeture)/i,
  /solde\s+du\s+relev[eé]/i,
  /solde\s+(?:actuel|courant)/i,
  /(?:current|ledger)\s+balance/i,
  /(?:balance|solde)\s+(?:as\s+of|at|on|au)\b/i,
  /solde\s+(?:du\s+)?compte/i,
  /(?:^|\s)solde\s*:?\s*$/i,
  /(?:^|\s)balance\s*:?\s*$/i,
];

const OPENING_LABELS = [
  /previous\s+balance/i,
  /opening\s+balance/i,
  /beginning\s+balance/i,
  /balance\s+forward/i,
  /solde\s+pr[eé]c[eé]dent/i,
  /solde\s+(?:d['’]\s?ouverture|initial|d[eé]but|de\s+d[eé]part|ant[eé]rieur|report[eé])/i,
  /solde\s+au\s+d[eé]but/i,
  /solde\s+d['’]ouverture/i,
];

/** Lines carrying an amount that is *not* the balance the user is after. */
const IGNORED_LABELS = [
  /available/i,
  /disponible/i,
  /credit\s+limit/i,
  /limite/i,
  /minimum/i,
  /paiement/i,
  /payment/i,
  /interest/i,
  /int[eé]r[eê]ts?/i,
  /average/i,
  /moyen/i,
];

const matchesAny = (line: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(line));

const closingPriority = (line: string): number => {
  const index = CLOSING_LABELS.findIndex((pattern) => pattern.test(line));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

const PERIOD_LABELS =
  /(p[eé]riode|period|relev[eé]\s+du|statement\s+(?:period|from)|du\s+\d|from\s+)/i;
const STATEMENT_DATE_LABELS =
  /(statement\s+(?:closing\s+)?date|closing\s+date|date\s+(?:du\s+relev[eé]|de\s+relev[eé]|de\s+cl[oô]ture|d['’]\s?[eé]mission|de\s+facturation)|period\s+ending|billing\s+date|date\s+de\s+fin|[eé]tat\s+de\s+compte\s+au)/i;
const RANGE_JOINER = /(?:\bau\b|\bto\b|\bthrough\b|\bjusqu['’]au\b|[-–—])/i;

const extractAccountLast4 = (text: string): string | null => {
  const masked = text.match(/(?:\*{2,}|[xX]{2,}|•{2,}|…)[\s\-*xX•]*(\d{4})\b/);
  if (masked) {
    return masked[1];
  }
  const labelled = text.match(
    /(?:account|compte|card|carte|n[°o]|num[eé]ro)(?:\s+(?:number|no\.?|de\s+compte|de\s+carte))?\s*(?:n[°o]\.?)?\s*:?\s*([\d][\d\- ]{6,})/i,
  );
  if (labelled) {
    const digits = labelled[1].replace(/\D/g, "");
    return digits.length >= 6 ? digits.slice(-4) : null;
  }
  return null;
};

const extractCurrency = (text: string): string | null => {
  const match = text.match(/\b(CAD|USD|EUR|GBP|CHF)\b/);
  return match ? match[1] : null;
};

/** Reads the first amount on the line, falling back to the amount on the next line. */
const amountForLabelLine = (lines: string[], index: number): number | null => {
  const amounts = findAmounts(lines[index]);
  if (amounts.length > 0) {
    // Statement rows put the figure at the right-hand edge: take the last amount on the line.
    return amounts[amounts.length - 1].amountMinor;
  }
  const next = lines[index + 1];
  if (next !== undefined && !matchesAny(next, [...CLOSING_LABELS, ...OPENING_LABELS])) {
    const nextAmounts = findAmounts(next);
    if (nextAmounts.length === 1) {
      return nextAmounts[0].amountMinor;
    }
  }
  return null;
};

export const parseStatementText = (
  rawText: string,
  options: ParseStatementOptions = {},
): StatementExtraction => {
  const dateOrder = options.dateOrder ?? "DMY";
  const text = normalizeText(rawText);
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  const balanceCandidates: (StatementBalanceCandidate & { priority: number; order: number })[] = [];
  let openingBalanceMinor: number | null = null;
  let closingDateFromBalanceLine: { iso: string; ambiguous: boolean } | null = null;

  lines.forEach((line, index) => {
    if (matchesAny(line, OPENING_LABELS)) {
      if (openingBalanceMinor === null) {
        openingBalanceMinor = amountForLabelLine(lines, index);
      }
      return;
    }
    const priority = closingPriority(line);
    if (!Number.isFinite(priority) || matchesAny(line, IGNORED_LABELS)) {
      return;
    }
    const amountMinor = amountForLabelLine(lines, index);
    if (amountMinor === null) {
      return;
    }
    balanceCandidates.push({ amountMinor, line, priority, order: index });
  });

  balanceCandidates.sort((a, b) => a.priority - b.priority || a.order - b.order);
  const best = balanceCandidates[0] ?? null;

  if (best) {
    const [date] = findDates(best.line, dateOrder);
    if (date) {
      closingDateFromBalanceLine = { iso: date.iso, ambiguous: date.ambiguous };
    }
  }

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let statementDate: string | null = null;
  let dateAmbiguous = false;

  for (const [index, line] of lines.entries()) {
    const candidateLine = PERIOD_LABELS.test(line) || RANGE_JOINER.test(line) ? line : null;
    if (!candidateLine || periodEnd) {
      continue;
    }
    const dates = findDates(candidateLine, dateOrder);
    if (
      dates.length >= 2 &&
      (PERIOD_LABELS.test(line) ||
        RANGE_JOINER.test(line.slice(dates[0].index + dates[0].length, dates[1].index)))
    ) {
      periodStart = dates[0].iso;
      periodEnd = dates[1].iso;
      dateAmbiguous = dates[0].ambiguous || dates[1].ambiguous;
      break;
    }
    // "Période du 1er mars" on one line and "au 31 mars 2026" on the next.
    if (PERIOD_LABELS.test(line) && dates.length === 1) {
      const next = lines[index + 1];
      const nextDates = next !== undefined ? findDates(next, dateOrder) : [];
      if (nextDates.length === 1 && RANGE_JOINER.test(next ?? "")) {
        periodStart = dates[0].iso;
        periodEnd = nextDates[0].iso;
        dateAmbiguous = dates[0].ambiguous || nextDates[0].ambiguous;
        break;
      }
    }
  }

  if (!periodEnd) {
    for (const [index, line] of lines.entries()) {
      if (!STATEMENT_DATE_LABELS.test(line)) {
        continue;
      }
      const dates = findDates(line, dateOrder);
      const nextDates = dates.length === 0 ? findDates(lines[index + 1] ?? "", dateOrder) : [];
      const picked = dates[dates.length - 1] ?? nextDates[0];
      if (picked) {
        statementDate = picked.iso;
        dateAmbiguous = picked.ambiguous;
        break;
      }
    }
  }

  if (periodEnd) {
    statementDate = periodEnd;
  } else if (!statementDate && closingDateFromBalanceLine) {
    statementDate = closingDateFromBalanceLine.iso;
    dateAmbiguous = closingDateFromBalanceLine.ambiguous;
  }

  const closingBalanceMinor = best?.amountMinor ?? null;
  const confidence: StatementExtraction["confidence"] =
    closingBalanceMinor !== null && statementDate && !dateAmbiguous
      ? balanceCandidates.length > 1 &&
        new Set(balanceCandidates.map((c) => c.amountMinor)).size > 1
        ? "medium"
        : "high"
      : closingBalanceMinor !== null || statementDate
        ? "medium"
        : "low";

  return {
    closingBalanceMinor,
    openingBalanceMinor,
    statementDate,
    periodStart,
    periodEnd,
    accountLast4: extractAccountLast4(text),
    currency: extractCurrency(text),
    balanceCandidates: balanceCandidates
      .slice(0, 6)
      .map(({ amountMinor, line }) => ({ amountMinor, line })),
    dateAmbiguous,
    confidence: confidence === "high" && dateAmbiguous ? "medium" : confidence,
    source: "pdf-text",
  };
};
