import { parseCsv } from "./csv";
import {
  MINT_PROFILE,
  assignOccurrenceIndices,
  buildHeaderSignature,
  dedupeHash,
  inferDateFormat,
  mapImportRowToTransaction,
  merchantKey,
  normalizeDescription,
  parseDateWithFormat,
} from "./import-profile";

const MINT_FIXTURE = [
  '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
  '"1/15/2026","Metro","METRO #4521 MONTREAL QC","54.32","debit","Groceries","Checking","","Weekly groceries"',
  '"1/16/2026","Paycheque","ACME CORP PAYROLL DEP","2000.00","credit","Paycheck","Checking","",""',
  '"1/17/2026","Netflix","NETFLIX.COM REF123456","16.99","debit","Streaming","Credit Card","entertainment",""',
].join("\n");

const GENERIC_SINGLE_SIGNED_FIXTURE = [
  "Date,Description,Amount,Account",
  "2026-01-15,Grocery Store,-54.32,Checking",
  "2026-01-16,Employer Payroll,2000.00,Checking",
].join("\n");

const GENERIC_DEBIT_CREDIT_FIXTURE = [
  "Date,Description,Debit,Credit,Account",
  "15/01/2026,Grocery Store,54.32,,Checking",
  "16/01/2026,Employer Payroll,,2000.00,Checking",
].join("\n");

describe("buildHeaderSignature", () => {
  it("matches the Mint header regardless of casing/accents/spacing noise", () => {
    const signature = buildHeaderSignature([
      "Date",
      "Description",
      "Original Description",
      "Amount",
      "Transaction Type",
      "Category",
      "Account Name",
      "Labels",
      "Notes",
    ]);
    expect(signature).toBe(MINT_PROFILE.signature);
  });

  it("is stable for the same logical header with different punctuation", () => {
    const a = buildHeaderSignature(["Date", "Amount"]);
    const b = buildHeaderSignature([" date ", "AMOUNT"]);
    expect(a).toBe(b);
  });
});

describe("inferDateFormat", () => {
  it("reports ambiguity when every sampled day is <= 12 in both positions", () => {
    const result = inferDateFormat(["1/2/2026", "3/4/2026", "5/6/2026"]);
    expect(result.ambiguous).toBe(true);
  });

  it("infers D/M/YYYY unambiguously when a first component exceeds 12", () => {
    const result = inferDateFormat(["15/1/2026", "16/1/2026"]);
    expect(result).toEqual({ format: "D/M/YYYY", ambiguous: false });
  });

  it("infers M/D/YYYY unambiguously when a second component exceeds 12", () => {
    const result = inferDateFormat(["1/15/2026", "1/16/2026"]);
    expect(result).toEqual({ format: "M/D/YYYY", ambiguous: false });
  });

  it("recognizes YYYY-MM-DD", () => {
    expect(inferDateFormat(["2026-01-15", "2026-01-16"])).toEqual({
      format: "YYYY-MM-DD",
      ambiguous: false,
    });
  });
});

describe("parseDateWithFormat", () => {
  it("parses M/D/YYYY and D/M/YYYY to local YYYY-MM-DD", () => {
    expect(parseDateWithFormat("1/15/2026", "M/D/YYYY")).toBe("2026-01-15");
    expect(parseDateWithFormat("15/1/2026", "D/M/YYYY")).toBe("2026-01-15");
  });

  it("returns null for an unparseable date", () => {
    expect(parseDateWithFormat("not-a-date", "M/D/YYYY")).toBeNull();
  });

  it("validates real month length, rejecting a day that does not exist", () => {
    expect(parseDateWithFormat("2/31/2024", "M/D/YYYY")).toBeNull();
  });

  it("accepts February 29 in a leap year and rejects it in a non-leap year", () => {
    expect(parseDateWithFormat("2/29/2024", "M/D/YYYY")).toBe("2024-02-29");
    expect(parseDateWithFormat("2/29/2026", "M/D/YYYY")).toBeNull();
  });
});

describe("normalizeDescription / merchantKey", () => {
  it("uppercases, strips accents, collapses whitespace", () => {
    expect(normalizeDescription("  café  de la  paix  ")).toBe("CAFE DE LA PAIX");
  });

  it("removes trailing reference/auth numbers", () => {
    expect(normalizeDescription("NETFLIX.COM REF123456")).toBe("NETFLIX.COM");
    expect(normalizeDescription("STORE #45213")).toBe("STORE");
  });

  it("merchantKey uses the same normalizer as dedupe", () => {
    expect(merchantKey("Metro #4521")).toBe(normalizeDescription("Metro #4521"));
  });
});

describe("mapImportRowToTransaction with the Mint profile", () => {
  it("maps every row of the Mint fixture to expected minor-unit rows", () => {
    const { header, rows } = parseCsv(MINT_FIXTURE);
    const mapped = rows.map((row) =>
      mapImportRowToTransaction(row, header, MINT_PROFILE, { currency: "CAD" }),
    );

    expect(mapped.every((result) => result.ok)).toBe(true);

    const [metro, paycheque, netflix] = mapped.map((result) => (result.ok ? result.row : null));

    expect(metro).toMatchObject({
      postedDate: "2026-01-15",
      amountMinor: -5432,
      descriptionRaw: "Metro",
      descriptionOriginal: "METRO #4521 MONTREAL QC",
      merchantKey: "METRO",
    });
    expect(paycheque).toMatchObject({ postedDate: "2026-01-16", amountMinor: 200000 });
    expect(netflix).toMatchObject({ postedDate: "2026-01-17", amountMinor: -1699 });
  });

  it("re-parsing the same fixture yields identical dedupe hashes", () => {
    const parseAndHash = () => {
      const { header, rows } = parseCsv(MINT_FIXTURE);
      const mapped = rows.map((row) => {
        const result = mapImportRowToTransaction(row, header, MINT_PROFILE, { currency: "CAD" });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        return result.row;
      });

      const occurrenceIndices = assignOccurrenceIndices(
        mapped.map((row) => ({
          accountId: "acct-1",
          postedDate: row.postedDate,
          amountMinor: row.amountMinor,
          currency: row.currency,
          descriptionRaw: row.descriptionRaw,
        })),
      );

      return mapped.map((row, index) =>
        dedupeHash({
          accountId: "acct-1",
          postedDate: row.postedDate,
          amountMinor: row.amountMinor,
          currency: row.currency,
          descriptionRaw: row.descriptionRaw,
          occurrenceIndex: occurrenceIndices[index],
        }),
      );
    };

    expect(parseAndHash()).toEqual(parseAndHash());
  });

  it("maps a blank Labels cell to null and splits a multi-label cell into an array", () => {
    const fixtureWithLabels = [
      '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
      '"1/15/2026","Metro","METRO #4521 MONTREAL QC","54.32","debit","Groceries","Checking","","Weekly groceries"',
      '"1/17/2026","Netflix","NETFLIX.COM REF123456","16.99","debit","Streaming","Credit Card","entertainment, streaming",""',
    ].join("\n");
    const { header, rows } = parseCsv(fixtureWithLabels);
    const mapped = rows.map((row) =>
      mapImportRowToTransaction(row, header, MINT_PROFILE, { currency: "CAD" }),
    );

    expect(mapped.every((result) => result.ok)).toBe(true);
    const [metro, netflix] = mapped.map((result) => (result.ok ? result.row : null));

    expect(metro?.labelsJson).toBeNull();
    expect(netflix?.labelsJson).toBe(JSON.stringify(["entertainment", "streaming"]));
  });
});

describe("assignOccurrenceIndices / dedupeHash for identical same-day rows", () => {
  it("assigns distinct occurrence indices and distinct dedupe hashes to two identical rows", () => {
    const rows = [
      {
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -500,
        currency: "CAD",
        descriptionRaw: "COFFEE SHOP",
      },
      {
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -500,
        currency: "CAD",
        descriptionRaw: "COFFEE SHOP",
      },
    ];

    const indices = assignOccurrenceIndices(rows);
    expect(indices).toEqual([0, 1]);

    const hashes = rows.map((row, index) =>
      dedupeHash({ ...row, occurrenceIndex: indices[index] }),
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("mapImportRowToTransaction with generic profiles", () => {
  it("maps a single_signed amount generic fixture", () => {
    const { header, rows } = parseCsv(GENERIC_SINGLE_SIGNED_FIXTURE);
    const profile = {
      ...MINT_PROFILE,
      columnMap: { date: 0, description: 1, amount: 2, account: 3 },
      dateFormat: "YYYY-MM-DD" as const,
      amountMode: "single_signed" as const,
    };

    const mapped = rows.map((row) =>
      mapImportRowToTransaction(row, header, profile, { currency: "CAD" }),
    );
    expect(mapped.every((result) => result.ok)).toBe(true);
    expect(mapped[0].ok && mapped[0].row.amountMinor).toBe(-5432);
    expect(mapped[1].ok && mapped[1].row.amountMinor).toBe(200000);
  });

  it("maps a debit/credit-column generic fixture", () => {
    const { header, rows } = parseCsv(GENERIC_DEBIT_CREDIT_FIXTURE);
    const profile = {
      ...MINT_PROFILE,
      columnMap: { date: 0, description: 1, debit: 2, credit: 3, account: 4 },
      dateFormat: "D/M/YYYY" as const,
      amountMode: "debit_credit_columns" as const,
    };

    const mapped = rows.map((row) =>
      mapImportRowToTransaction(row, header, profile, { currency: "CAD" }),
    );
    expect(mapped.every((result) => result.ok)).toBe(true);
    expect(mapped[0].ok && mapped[0].row.amountMinor).toBe(-5432);
    expect(mapped[0].ok && mapped[0].row.postedDate).toBe("2026-01-15");
    expect(mapped[1].ok && mapped[1].row.amountMinor).toBe(200000);
  });

  it("reports a row error rather than throwing on a bad date", () => {
    const { header, rows } = parseCsv("Date,Description,Amount\nnot-a-date,Store,-5.00\n");
    const profile = {
      ...MINT_PROFILE,
      columnMap: { date: 0, description: 1, amount: 2 },
      dateFormat: "M/D/YYYY" as const,
      amountMode: "single_signed" as const,
    };
    const result = mapImportRowToTransaction(rows[0], header, profile, { currency: "CAD" });
    expect(result.ok).toBe(false);
  });
});
