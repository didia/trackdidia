import type { AiUsageSummary, AiUsageTotals } from "../../../domain/types";

/** Static rough rate table (USD per 1M tokens). OpenRouter pricing varies by model. */
export const DEFAULT_COST_PER_MILLION_TOKENS = 1;

export const estimateTokenCostUsd = (tokensTotal: number, costPerMillionTokens: number): number =>
  (tokensTotal / 1_000_000) * costPerMillionTokens;

export const applyCostEstimate = (
  summary: AiUsageTotals,
  costPerMillionTokens: number,
): AiUsageSummary => ({
  ...summary,
  estimatedCostUsd: estimateTokenCostUsd(summary.tokensTotal, costPerMillionTokens),
});

export const buildAiUsageSummary = (
  monthKey: string,
  callCount: number,
  tokensPrompt: number,
  tokensCompletion: number,
  costPerMillionTokens: number,
): AiUsageSummary => {
  const tokensTotal = tokensPrompt + tokensCompletion;
  return {
    monthKey,
    callCount,
    tokensPrompt,
    tokensCompletion,
    tokensTotal,
    estimatedCostUsd: estimateTokenCostUsd(tokensTotal, costPerMillionTokens),
  };
};
