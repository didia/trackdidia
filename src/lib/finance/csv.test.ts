import { parseCsv, sniffDelimiter } from "./csv";

describe("finance csv parser", () => {
  it("parses quoted fields with embedded commas", () => {
    const { header, rows, warnings } = parseCsv(
      'Date,Description,Amount\n1/2/2026,"Store, Inc",-12.00\n',
    );
    expect(header).toEqual(["Date", "Description", "Amount"]);
    expect(rows).toEqual([["1/2/2026", "Store, Inc", "-12.00"]]);
    expect(warnings).toEqual([]);
  });

  it("parses doubled quotes as a literal quote", () => {
    const { rows } = parseCsv('Date,Description\n1/2/2026,"She said ""hi"""\n');
    expect(rows).toEqual([["1/2/2026", 'She said "hi"']]);
  });

  it("parses embedded newlines inside a quoted field", () => {
    const { rows } = parseCsv('Date,Notes\n1/2/2026,"line one\nline two"\n');
    expect(rows).toEqual([["1/2/2026", "line one\nline two"]]);
  });

  it("handles CRLF, LF, and CR line endings", () => {
    expect(parseCsv("Date,Amount\r\n1/2/2026,-5.00\r\n").rows).toEqual([["1/2/2026", "-5.00"]]);
    expect(parseCsv("Date,Amount\n1/2/2026,-5.00\n").rows).toEqual([["1/2/2026", "-5.00"]]);
    expect(parseCsv("Date,Amount\r1/2/2026,-5.00\r").rows).toEqual([["1/2/2026", "-5.00"]]);
  });

  it("strips a leading BOM", () => {
    const { header } = parseCsv("﻿Date,Amount\n1/2/2026,-5.00\n");
    expect(header).toEqual(["Date", "Amount"]);
  });

  it("sniffs semicolon and tab delimiters", () => {
    expect(sniffDelimiter("Date;Description;Amount")).toBe(";");
    expect(sniffDelimiter("Date\tDescription\tAmount")).toBe("\t");
    expect(sniffDelimiter("Date,Description,Amount")).toBe(",");

    expect(parseCsv("Date;Description;Amount\n1/2/2026;Store;-12.00\n").rows).toEqual([
      ["1/2/2026", "Store", "-12.00"],
    ]);
    expect(parseCsv("Date\tDescription\tAmount\n1/2/2026\tStore\t-12.00\n").rows).toEqual([
      ["1/2/2026", "Store", "-12.00"],
    ]);
  });

  it("reports a ragged row as a warning rather than throwing", () => {
    const { rows, warnings } = parseCsv(
      "Date,Description,Amount\n1/2/2026,Store\n1/3/2026,Store,-5.00,extra\n",
    );
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("line 2");
    expect(warnings[1]).toContain("line 3");
  });

  it("keeps valid rows alongside skipped ragged ones", () => {
    const { rows, warnings } = parseCsv(
      "Date,Amount\n1/2/2026,-5.00\n1/3/2026,-5.00,extra\n1/4/2026,-6.00\n",
    );
    expect(rows).toEqual([
      ["1/2/2026", "-5.00"],
      ["1/4/2026", "-6.00"],
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("returns empty for an empty file", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [], warnings: [] });
  });

  it("returns an empty row set for a header-only file", () => {
    const { header, rows, warnings } = parseCsv("Date,Description,Amount\n");
    expect(header).toEqual(["Date", "Description", "Amount"]);
    expect(rows).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("never throws on malformed input", () => {
    expect(() => parseCsv('"unterminated quote\nDate,Amount\n1/2/2026,-5.00')).not.toThrow();
  });
});

describe("unterminated quotes", () => {
  it("warns and drops the merged record", () => {
    const result = parseCsv('Date,Description\n2026-01-01,"broken\n2026-01-02,Good\n');
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("unterminated");
  });
});
