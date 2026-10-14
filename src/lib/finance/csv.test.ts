import { looksLikeDataRow, parseCsv, sniffDelimiter } from "./csv";

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

describe("headerless files", () => {
  const CIBC = [
    '2026-10-08,"CAFETERIA HSS QUEBEC, QC",5.30,,5268********6956',
    "2026-09-25,PAYMENT THANK YOU/PAIEMEN T MERCI,,45.00,5268********6956",
  ].join("\n");

  it("treats every line as a row and names the columns", () => {
    const { header, rows, warnings } = parseCsv(CIBC, undefined, { hasHeader: false });
    expect(header).toEqual(["Column 1", "Column 2", "Column 3", "Column 4", "Column 5"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      "2026-10-08",
      "CAFETERIA HSS QUEBEC, QC",
      "5.30",
      "",
      "5268********6956",
    ]);
    expect(warnings).toEqual([]);
  });

  it("uses the given column label and numbers warnings from line 1", () => {
    const { header, warnings } = parseCsv(`${CIBC}\n2026-01-01,short`, undefined, {
      hasHeader: false,
      columnLabel: "Colonne",
    });
    expect(header[0]).toBe("Colonne 1");
    expect(warnings).toEqual(["line 3: expected 5 fields, got 2; row skipped"]);
  });

  it("keeps the first line as the header by default", () => {
    expect(parseCsv(CIBC).rows).toHaveLength(1);
  });

  it("returns empty for an empty headerless file", () => {
    expect(parseCsv("", undefined, { hasHeader: false })).toEqual({
      header: [],
      rows: [],
      warnings: [],
    });
  });
});

describe("looksLikeDataRow", () => {
  it("flags a line holding a date and not a column-title line", () => {
    expect(looksLikeDataRow(["2026-10-08", "SHOP", "5.30"])).toBe(true);
    expect(looksLikeDataRow(["10/08/2026", "SHOP"])).toBe(true);
    expect(looksLikeDataRow(["Date", "Description", "Amount"])).toBe(false);
  });
});

describe("unterminated quotes", () => {
  it("warns and drops the merged record", () => {
    const result = parseCsv('Date,Description\n2026-01-01,"broken\n2026-01-02,Good\n');
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("unterminated");
  });
});
