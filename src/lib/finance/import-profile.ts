// CSV import profile recognition and row -> normalized-transaction mapping.
// Pure, no I/O. See specs/done/finance.md "CSV import".

import type {
  FinanceDateFormat,
  FinanceImportAmountMode,
  FinanceImportColumnMap,
  FinanceImportProfile,
} from "../../domain/finance";
import { hash128 } from "./hash";
import { currencyExponent, type ParseAmountOptions, parseAmountToMinor } from "./money";

export type { FinanceDateFormat } from "../../domain/finance";

/**
 * Builds a stable signature for a CSV header row: lowercase, trim, strip
 * accents/punctuation, join with "|", then hash with the 128-bit hash. Used to
 * auto-recognize a repeat export and store on the saved import profile.
 */
export const buildHeaderSignature = (header: string[]): string => {
  const normalized = header
    .map(
      (column) =>
        column
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "") // strip accents
          .replace(/[^a-z0-9]+/g, ""), // strip punctuation/whitespace
    )
    .join("|");

  return hash128(normalized);
};

const MINT_HEADER = [
  "Date",
  "Description",
  "Original Description",
  "Amount",
  "Transaction Type",
  "Category",
  "Account Name",
  "Labels",
  "Notes",
];

const MINT_COLUMN_MAP: FinanceImportColumnMap = {
  date: 0,
  description: 1,
  descriptionOriginal: 2,
  amount: 3,
  transactionType: 4,
  categoryHint: 5,
  account: 6,
  labels: 7,
  notes: 8,
};

/** Bundled profile matching the Mint CSV export header. */
export const MINT_PROFILE: FinanceImportProfile = {
  id: "finance-import-profile:mint",
  name: "Mint",
  signature: buildHeaderSignature(MINT_HEADER),
  columnMap: MINT_COLUMN_MAP,
  dateFormat: "M/D/YYYY",
  amountMode: "amount_with_type_column",
  signConvention: null,
  defaultAccountId: null,
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
};

export interface DateFormatInference {
  format: FinanceDateFormat | null;
  ambiguous: boolean;
  reason?: string;
}

/**
 * Infers the date format from a sample of raw date strings. Ambiguity is
 * reported rather than guessed: if every sampled day component is <= 12 in
 * both positions, M/D and D/M are both consistent and the caller must ask.
 */
export const inferDateFormat = (samples: string[]): DateFormatInference => {
  const nonEmpty = samples.map((sample) => sample.trim()).filter((sample) => sample.length > 0);

  if (nonEmpty.length === 0) {
    return { format: null, ambiguous: true, reason: "no samples" };
  }

  if (nonEmpty.every((sample) => /^\d{4}-\d{2}-\d{2}$/.test(sample))) {
    return { format: "YYYY-MM-DD", ambiguous: false };
  }

  const slashSamples = nonEmpty.filter((sample) => /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(sample));

  if (slashSamples.length !== nonEmpty.length) {
    return { format: null, ambiguous: true, reason: "mixed or unrecognized date formats" };
  }

  let sawMonthFirstSignal = false;
  let sawDayFirstSignal = false;

  for (const sample of slashSamples) {
    const [first, second] = sample.split(/[/-]/).map((part) => Number.parseInt(part, 10));

    if (first > 12) {
      sawDayFirstSignal = true;
    } else if (second > 12) {
      sawMonthFirstSignal = true;
    }
  }

  if (sawMonthFirstSignal && sawDayFirstSignal) {
    return {
      format: null,
      ambiguous: true,
      reason: "conflicting day/month signals across samples",
    };
  }

  if (sawDayFirstSignal) {
    return { format: "D/M/YYYY", ambiguous: false };
  }

  if (sawMonthFirstSignal) {
    return { format: "M/D/YYYY", ambiguous: false };
  }

  // Every sampled day is <= 12 in both positions: genuinely ambiguous.
  return {
    format: "M/D/YYYY",
    ambiguous: true,
    reason: "every sampled day is <= 12 in both positions",
  };
};

/** Number of days in a given 1-based month of a given year, honoring leap years. */
const daysInMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

/** Parses a date string under an explicit format into a local YYYY-MM-DD string, or null. */
export const parseDateWithFormat = (text: string, format: FinanceDateFormat): string | null => {
  const trimmed = text.trim();

  if (format === "YYYY-MM-DD") {
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) {
      return null;
    }
    const isoMonth = Number.parseInt(iso[2], 10);
    const isoDay = Number.parseInt(iso[3], 10);
    const isoYear = Number.parseInt(iso[1], 10);
    return isoMonth >= 1 &&
      isoMonth <= 12 &&
      isoDay >= 1 &&
      isoDay <= daysInMonth(isoYear, isoMonth)
      ? trimmed
      : null;
  }

  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) {
    return null;
  }

  const [, first, second, year] = match;
  const month = format === "M/D/YYYY" ? first : second;
  const day = format === "M/D/YYYY" ? second : first;
  const monthNum = Number.parseInt(month, 10);
  const dayNum = Number.parseInt(day, 10);
  const yearNum = Number.parseInt(year, 10);

  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > daysInMonth(yearNum, monthNum)) {
    return null;
  }

  return `${year}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
};

// A contiguous run of 6+ digits bounded by non-digits is treated as an account number;
// shorter runs (e.g. a 4-digit branch code) are left alone. Only the last 4 digits survive.
const ACCOUNT_NUMBER_RUN = /\b\d{6,}\b/;

/** Keeps only the last 4 digits of a contiguous 6+ digit run when the label looks like an account number. */
export const shortenIfAccountNumber = (label: string): string => {
  const match = label.match(ACCOUNT_NUMBER_RUN);
  if (!match) {
    return label;
  }
  return `****${match[0].slice(-4)}`;
};

/**
 * Uppercases, strips accents, collapses whitespace, and removes trailing
 * reference/auth numbers. The same normalizer backs both dedupeHash and
 * merchant_key, so dedupe and classification agree on identity.
 */
export const normalizeDescription = (description: string): string => {
  let normalized = description.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

  normalized = normalized.replace(/#\d{4,}/g, "");
  normalized = normalized.replace(/\bREF\s*\d+/g, "");
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
};

/** Merchant identity key, derived with the same normalizer used for dedupe. */
export const merchantKey = (descriptionRaw: string): string => normalizeDescription(descriptionRaw);

export interface DedupeHashInput {
  accountId: string;
  postedDate: string;
  amountMinor: number;
  currency: string;
  descriptionRaw: string;
  occurrenceIndex: number;
}

export const dedupeHash = (input: DedupeHashInput): string =>
  hash128(
    // JSON framing keeps field boundaries unambiguous (e.g. "SHOP1"+0 vs "SHOP"+10).
    JSON.stringify([
      input.accountId,
      input.postedDate,
      input.amountMinor,
      input.currency,
      normalizeDescription(input.descriptionRaw),
      input.occurrenceIndex,
    ]),
  );

/**
 * Assigns a stable 0-based occurrenceIndex per (accountId, postedDate,
 * amountMinor, currency, normalizedDescription) group, in row order, so two
 * identical same-day transactions both survive while a re-import of the same
 * file reproduces the same indices (and therefore the same hashes).
 */
export const assignOccurrenceIndices = (
  rows: Array<
    Pick<
      DedupeHashInput,
      "accountId" | "postedDate" | "amountMinor" | "currency" | "descriptionRaw"
    >
  >,
): number[] => {
  const seen = new Map<string, number>();
  const indices: number[] = [];

  for (const row of rows) {
    const key = [
      row.accountId,
      row.postedDate,
      String(row.amountMinor),
      row.currency,
      normalizeDescription(row.descriptionRaw),
    ].join("\u0000");

    const nextIndex = seen.get(key) ?? 0;
    indices.push(nextIndex);
    seen.set(key, nextIndex + 1);
  }

  return indices;
};

export interface NormalizedImportRow {
  postedDate: string;
  amountMinor: number;
  currency: string;
  descriptionRaw: string;
  descriptionOriginal: string | null;
  merchantKey: string;
  categoryHint: string | null;
  notes: string | null;
  labelsJson: string | null;
  externalAccountKey: string | null;
  sourceRowJson: string;
}

export type MapImportRowResult =
  | { ok: true; row: NormalizedImportRow }
  | { ok: false; reason: string };

export interface MapImportRowOptions {
  currency: string;
  exponent?: number;
}

/**
 * Builds the stored labelsJson from a raw Labels cell: blank/missing yields
 * null (never a lone empty-string label), and a multi-label cell (comma
 * separated) splits into one entry per label.
 */
const buildLabelsJson = (labels: string | null): string | null => {
  if (labels === null) {
    return null;
  }

  const parts = labels
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? JSON.stringify(parts) : null;
};

/**
 * Maps one parsed CSV data row to a normalized transaction row, per the
 * profile's column map, date format, and amount mode. Never throws.
 */
export const mapImportRowToTransaction = (
  row: string[],
  header: string[],
  profile: FinanceImportProfile,
  options: MapImportRowOptions,
): MapImportRowResult => {
  const field = (index: number | undefined): string | null =>
    index === undefined || row[index] === undefined ? null : row[index];

  const dateText = field(profile.columnMap.date);
  if (dateText === null || dateText.trim().length === 0) {
    return { ok: false, reason: "missing date" };
  }

  const postedDate = parseDateWithFormat(dateText, profile.dateFormat);
  if (postedDate === null) {
    return {
      ok: false,
      reason: `unparseable date "${dateText}" under format ${profile.dateFormat}`,
    };
  }

  const amountResult = resolveAmountMinor(row, profile, options);
  if (!amountResult.ok) {
    return amountResult;
  }

  const descriptionRaw = field(profile.columnMap.description) ?? "";
  if (descriptionRaw.trim().length === 0) {
    return { ok: false, reason: "missing description" };
  }

  const descriptionOriginal = field(profile.columnMap.descriptionOriginal);
  const categoryHint = field(profile.columnMap.categoryHint);
  const notes = field(profile.columnMap.notes);
  const labels = field(profile.columnMap.labels);
  const externalAccountKey = field(profile.columnMap.account);
  const labelsJson = buildLabelsJson(labels);

  // Never persist a full account number: mask the mapped account column in the stored row.
  const sourceRowJson = JSON.stringify(
    header.reduce<Record<string, string>>((acc, columnName, index) => {
      const cell = row[index] ?? "";
      acc[columnName] = index === profile.columnMap.account ? shortenIfAccountNumber(cell) : cell;
      return acc;
    }, {}),
  );

  return {
    ok: true,
    row: {
      postedDate,
      amountMinor: amountResult.amountMinor,
      currency: options.currency,
      descriptionRaw,
      descriptionOriginal,
      merchantKey: merchantKey(descriptionRaw),
      categoryHint,
      notes,
      labelsJson,
      externalAccountKey,
      sourceRowJson,
    },
  };
};

type AmountResult = { ok: true; amountMinor: number } | { ok: false; reason: string };

const resolveAmountMinor = (
  row: string[],
  profile: FinanceImportProfile,
  options: MapImportRowOptions,
): AmountResult => {
  const mode: FinanceImportAmountMode = profile.amountMode;
  const amountOptions: ParseAmountOptions = {
    exponent: options.exponent ?? currencyExponent(options.currency),
    decimalSeparator: profile.decimalSeparator,
    thousandsSeparator: profile.thousandsSeparator,
  };

  if (mode === "single_signed") {
    const amountIndex = profile.columnMap.amount;
    if (amountIndex === undefined) {
      return { ok: false, reason: "no amount column mapped" };
    }
    const parsed = parseAmountToMinor(row[amountIndex] ?? "", amountOptions);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    return { ok: true, amountMinor: parsed.amountMinor };
  }

  if (mode === "debit_credit_columns") {
    const debitIndex = profile.columnMap.debit;
    const creditIndex = profile.columnMap.credit;
    const debitText = debitIndex === undefined ? "" : (row[debitIndex] ?? "").trim();
    const creditText = creditIndex === undefined ? "" : (row[creditIndex] ?? "").trim();

    if (debitText.length > 0) {
      const parsed = parseAmountToMinor(debitText, amountOptions);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, amountMinor: -Math.abs(parsed.amountMinor) };
    }

    if (creditText.length > 0) {
      const parsed = parseAmountToMinor(creditText, amountOptions);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, amountMinor: Math.abs(parsed.amountMinor) };
    }

    return { ok: false, reason: "neither debit nor credit column has a value" };
  }

  // amount_with_type_column
  const amountIndex = profile.columnMap.amount;
  const typeIndex = profile.columnMap.transactionType;

  if (amountIndex === undefined || typeIndex === undefined) {
    return { ok: false, reason: "amount or transaction type column not mapped" };
  }

  const parsed = parseAmountToMinor(row[amountIndex] ?? "", amountOptions);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  const typeText = (row[typeIndex] ?? "").trim().toLowerCase();
  const magnitude = Math.abs(parsed.amountMinor);

  if (typeText === "debit") {
    return { ok: true, amountMinor: -magnitude };
  }
  if (typeText === "credit") {
    return { ok: true, amountMinor: magnitude };
  }

  return { ok: false, reason: `unrecognized transaction type "${typeText}"` };
};
