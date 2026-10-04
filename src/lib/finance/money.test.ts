import {
  addMoney,
  currencyExponent,
  formatMoney,
  formatMoneySigned,
  minorToInputString,
  normalizeCurrencyCode,
  parseAmountToMinor,
  sumMoney,
} from "./money";

describe("finance money", () => {
  it("parses a thousands comma + decimal dot amount, and a space thousands + comma decimal amount", () => {
    expect(parseAmountToMinor("1,234.56")).toEqual({ ok: true, amountMinor: 123456 });
    expect(parseAmountToMinor("1 234,56")).toEqual({ ok: true, amountMinor: 123456 });
  });

  it("treats a single separator with an exactly-3-digit trailing group as thousands, not decimal", () => {
    expect(parseAmountToMinor("1,234")).toEqual({ ok: true, amountMinor: 123400 });
    expect(parseAmountToMinor("1.234")).toEqual({ ok: true, amountMinor: 123400 });
  });

  it("respects explicit decimalSeparator/thousandsSeparator options over the ambiguity heuristic", () => {
    expect(parseAmountToMinor("1.23", { decimalSeparator: ".", thousandsSeparator: "" })).toEqual({
      ok: true,
      amountMinor: 123,
    });
    expect(
      parseAmountToMinor("1.234,56", { decimalSeparator: ",", thousandsSeparator: "." }),
    ).toEqual({ ok: true, amountMinor: 123456 });
  });

  it("parses an accounting-negative amount in parentheses", () => {
    expect(parseAmountToMinor("(45.00)")).toEqual({ ok: true, amountMinor: -4500 });
  });

  it("parses a leading currency symbol with a unicode minus", () => {
    expect(parseAmountToMinor("$-12.00")).toEqual({ ok: true, amountMinor: -1200 });
    expect(parseAmountToMinor("−12.00")).toEqual({ ok: true, amountMinor: -1200 });
    expect(parseAmountToMinor("CA$5.00")).toEqual({ ok: true, amountMinor: 500 });
  });

  it("parses a trailing CR/DR marker", () => {
    expect(parseAmountToMinor("12.00 CR")).toEqual({ ok: true, amountMinor: 1200 });
    expect(parseAmountToMinor("12.00 DR")).toEqual({ ok: true, amountMinor: -1200 });
  });

  it("respects a zero-exponent currency like JPY", () => {
    expect(parseAmountToMinor("1234", { exponent: currencyExponent("JPY") })).toEqual({
      ok: true,
      amountMinor: 1234,
    });
  });

  it("never throws and reports a discriminated failure on unparseable input", () => {
    expect(parseAmountToMinor("")).toEqual({ ok: false, reason: "empty" });
    const result = parseAmountToMinor("not a number");
    expect(result.ok).toBe(false);
  });

  it("falls back to exponent 2 for an unknown currency code", () => {
    expect(currencyExponent("XYZ")).toBe(2);
  });

  it("formats money via Intl.NumberFormat", () => {
    expect(formatMoney({ amountMinor: 123456, currency: "CAD" })).toContain(`1 234,56`);
  });

  it("formats signed money with an explicit sign", () => {
    expect(formatMoneySigned({ amountMinor: -500, currency: "CAD" }).startsWith("-")).toBe(true);
    expect(formatMoneySigned({ amountMinor: 500, currency: "CAD" }).startsWith("+")).toBe(true);
  });

  it("adds money of the same currency", () => {
    expect(
      addMoney({ amountMinor: 100, currency: "CAD" }, { amountMinor: 50, currency: "CAD" }),
    ).toEqual({
      amountMinor: 150,
      currency: "CAD",
    });
  });

  it("throws on mixed-currency addMoney/sumMoney", () => {
    expect(() =>
      addMoney({ amountMinor: 100, currency: "CAD" }, { amountMinor: 50, currency: "USD" }),
    ).toThrow();
    expect(() =>
      sumMoney([
        { amountMinor: 100, currency: "CAD" },
        { amountMinor: 50, currency: "USD" },
      ]),
    ).toThrow();
  });

  it("sums without float drift over 10 000 additions", () => {
    const values = Array.from({ length: 10_000 }, () => ({ amountMinor: 1, currency: "CAD" }));
    expect(sumMoney(values)).toEqual({ amountMinor: 10_000, currency: "CAD" });
  });

  it("sums fractional-looking minor-unit amounts without drift", () => {
    const values = Array.from({ length: 10_000 }, () => ({ amountMinor: 11, currency: "CAD" }));
    const result = sumMoney(values);
    expect(result.amountMinor).toBe(110_000);
    expect(Number.isInteger(result.amountMinor)).toBe(true);
  });

  it("minorToInputString renders minor units as a plain decimal string, round-tripping through parseAmountToMinor", () => {
    expect(minorToInputString(1234, 2)).toBe("12.34");
    expect(minorToInputString(-1234, 2)).toBe("-12.34");
    expect(minorToInputString(5, 2)).toBe("0.05");
    expect(minorToInputString(0, 2)).toBe("0.00");
    expect(minorToInputString(500, 0)).toBe("500");
    expect(minorToInputString(-500, 0)).toBe("-500");

    expect(parseAmountToMinor(minorToInputString(123456, 2), { exponent: 2 })).toEqual({
      ok: true,
      amountMinor: 123456,
    });
    expect(parseAmountToMinor(minorToInputString(-123456, 2), { exponent: 2 })).toEqual({
      ok: true,
      amountMinor: -123456,
    });
  });
});

describe("parseAmountToMinor strictness", () => {
  it("rejects malformed grouping and excess precision", () => {
    expect(parseAmountToMinor("12.34.56").ok).toBe(false);
    expect(parseAmountToMinor("1,23,4").ok).toBe(false);
    expect(parseAmountToMinor("1.999", { exponent: 2, decimalSeparator: "." }).ok).toBe(false);
    expect(parseAmountToMinor("1.5", { exponent: 0, decimalSeparator: "." }).ok).toBe(false);
    expect(parseAmountToMinor("1,234,567.89")).toEqual({ ok: true, amountMinor: 123456789 });
  });
});

describe("currency validation", () => {
  it("normalizes valid codes and rejects malformed ones", () => {
    expect(normalizeCurrencyCode(" cad ")).toBe("CAD");
    expect(normalizeCurrencyCode("CA")).toBeNull();
    expect(normalizeCurrencyCode("")).toBeNull();
    expect(normalizeCurrencyCode("C4D")).toBeNull();
  });

  it("formatMoney does not throw on a malformed stored currency", () => {
    expect(() => formatMoney({ amountMinor: 1234, currency: "CA" })).not.toThrow();
  });
});
