import { applyMerchantMemoryCorrection } from "./memory";

describe("applyMerchantMemoryCorrection", () => {
  it("creates a fresh entry at the reset confidence when none exists", () => {
    const result = applyMerchantMemoryCorrection({
      existing: null,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      hitCount: 1,
      correctionCount: 0,
      confidence: 0.6,
    });
  });

  it("increments hitCount and nudges confidence up on agreement", () => {
    const existing = applyMerchantMemoryCorrection({
      existing: null,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-01T00:00:00.000Z",
    });

    const result = applyMerchantMemoryCorrection({
      existing,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(result.hitCount).toBe(2);
    expect(result.correctionCount).toBe(0);
    expect(result.confidence).toBeCloseTo(0.65);
  });

  it("caps confidence at 0.99 across many agreements", () => {
    let entry = applyMerchantMemoryCorrection({
      existing: null,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-01T00:00:00.000Z",
    });

    for (let index = 0; index < 20; index += 1) {
      entry = applyMerchantMemoryCorrection({
        existing: entry,
        merchantKey: "IGA",
        accountId: "acct-1",
        sign: -1,
        categoryId: "fincat:alimentation.epicerie",
        source: "user_correction",
        now: "2026-01-01T00:00:00.000Z",
      });
    }

    expect(entry.confidence).toBeLessThanOrEqual(0.99);
  });

  it("replaces the category, bumps correctionCount, and resets confidence on disagreement", () => {
    let entry = applyMerchantMemoryCorrection({
      existing: null,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-01T00:00:00.000Z",
    });
    entry = applyMerchantMemoryCorrection({
      existing: entry,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      source: "user_correction",
      now: "2026-01-02T00:00:00.000Z",
    });

    const corrected = applyMerchantMemoryCorrection({
      existing: entry,
      merchantKey: "IGA",
      accountId: "acct-1",
      sign: -1,
      categoryId: "fincat:alimentation.restaurants",
      source: "user_correction",
      now: "2026-01-03T00:00:00.000Z",
    });

    expect(corrected.categoryId).toBe("fincat:alimentation.restaurants");
    expect(corrected.correctionCount).toBe(1);
    expect(corrected.confidence).toBe(0.6);
    expect(corrected.hitCount).toBe(entry.hitCount);
  });
});
