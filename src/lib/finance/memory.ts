// Pure merchant-memory update math for `setFinanceTransactionCategory`, the
// single learning entry point (specs/done/finance.md "Learning from
// corrections"). No I/O: the repository reads the existing entry (if any) and
// writes back whatever this returns.

import type { FinanceMerchantMemoryEntry, FinanceMerchantMemorySource } from "../../domain/finance";

export interface ApplyMerchantMemoryCorrectionInput {
  existing: FinanceMerchantMemoryEntry | null;
  merchantKey: string;
  accountId: string;
  sign: -1 | 0 | 1;
  categoryId: string;
  source: FinanceMerchantMemorySource;
  now: string;
}

import { DEFAULT_CLASSIFICATION_THRESHOLDS } from "./classify";

const MAX_CONFIDENCE = 0.99;
const AGREEMENT_CONFIDENCE_STEP = 0.05;
const CORRECTION_RESET_CONFIDENCE = 0.6;

/**
 * On agreement with the existing entry, `hitCount += 1` and confidence nudges
 * up (capped at 0.99). On disagreement, the category is replaced,
 * `correctionCount += 1`, and confidence resets to 0.6 so one correction does
 * not immediately become an auto-apply. A missing entry is created fresh at
 * the reset confidence.
 */
export const applyMerchantMemoryCorrection = (
  input: ApplyMerchantMemoryCorrectionInput,
): FinanceMerchantMemoryEntry => {
  const { existing, merchantKey, accountId, sign, categoryId, source, now } = input;

  if (!existing) {
    return {
      merchantKey,
      accountId,
      sign,
      categoryId,
      hitCount: 1,
      correctionCount: 0,
      confidence: CORRECTION_RESET_CONFIDENCE,
      source,
      lastAppliedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (existing.categoryId === categoryId) {
    return {
      ...existing,
      hitCount: existing.hitCount + 1,
      confidence: Math.min(MAX_CONFIDENCE, existing.confidence + AGREEMENT_CONFIDENCE_STEP),
      lastAppliedAt: now,
      updatedAt: now,
    };
  }

  return {
    ...existing,
    categoryId,
    correctionCount: existing.correctionCount + 1,
    confidence: CORRECTION_RESET_CONFIDENCE,
    source,
    lastAppliedAt: now,
    updatedAt: now,
  };
};

export interface BuildAiMemoryEntryInput {
  merchantKey: string;
  sign: -1 | 0 | 1;
  categoryId: string;
  /** The AI's own confidence for this merchant. */
  confidence: number;
  now: string;
}

/**
 * Memory entry written when an AI categorization is applied automatically, so the next
 * import resolves the merchant locally instead of asking the model again. It is scoped to
 * every account (`accountId: ""`) and counts as already confirmed (`hitCount` at the
 * auto-apply floor); it still only auto-applies when the AI's confidence clears the
 * memory confidence threshold, otherwise it resurfaces as a suggestion.
 */
export const buildAiMemoryEntry = (input: BuildAiMemoryEntryInput): FinanceMerchantMemoryEntry => ({
  merchantKey: input.merchantKey,
  accountId: "",
  sign: input.sign,
  categoryId: input.categoryId,
  hitCount: DEFAULT_CLASSIFICATION_THRESHOLDS.memoryAutoApplyHitCount,
  correctionCount: 0,
  confidence: Math.min(MAX_CONFIDENCE, Math.max(0, input.confidence)),
  source: "auto_confirm",
  lastAppliedAt: input.now,
  createdAt: input.now,
  updatedAt: input.now,
});
