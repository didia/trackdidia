// Deterministic extraction of the headline figures of a bank / credit-card statement from its
// plain text (as produced by `statement-pdf.ts`). Pure — no I/O. French and English labels.
// See docs/finance.md "Statement import".
//
// This is a best-effort heuristic: the UI always shows what was found and lets the user correct
// it before anything is written. `balanceCandidates` exposes every plausible closing-balance line
// so a multi-account statement can be resolved with one click.

import type { FinanceAccountType } from "../../domain/finance";
import { parseAmountToMinor } from "./money";

/** A trailing credit / debit marker printed next to an amount. */
export type StatementAmountMarker = "CR" | "DR";

export interface StatementBalanceCandidate {
  /** The amount exactly as printed (liabilities print what is owed as a positive number). */
  amountMinor: number;
  /** CR / DR printed after the amount, when present; it fixes the sign without negation. */
  marker: StatementAmountMarker | null;
  /** The statement line the amount was read from, trimmed. */
  line: string;
}

export interface StatementExtraction {
  /** Closing / new balance as printed. */
  closingBalanceMinor: number | null;
  /** CR / DR printed after the closing balance, when present. */
  closingBalanceMarker: StatementAmountMarker | null;
  /** Opening / previous balance as printed. */
  openingBalanceMinor: number | null;
  /** Closing date of the statement (`YYYY-MM-DD`). */
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Last four digits of the account / card number when the statement masks it. */
  accountLast4: string | null;
  currency: string | null;
  /** The product name printed on the statement (e.g. "Walmart Rewards Mastercard"), if found. */
  suggestedAccountName: string | null;
  /** Account type implied by the statement's wording, if any. */
  suggestedAccountType: FinanceAccountType | null;
  balanceCandidates: StatementBalanceCandidate[];
  /** True when the only date readings were `dd/mm` vs `mm/dd` ambiguous. */
  dateAmbiguous: boolean;
  confidence: "high" | "medium" | "low";
  source: "pdf-text" | "ai";
}

/** A form with nothing filled in: the review form still opens so the user can type the figures. */
export const emptyStatementExtraction = (): StatementExtraction => ({
  closingBalanceMinor: null,
  closingBalanceMarker: null,
  openingBalanceMinor: null,
  statementDate: null,
  periodStart: null,
  periodEnd: null,
  accountLast4: null,
  currency: null,
  suggestedAccountName: null,
  suggestedAccountType: null,
  balanceCandidates: [],
  dateAmbiguous: false,
  confidence: "low",
  source: "pdf-text",
});

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
  marker: StatementAmountMarker | null;
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
    if (/^\s?%/.test(text.slice(bodyStart + body.length))) {
      continue; // an interest rate such as "21.99 %", not money
    }
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
      found.push({
        amountMinor: parsed.amountMinor,
        marker: match[3] ? (match[3].toUpperCase() as StatementAmountMarker) : null,
        index: start,
        length: match[0].length,
      });
    }
  }
  return found;
};

const CLOSING_LABELS = [
  /total\s+new\s+balance/i,
  /nouveau\s+solde(?:\s+total)?/i,
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
  /(?:solde|balance)\s+(?:du\s+)?(?:compte|account)|account\s+balance/i,
  // A bare "Balance" / "Solde" label only counts when the line is essentially just that word;
  // a sentence that happens to end with "balance" must not borrow the next line's amount.
  /^[\p{L} ]{0,20}\bsolde\s*:?\s*$/iu,
  /^[\p{L} ]{0,20}\bbalance\s*:?\s*$/iu,
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
  /rewards?\b/i,
  /r[eé]compenses?/i,
  /\bpoints?\b/i,
  /cash\s+limit/i,
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

/** A real period label — a bare "du 1er … au …" / "from … to …" can be a promo or rate window. */
const PERIOD_LABELS = /(p[eé]riode|period|relev[eé]\s+du|statement\s+(?:period|from))/i;
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

/**
 * A currency code is only trusted when exactly one code appears outside foreign-exchange notes
 * ("14.60 USD @ 1.4253 incl. 2.5% conversion fee" on a CAD card is a purchase detail).
 */
const extractCurrency = (text: string): string | null => {
  const codes = new Set<string>();
  for (const line of text.split("\n")) {
    if (/@|conversion|taux\s+de\s+change|exchange\s+rate/i.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/\b(CAD|USD|EUR|GBP|CHF)\b/g)) {
      codes.add(match[1]);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
};

const PRODUCT_NAME_PATTERN =
  /\b(mastercard|visa|american express|amex|carte|card|chequing|checking|savings|ch[eè]ques?|[eé]pargne|marge|line of credit)\b/i;

/** A short, label-like line naming the product ("Walmart Rewards Mastercard"), not a sentence. */
const extractAccountName = (lines: string[]): string | null => {
  for (const line of lines) {
    if (
      line.length >= 6 &&
      line.length <= 45 &&
      line.split(" ").length <= 6 &&
      !/[.,:;$\d*]/.test(line) &&
      PRODUCT_NAME_PATTERN.test(line)
    ) {
      return line;
    }
  }
  return null;
};

const inferAccountType = (text: string): FinanceAccountType | null => {
  if (
    /credit\s+limit|limite\s+de\s+cr[eé]dit|minimum\s+payment|paiement\s+minimum|mastercard|\bvisa\b|american express|\bamex\b/i.test(
      text,
    )
  ) {
    return "credit_card";
  }
  if (/line\s+of\s+credit|marge\s+de\s+cr[eé]dit/i.test(text)) {
    return "line_of_credit";
  }
  if (/savings|[eé]pargne/i.test(text)) {
    return "savings";
  }
  if (/chequing|checking|ch[eè]ques?/i.test(text)) {
    return "checking";
  }
  return null;
};

interface LabelHit {
  priority: number;
  /** The amount printed directly after the label on the same line, if any. */
  amount: FoundAmount | null;
  /** The label ends the line, so its amount may sit on the next line. */
  tail: boolean;
}

/**
 * Finds the best label match on one visual line. Statements lay out several columns on one
 * line ("Total new balance $6,460.31 Previous Rewards balance $9.17"), so a label only owns the
 * amount that follows it *directly* — no words in between — and an ignored word right before or
 * inside that label/amount span ("Available balance", "Rewards balance") disqualifies the hit.
 */
const findLabelHit = (line: string, patterns: RegExp[]): LabelHit | null => {
  let best: LabelHit | null = null;
  patterns.forEach((pattern, priority) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of line.matchAll(new RegExp(pattern.source, flags))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      let amountStart = end;
      // "Solde au 31 mars 2026   5 678,90 $": a date may sit between the label and its amount.
      const [leadingDate] = findDates(line.slice(end));
      if (leadingDate && /^[\s:]*$/.test(line.slice(end, end + leadingDate.index))) {
        amountStart = end + leadingDate.index + leadingDate.length;
      }
      const rest = line.slice(amountStart);
      const first = findAmounts(rest)[0];
      const amount =
        first && !/[\p{L}\d]/u.test(rest.slice(0, first.index))
          ? { ...first, index: first.index + amountStart }
          : null;
      const tail = !amount && rest.replace(/[\s.:·…_\-–$]/g, "") === "";
      if (!amount && !tail) {
        continue;
      }
      const previousWord = line.slice(0, start).trim().split(/\s+/).pop() ?? "";
      // Only a directly adjacent modifier counts ("Rewards balance"); a word that ends a
      // previous sentence ("…with your payment.") does not.
      const wordBefore = /[\p{L}\d]$/u.test(previousWord) ? previousWord : "";
      const span = `${wordBefore} ${line.slice(start, amount ? amount.index + amount.length : end)}`;
      if (matchesAny(span, IGNORED_LABELS)) {
        continue;
      }
      if (
        !best ||
        priority < best.priority ||
        (priority === best.priority && !best.amount && amount)
      ) {
        best = { priority, amount, tail };
      }
    }
  });
  return best;
};

/** The labelled amount for a hit, falling back to a lone amount on the next line for a bare label. */
const amountForHit = (lines: string[], index: number, hit: LabelHit): FoundAmount | null => {
  if (hit.amount) {
    return hit.amount;
  }
  const next = lines[index + 1];
  if (
    next !== undefined &&
    lines[index].length <= 40 &&
    !matchesAny(next, [...CLOSING_LABELS, ...OPENING_LABELS])
  ) {
    const nextAmounts = findAmounts(next);
    if (nextAmounts.length === 1) {
      return nextAmounts[0];
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
    const openingHit = findLabelHit(line, OPENING_LABELS);
    if (openingHit) {
      if (openingBalanceMinor === null) {
        openingBalanceMinor = amountForHit(lines, index, openingHit)?.amountMinor ?? null;
      }
      return; // an opening / previous balance line is never a closing candidate
    }
    const hit = findLabelHit(line, CLOSING_LABELS);
    if (!hit) {
      return;
    }
    const amount = amountForHit(lines, index, hit);
    if (amount === null) {
      return;
    }
    balanceCandidates.push({
      amountMinor: amount.amountMinor,
      marker: amount.marker,
      line,
      priority: hit.priority,
      order: index,
    });
  });

  balanceCandidates.sort((a, b) => a.priority - b.priority || a.order - b.order);
  const best = balanceCandidates[0] ?? null;

  if (best) {
    const [date] = findDates(best.line, dateOrder);
    if (date) {
      closingDateFromBalanceLine = { iso: date.iso, ambiguous: date.ambiguous };
    }
  }

  type DateRange = { start: string; end: string; ambiguous: boolean };
  const readRange = (line: string, next: string | undefined): DateRange | null => {
    const dates = findDates(line, dateOrder);
    if (
      dates.length >= 2 &&
      RANGE_JOINER.test(line.slice(dates[0].index + dates[0].length, dates[1].index))
    ) {
      return {
        start: dates[0].iso,
        end: dates[1].iso,
        ambiguous: dates[0].ambiguous || dates[1].ambiguous,
      };
    }
    // "Période du 1er mars" on one line and "au 31 mars 2026" on the next.
    if (dates.length === 1 && next !== undefined && RANGE_JOINER.test(next)) {
      const nextDates = findDates(next, dateOrder);
      if (nextDates.length === 1) {
        return {
          start: dates[0].iso,
          end: nextDates[0].iso,
          ambiguous: dates[0].ambiguous || nextDates[0].ambiguous,
        };
      }
    }
    return null;
  };

  // 1. A line that explicitly names the statement date wins over any range of dates.
  let explicitDate: FoundDate | null = null;
  for (const [index, line] of lines.entries()) {
    if (!STATEMENT_DATE_LABELS.test(line)) {
      continue;
    }
    const dates = findDates(line, dateOrder);
    const nextDates = dates.length === 0 ? findDates(lines[index + 1] ?? "", dateOrder) : [];
    const picked = dates[dates.length - 1] ?? nextDates[0];
    if (picked) {
      explicitDate = picked;
      break;
    }
  }

  // 2. Ranges under a real period label; two different ranges make the answer uncertain.
  const labelledRanges: DateRange[] = [];
  for (const [index, line] of lines.entries()) {
    if (PERIOD_LABELS.test(line)) {
      const range = readRange(line, lines[index + 1]);
      if (range) {
        labelledRanges.push(range);
      }
    }
  }
  const period = labelledRanges[0] ?? null;
  const rangeConflict = new Set(labelledRanges.map((range) => range.end)).size > 1;

  // 3. Last resort: any unlabelled range (cannot be trusted as "high").
  let looseRange: DateRange | null = null;
  if (!explicitDate && !period) {
    for (const line of lines) {
      looseRange = readRange(line, undefined);
      if (looseRange) {
        break;
      }
    }
  }

  const periodStart = (period ?? looseRange)?.start ?? null;
  const periodEnd = (period ?? looseRange)?.end ?? null;
  let statementDate: string | null = null;
  let dateAmbiguous = false;
  if (explicitDate) {
    statementDate = explicitDate.iso;
    dateAmbiguous = explicitDate.ambiguous;
  } else if (period) {
    statementDate = period.end;
    dateAmbiguous = period.ambiguous;
  } else if (closingDateFromBalanceLine) {
    statementDate = closingDateFromBalanceLine.iso;
    dateAmbiguous = closingDateFromBalanceLine.ambiguous;
  } else if (looseRange) {
    statementDate = looseRange.end;
    dateAmbiguous = looseRange.ambiguous;
  }
  const dateUncertain =
    dateAmbiguous || rangeConflict || (!explicitDate && !period && !closingDateFromBalanceLine);

  const closingBalanceMinor = best?.amountMinor ?? null;
  const confidence: StatementExtraction["confidence"] =
    closingBalanceMinor !== null && statementDate && !dateUncertain
      ? balanceCandidates.length > 1 &&
        new Set(balanceCandidates.map((c) => c.amountMinor)).size > 1
        ? "medium"
        : "high"
      : closingBalanceMinor !== null || statementDate
        ? "medium"
        : "low";

  return {
    closingBalanceMinor,
    closingBalanceMarker: best?.marker ?? null,
    openingBalanceMinor,
    statementDate,
    periodStart,
    periodEnd,
    accountLast4: extractAccountLast4(text),
    currency: extractCurrency(text),
    suggestedAccountName: extractAccountName(lines),
    suggestedAccountType: inferAccountType(text),
    // The same figure printed twice (summary + payment stub) is one candidate, not a conflict.
    balanceCandidates: balanceCandidates
      .filter(
        (candidate, index, all) =>
          all.findIndex(
            (other) =>
              other.amountMinor === candidate.amountMinor && other.marker === candidate.marker,
          ) === index,
      )
      .slice(0, 6)
      .map(({ amountMinor, marker, line }) => ({ amountMinor, marker, line })),
    dateAmbiguous,
    confidence,
    source: "pdf-text",
  };
};
