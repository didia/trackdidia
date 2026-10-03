import {
  addMoney,
  currencyExponent,
  formatMoney,
  formatMoneySigned,
  parseAmountToMinor,
  sumMoney,
} from "./money";

describe("finance money", () => {
  it("parses a thousands-and-decimal amount with a comma decimal and space thousands", () => {
    expect(parseAmountToMinor("1,234.56")).toEqual({ ok: true, amountMinor: 123456 });
    expect(parseAmountToMinor("1 234,56")).toEqual({ ok: true, amountMinor: 123456 });
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
});
