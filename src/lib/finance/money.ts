// Pure money arithmetic for the finance domain. No I/O, no floats.
// Every amount in finance code is minor units (cents). No helper here accepts
// or returns a decimal number. See docs/conventions.md.

export interface Money {
  amountMinor: number;
  currency: string;
}

const CURRENCY_EXPONENTS: Record<string, number> = {
  CAD: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
};

export const currencyExponent = (code: string): number => {
  const normalized = code.toUpperCase();
  return normalized in CURRENCY_EXPONENTS ? CURRENCY_EXPONENTS[normalized] : 2;
};

/**
 * Renders minor units as a plain decimal string for an editable input field
 * (e.g. `1234` at exponent `2` → `"12.34"`), via string slicing rather than
 * `amountMinor / 10 ** exponent` — division risks a binary-float rounding
 * artifact in the displayed string. The result round-trips through
 * `parseAmountToMinor({ exponent })`.
 */
export const minorToInputString = (amountMinor: number, exponent: number): string => {
  const negative = amountMinor < 0;
  const absDigits = String(Math.abs(amountMinor)).padStart(exponent + 1, "0");
  const wholePart = exponent > 0 ? absDigits.slice(0, -exponent) : absDigits;
  const fractionPart = exponent > 0 ? absDigits.slice(-exponent) : "";
  const result = exponent > 0 ? `${wholePart}.${fractionPart}` : wholePart;
  return negative ? `-${result}` : result;
};

export type ParseAmountResult = { ok: true; amountMinor: number } | { ok: false; reason: string };

export interface ParseAmountOptions {
  exponent?: number;
  decimalSeparator?: "." | ",";
  thousandsSeparator?: "," | "." | " " | "";
}

const UNICODE_MINUS = "−";

/**
 * Parses a human-entered amount string into minor units. Handles thousands/decimal
 * separators, accounting negatives in parentheses, leading currency symbols,
 * trailing CR/DR markers, and the unicode minus sign. Never throws; returns a
 * discriminated result instead.
 */
export const parseAmountToMinor = (
  text: string,
  options: ParseAmountOptions = {},
): ParseAmountResult => {
  const exponent = options.exponent ?? 2;
  let working = text.trim();

  if (working.length === 0) {
    return { ok: false, reason: "empty" };
  }

  let negative = false;

  // Accounting negative: (45.00)
  if (working.startsWith("(") && working.endsWith(")")) {
    negative = true;
    working = working.slice(1, -1).trim();
  }

  // Trailing DR/CR markers.
  const trailingMarker = working.match(/\s*(CR|DR)$/i);
  if (trailingMarker) {
    if (trailingMarker[1].toUpperCase() === "DR") {
      negative = true;
    }
    working = working.slice(0, trailingMarker.index).trim();
  }

  // Unicode minus normalizes to ASCII minus.
  working = working.replaceAll(UNICODE_MINUS, "-");

  // Strip leading currency symbols/codes such as "$", "CA$", "USD", which may
  // themselves precede the sign (e.g. "$-12.00").
  working = working.replace(/^[A-Za-z]{0,3}\$\s*/, "").trim();

  if (working.startsWith("-")) {
    negative = true;
    working = working.slice(1).trim();
  } else if (working.startsWith("+")) {
    working = working.slice(1).trim();
  }

  if (working.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const { decimalSeparator, thousandsSeparator } = resolveSeparators(working, options);

  let wholeRaw = working;
  let fractionPart = "";

  if (decimalSeparator) {
    const decimalIndex = working.lastIndexOf(decimalSeparator);
    if (decimalIndex !== -1) {
      wholeRaw = working.slice(0, decimalIndex);
      fractionPart = working.slice(decimalIndex + 1);
    }
  }

  // Thousands punctuation (or plain spaces, e.g. "1 234,56") is only accepted
  // as a leading group of 1-3 digits followed by groups of exactly three.
  if (/\D/.test(wholeRaw)) {
    const separators = [thousandsSeparator, " "].filter((value) => value !== "");
    const escaped = separators.map((value) => (value === "." ? "\\." : value)).join("");
    const grouped = new RegExp(`^\\d{1,3}(?:[${escaped}]\\d{3})+$`);
    if (!grouped.test(wholeRaw) || new Set(wholeRaw.replace(/\d/g, "")).size > 1) {
      return { ok: false, reason: `unparseable amount: "${text}"` };
    }
  }

  const wholePart = wholeRaw.replace(/\D/g, "");

  if (wholePart.length === 0 && fractionPart.length === 0) {
    return { ok: false, reason: `unparseable amount: "${text}"` };
  }
  if (!/^\d*$/.test(fractionPart) || (wholePart.length === 0 && fractionPart.length === 0)) {
    return { ok: false, reason: `unparseable amount: "${text}"` };
  }
  if (fractionPart.length > exponent) {
    return { ok: false, reason: `too many decimal places for exponent ${exponent}: "${text}"` };
  }
  fractionPart = fractionPart.padEnd(exponent, "0");
  const scale = 10 ** exponent;
  const wholeMinor = Number(wholePart || "0") * scale;
  const fractionMinor = exponent > 0 ? Number(fractionPart) : 0;
  const amountMinor = wholeMinor + fractionMinor;

  if (!Number.isFinite(amountMinor)) {
    return { ok: false, reason: `unparseable amount: "${text}"` };
  }

  return { ok: true, amountMinor: negative ? -amountMinor : amountMinor };
};

const inferDecimalSeparator = (value: string): "." | "," => {
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma === -1 && lastDot === -1) {
    return ".";
  }

  // The rightmost separator is the decimal one; the other (if any) is thousands.
  return lastComma > lastDot ? "," : ".";
};

interface ResolvedSeparators {
  decimalSeparator: "." | "," | null;
  thousandsSeparator: "," | "." | " " | "";
}

/**
 * Decides which punctuation is the decimal separator and which is the
 * thousands separator. When both a comma and a dot are present, the
 * rightmost one is the decimal separator. When only one separator character
 * is present and it occurs more than once, or it occurs exactly once but the
 * trailing digit group is exactly 3 digits long, the input is ambiguous
 * between "decimal with a 3-digit fraction" and "thousands grouping" — this
 * resolves the ambiguity in favor of thousands grouping (e.g. "1,234" is
 * 1234, not 1.234), matching how humans write large whole-number amounts.
 * Callers who need the other reading must pass explicit options.
 */
const resolveSeparators = (value: string, options: ParseAmountOptions): ResolvedSeparators => {
  if (options.decimalSeparator !== undefined) {
    return {
      decimalSeparator: options.decimalSeparator,
      thousandsSeparator:
        options.thousandsSeparator ?? (options.decimalSeparator === "," ? "." : ","),
    };
  }

  const commaCount = value.split(",").length - 1;
  const dotCount = value.split(".").length - 1;

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = inferDecimalSeparator(value);
    return { decimalSeparator, thousandsSeparator: decimalSeparator === "," ? "." : "," };
  }

  if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? "," : ".";
    const count = commaCount > 0 ? commaCount : dotCount;
    const trailingGroup = value.slice(value.lastIndexOf(separator) + 1);

    if (count > 1 || (trailingGroup.length === 3 && /^\d{3}$/.test(trailingGroup))) {
      return { decimalSeparator: null, thousandsSeparator: separator };
    }

    return { decimalSeparator: separator, thousandsSeparator: separator === "," ? "." : "," };
  }

  return { decimalSeparator: ".", thousandsSeparator: "," };
};

/**
 * Trims and upper-cases a currency code and returns it only when Intl accepts it as a
 * well-formed ISO-4217 code; otherwise null. Use before persisting any user-entered currency.
 */
export const normalizeCurrencyCode = (text: string): string | null => {
  const code = text.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return null;
  }
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return code;
  } catch {
    return null;
  }
};

export const formatMoney = (money: Money, locale = "fr-CA"): string => {
  const exponent = currencyExponent(money.currency);
  const scale = 10 ** exponent;
  const value = money.amountMinor / scale;

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    // A malformed stored currency must not crash rendering of the whole screen.
    return `${value.toFixed(exponent)} ${money.currency}`;
  }
};

export const formatMoneySigned = (money: Money, locale = "fr-CA"): string => {
  const formatted = formatMoney(
    { amountMinor: Math.abs(money.amountMinor), currency: money.currency },
    locale,
  );
  return money.amountMinor < 0 ? `-${formatted}` : `+${formatted}`;
};

export const addMoney = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) {
    throw new Error(`cannot add mixed currencies: ${a.currency} + ${b.currency}`);
  }

  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
};

export const sumMoney = (values: Money[]): Money => {
  if (values.length === 0) {
    throw new Error("sumMoney requires at least one value");
  }

  const currency = values[0].currency;

  return {
    amountMinor: values.reduce((total, value) => {
      if (value.currency !== currency) {
        throw new Error(`cannot sum mixed currencies: ${currency} + ${value.currency}`);
      }
      return total + value.amountMinor;
    }, 0),
    currency,
  };
};
