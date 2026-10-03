import type { FinanceUnknownMerchantGroup } from "../../../domain/finance";
import {
  amountBucketFor,
  buildFinanceCategorizationSnapshots,
  sanitizeMerchantDescriptor,
} from "./finance-categorization-snapshot";

const group = (
  overrides: Partial<FinanceUnknownMerchantGroup> = {},
): FinanceUnknownMerchantGroup => ({
  merchantKey: "EPICERIE METRO",
  sign: -1,
  occurrenceCount: 3,
  amountMinorSample: 4_500,
  accountType: "checking",
  transactionIds: ["txn-1", "txn-2", "txn-3"],
  ...overrides,
});

const allowedCategories = [
  { id: "fincat:alimentation.epicerie", name: "Épicerie" },
  { id: "fincat:transport.essence", name: "Essence" },
];

describe("sanitizeMerchantDescriptor", () => {
  it("strips digit runs of length >= 4 but leaves shorter runs alone", () => {
    expect(sanitizeMerchantDescriptor("WALMART STORE 45218")).not.toContain("45218");
    expect(sanitizeMerchantDescriptor("WALMART #123")).toContain("123");
  });

  it("strips email addresses", () => {
    expect(sanitizeMerchantDescriptor("PAYPAL JOHN.DOE@EXAMPLE.COM")).not.toContain("@");
    expect(sanitizeMerchantDescriptor("PAYPAL JOHN.DOE@EXAMPLE.COM")).not.toMatch(/EXAMPLE\.COM/i);
  });

  it("strips card/account-looking fragments (digits mixed with X or *)", () => {
    expect(sanitizeMerchantDescriptor("VISA XXXX1234XX")).not.toMatch(/XXXX1234XX/);
  });

  it("strips a full phone-number-shaped fragment", () => {
    const result = sanitizeMerchantDescriptor("INTERAC E-TRANSFER JEAN DUPONT 514-555-1234");
    expect(result).not.toMatch(/514/);
    expect(result).not.toMatch(/555/);
    expect(result).not.toMatch(/1234/);
  });

  it("strips a dangling partial phone fragment with a trailing separator", () => {
    const result = sanitizeMerchantDescriptor("INTERAC E-TRANSFER JEAN DUPONT 514-555-");
    expect(result).not.toMatch(/514/);
    expect(result).not.toMatch(/555/);
  });

  it("leaves a single short digit group alone (not phone-shaped on its own)", () => {
    expect(sanitizeMerchantDescriptor("WALMART #123")).toContain("123");
  });

  it("clamps to 60 characters", () => {
    const long = "A".repeat(200);
    expect(sanitizeMerchantDescriptor(long).length).toBeLessThanOrEqual(60);
  });

  it("never returns an empty string, even when everything identifiable is stripped", () => {
    expect(
      sanitizeMerchantDescriptor("1234567 user@example.com XXXXXX1234").length,
    ).toBeGreaterThan(0);
  });
});

describe("amountBucketFor", () => {
  it("buckets without float division, using integer minor-unit thresholds", () => {
    expect(amountBucketFor(500, "CAD")).toBe("<10"); // $5.00
    expect(amountBucketFor(999, "CAD")).toBe("<10"); // $9.99
    expect(amountBucketFor(1_000, "CAD")).toBe("10-50"); // $10.00
    expect(amountBucketFor(4_999, "CAD")).toBe("10-50"); // $49.99
    expect(amountBucketFor(5_000, "CAD")).toBe("50-200"); // $50.00
    expect(amountBucketFor(19_999, "CAD")).toBe("50-200"); // $199.99
    expect(amountBucketFor(20_000, "CAD")).toBe("200-1000"); // $200.00
    expect(amountBucketFor(99_999, "CAD")).toBe("200-1000"); // $999.99
    expect(amountBucketFor(100_000, "CAD")).toBe(">1000"); // $1000.00
  });

  it("uses the absolute value, ignoring sign", () => {
    expect(amountBucketFor(-500, "CAD")).toBe("<10");
  });
});

describe("buildFinanceCategorizationSnapshots", () => {
  it("returns no chunks when scope is metrics — the AI stage is disabled entirely", () => {
    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants: [group()], allowedCategories, baseCurrency: "CAD" },
      "metrics",
    );
    expect(chunks).toHaveLength(0);
  });

  it("returns no chunks when there are no unknown merchants", () => {
    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants: [], allowedCategories, baseCurrency: "CAD" },
      "full",
    );
    expect(chunks).toHaveLength(0);
  });

  it("serializes a payload that contains no balance, account name, person name, exact amount, or date", () => {
    const chunks = buildFinanceCategorizationSnapshots(
      {
        unknownMerchants: [group({ merchantKey: "EPICERIE METRO 4521", amountMinorSample: 4_523 })],
        allowedCategories,
        baseCurrency: "CAD",
      },
      "full",
    );
    expect(chunks).toHaveLength(1);
    const serialized = JSON.stringify(chunks[0].snapshot);

    // No exact amount: 4523 (the raw cents) never appears; only the bucket label does.
    expect(serialized).not.toContain("4523");
    expect(serialized).not.toContain("4521"); // the digit run from the merchant string
    // No date, no account name/institution/balance/person-name fields exist on the shape at all.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialized).not.toContain("balance");
    expect(serialized).not.toContain("institution");
    expect(serialized).not.toContain("ownerPersonId");
    expect(serialized).toContain("amountBucket");
    expect(serialized).toContain("10-50");
  });

  it("applies the digit-run/email/card-fragment sanitizer only to merchant descriptors, not to amount buckets or occurrence counts", () => {
    const chunks = buildFinanceCategorizationSnapshots(
      {
        unknownMerchants: [group({ occurrenceCount: 1234, amountMinorSample: 100_000 })],
        allowedCategories,
        baseCurrency: "CAD",
      },
      "full",
    );
    const [merchant] = chunks[0].snapshot.merchants;
    expect(merchant.occurrenceCount).toBe(1234);
    expect(merchant.amountBucket).toBe(">1000");
  });

  it("splits into multiple requests when the merchant count exceeds 40", () => {
    const unknownMerchants = Array.from({ length: 85 }, (_, index) =>
      group({ merchantKey: `MARCHAND ${index}`, transactionIds: [`txn-${index}`] }),
    );
    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants, allowedCategories, baseCurrency: "CAD" },
      "full",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.snapshot.merchants.length).toBeLessThanOrEqual(40);
    }
    const totalMerchants = chunks.reduce((sum, chunk) => sum + chunk.snapshot.merchants.length, 0);
    expect(totalMerchants).toBe(85);
  });

  it("splits (never truncates) when the serialized payload would exceed 16 KiB", () => {
    // Each category name is long enough that even a handful of merchants pushes a single chunk
    // over 16 KiB well before the 40-merchant cap is reached (the fixed `allowedCategories`
    // overhead alone, with 0 merchants, serializes to ~15.3 KiB here — comfortably under the
    // cap on its own, but leaving only room for a handful of merchants per chunk).
    const manyCategories = Array.from({ length: 180 }, (_, index) => ({
      id: `fincat:test-${index}`,
      name: `Categorie test ${index} nom moyen pour peser un peu plus`,
    }));
    const unknownMerchants = Array.from({ length: 40 }, (_, index) =>
      group({ merchantKey: `MARCHAND ${index}`, transactionIds: [`txn-${index}`] }),
    );
    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants, allowedCategories: manyCategories, baseCurrency: "CAD" },
      "full",
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const size = new TextEncoder().encode(JSON.stringify(chunk.snapshot)).length;
      expect(size).toBeLessThanOrEqual(16 * 1024);
    }
    const totalMerchants = chunks.reduce((sum, chunk) => sum + chunk.snapshot.merchants.length, 0);
    expect(totalMerchants).toBe(40);
  });

  it("builds a merchantKeyMap that maps each request key back to its original merchant key", () => {
    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants: [group()], allowedCategories, baseCurrency: "CAD" },
      "full",
    );
    const [chunk] = chunks;
    const [merchant] = chunk.snapshot.merchants;
    expect(chunk.merchantKeyMap[merchant.merchantKey]).toEqual(["EPICERIE METRO"]);
  });
});
