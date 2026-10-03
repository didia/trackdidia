import type { FinanceCategorizationResponse } from "../../../domain/types";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isFiniteConfidence = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const ALLOWED_MERCHANT_FIELDS = new Set(["merchantKey", "categoryId", "confidence", "rationale"]);

/**
 * Strict parse for the `finance_categorization` surface: rejects an unknown category id, a
 * merchant key that was not part of this request, a confidence outside `[0, 1]`, and any extra
 * field — see specs/done/finance.md "AI stage".
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

  for (const merchant of record.merchants) {
    if (typeof merchant !== "object" || merchant === null) {
      return { ok: false, error: "each merchant must be an object" };
    }

    const item = merchant as Record<string, unknown>;
    const extraFields = Object.keys(item).filter((key) => !ALLOWED_MERCHANT_FIELDS.has(key));
    if (extraFields.length > 0) {
      return { ok: false, error: `unexpected field(s): ${extraFields.join(", ")}` };
    }

    if (!isNonEmptyString(item.merchantKey)) {
      return { ok: false, error: "merchantKey is required" };
    }
    if (!allowedMerchantKeys.has(item.merchantKey)) {
      return { ok: false, error: `merchantKey not in request: ${item.merchantKey}` };
    }
    if (!isNonEmptyString(item.categoryId)) {
      return { ok: false, error: "categoryId is required" };
    }
    if (!allowedCategoryIds.has(item.categoryId)) {
      return { ok: false, error: `categoryId not in allowed list: ${item.categoryId}` };
    }
    if (!isFiniteConfidence(item.confidence)) {
      return { ok: false, error: "confidence must be a number between 0 and 1" };
    }
    if (!isNonEmptyString(item.rationale)) {
      return { ok: false, error: "rationale is required" };
    }
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
