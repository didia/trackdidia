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
      {
        merchantKey: "ESSO",
        categoryId: "fincat:transport.essence",
        confidence: 0.8,
        rationale: "Station-service.",
      },
    ],
  };
  const withFirst = (override: Record<string, unknown>) => ({
    merchants: [{ ...validPayload.merchants[0], ...override }, validPayload.merchants[1]],
  });

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
      withFirst({ categoryId: "fincat:non-categorise" }),
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a merchant key that was not part of this request", () => {
    const result = validateFinanceCategorizationResponse(
      withFirst({ merchantKey: "UNKNOWN MERCHANT" }),
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a confidence outside [0, 1]", () => {
    expect(
      validateFinanceCategorizationResponse(
        withFirst({ confidence: 1.5 }),
        allowedCategoryIds,
        allowedMerchantKeys,
      ).ok,
    ).toBe(false);
    expect(
      validateFinanceCategorizationResponse(
        withFirst({ confidence: -0.1 }),
        allowedCategoryIds,
        allowedMerchantKeys,
      ).ok,
    ).toBe(false);
  });

  it("rejects an extra field", () => {
    const result = validateFinanceCategorizationResponse(
      withFirst({ extra: "nope" }),
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a missing rationale", () => {
    const { rationale: _rationale, ...withoutRationale } = validPayload.merchants[0];
    const result = validateFinanceCategorizationResponse(
      { merchants: [withoutRationale, validPayload.merchants[1]] },
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

  it("rejects an empty merchants array when merchants were requested", () => {
    const result = validateFinanceCategorizationResponse(
      { merchants: [] },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a response that omits a requested merchant", () => {
    const result = validateFinanceCategorizationResponse(
      { merchants: [validPayload.merchants[0]] },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects contradictory duplicate answers for one merchant", () => {
    const result = validateFinanceCategorizationResponse(
      {
        merchants: [
          validPayload.merchants[0],
          { ...validPayload.merchants[0], categoryId: "fincat:transport.essence" },
          validPayload.merchants[1],
        ],
      },
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result).toEqual({ ok: false, error: "a merchantKey appears more than once" });
  });

  it("never echoes merchant descriptors in its error messages", () => {
    const result = validateFinanceCategorizationResponse(
      withFirst({ merchantKey: "INTERAC E-TRANSFER JEAN DUPONT " }),
      allowedCategoryIds,
      allowedMerchantKeys,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/DUPONT/);
  });
});
