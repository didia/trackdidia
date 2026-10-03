import { validateFinanceCategorizationResponse } from "./finance-categorization-validator";

describe("validateFinanceCategorizationResponse", () => {
  const allowedCategoryIds = new Set(["fincat:alimentation.epicerie", "fincat:transport.essence"]);
  const allowedMerchantKeys = new Set(["EPICERIE METRO", "ESSO"]);

  const validPayload = {
    merchants: [
      {
        merchantKey: "EPICERIE METRO",
        categoryId: "fincat:alimentation.epicerie",
        confidence: 0.9,
        rationale: "Chaîne d'épicerie connue.",
      },
    ],
  };

  it("accepts a valid finance categorization payload", () => {
    const result = validateFinanceCategorizationResponse(
      validPayload,
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a category id outside the allowed list", () => {
    const result = validateFinanceCategorizationResponse(
      {
        merchants: [{ ...validPayload.merchants[0], categoryId: "fincat:non-categorise" }],
      },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a merchant key that was not part of this request", () => {
    const result = validateFinanceCategorizationResponse(
      {
        merchants: [{ ...validPayload.merchants[0], merchantKey: "UNKNOWN MERCHANT" }],
      },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a confidence outside [0, 1]", () => {
    expect(
      validateFinanceCategorizationResponse(
        { merchants: [{ ...validPayload.merchants[0], confidence: 1.5 }] },
        allowedCategoryIds,
        allowedMerchantKeys,
      ).ok,
    ).toBe(false);
    expect(
      validateFinanceCategorizationResponse(
        { merchants: [{ ...validPayload.merchants[0], confidence: -0.1 }] },
        allowedCategoryIds,
        allowedMerchantKeys,
      ).ok,
    ).toBe(false);
  });

  it("rejects an extra field", () => {
    const result = validateFinanceCategorizationResponse(
      { merchants: [{ ...validPayload.merchants[0], extra: "nope" }] },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a missing rationale", () => {
    const { rationale: _rationale, ...withoutRationale } = validPayload.merchants[0];
    const result = validateFinanceCategorizationResponse(
      { merchants: [withoutRationale] },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(
      validateFinanceCategorizationResponse(null, allowedCategoryIds, allowedMerchantKeys).ok,
    ).toBe(false);
    expect(
      validateFinanceCategorizationResponse("nope", allowedCategoryIds, allowedMerchantKeys).ok,
    ).toBe(false);
  });

  it("rejects when merchants is not an array", () => {
    expect(
      validateFinanceCategorizationResponse(
        { merchants: "nope" },
        allowedCategoryIds,
        allowedMerchantKeys,
      ).ok,
    ).toBe(false);
  });
});
