import type { FinanceCategorizationResponse } from "../../../domain/types";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isFiniteConfidence = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const ALLOWED_MERCHANT_FIELDS = new Set(["merchantKey", "categoryId", "confidence", "rationale"]);

/**
 * Strict parse for the `finance_categorization` surface: rejects an unknown category id, a
 * merchant key that was not part of this request, a confidence outside `[0, 1]`, and any extra
 * field on a merchant, a duplicated merchant key, and a response that does not cover every
 * requested merchant — see specs/done/finance.md "AI stage". Error messages never echo response
 * or request values: they feed warnings that get logged, and merchant descriptors must not reach
 * the diagnostic log.
 */
export const validateFinanceCategorizationResponse = (
  payload: unknown,
  allowedCategoryIds: ReadonlySet<string>,
  allowedMerchantKeys: ReadonlySet<string>,
): { ok: true; value: FinanceCategorizationResponse } | { ok: false; error: string } => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.merchants)) {
    return { ok: false, error: "merchants must be an array" };
  }

  const seenMerchantKeys = new Set<string>();
  for (const merchant of record.merchants) {
    if (typeof merchant !== "object" || merchant === null) {
      return { ok: false, error: "each merchant must be an object" };
    }

    const item = merchant as Record<string, unknown>;
    const extraFields = Object.keys(item).filter((key) => !ALLOWED_MERCHANT_FIELDS.has(key));
    if (extraFields.length > 0) {
      return { ok: false, error: "a merchant has unexpected fields" };
    }

    if (!isNonEmptyString(item.merchantKey)) {
      return { ok: false, error: "merchantKey is required" };
    }
    if (!allowedMerchantKeys.has(item.merchantKey)) {
      return { ok: false, error: "a merchantKey is not in the request" };
    }
    if (seenMerchantKeys.has(item.merchantKey)) {
      return { ok: false, error: "a merchantKey appears more than once" };
    }
    seenMerchantKeys.add(item.merchantKey);
    if (!isNonEmptyString(item.categoryId)) {
      return { ok: false, error: "categoryId is required" };
    }
    if (!allowedCategoryIds.has(item.categoryId)) {
      return { ok: false, error: "a categoryId is not in the allowed list" };
    }
    if (!isFiniteConfidence(item.confidence)) {
      return { ok: false, error: "confidence must be a number between 0 and 1" };
    }
    if (!isNonEmptyString(item.rationale)) {
      return { ok: false, error: "rationale is required" };
    }
  }

  if (seenMerchantKeys.size !== allowedMerchantKeys.size) {
    return {
      ok: false,
      error: "the response must contain exactly one entry per requested merchant",
    };
  }

  return { ok: true, value: record as unknown as FinanceCategorizationResponse };
};

export const parseFinanceCategorizationJson = (
  raw: string,
  allowedCategoryIds: ReadonlySet<string>,
  allowedMerchantKeys: ReadonlySet<string>,
): { ok: true; value: FinanceCategorizationResponse } | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validateFinanceCategorizationResponse(parsed, allowedCategoryIds, allowedMerchantKeys);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};
