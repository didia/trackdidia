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

  const decimalSeparator = options.decimalSeparator ?? inferDecimalSeparator(working);
  const thousandsSeparator = options.thousandsSeparator ?? (decimalSeparator === "," ? "." : ",");

  let digitsOnly = working;

  if (thousandsSeparator) {
    digitsOnly = digitsOnly.split(thousandsSeparator).join("");
  }
  // Also strip plain spaces used as thousands separators (e.g. "1 234,56").
  digitsOnly = digitsOnly.split(" ").join("");

  if (decimalSeparator === ",") {
    digitsOnly = digitsOnly.replace(",", ".");
  }

  if (!/^\d+(\.\d+)?$/.test(digitsOnly)) {
    return { ok: false, reason: `unparseable amount: "${text}"` };
  }

  const [wholePart, fractionPartRaw = ""] = digitsOnly.split(".");
  const fractionPart = fractionPartRaw.padEnd(exponent, "0").slice(0, exponent);
  const scale = 10 ** exponent;
  const wholeMinor = Number(wholePart) * scale;
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

export const formatMoney = (money: Money, locale = "fr-CA"): string => {
  const exponent = currencyExponent(money.currency);
  const scale = 10 ** exponent;
  const value = money.amountMinor / scale;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(value);
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
