import type { AiMessage } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { FINANCE_CATEGORIZATION_PROMPT_VERSION } from "./finance-categorization-service";

/**
 * Hydrates the most recent `finance_categorization` run (any chunk/scope) for display, e.g. a
 * "last run" note on `/finances/review`. A stale prompt version — an older schema's row — is
 * rejected the same way every other surface's loader rejects one, instead of being rendered as
 * current.
 */
export const loadLatestFinanceCategorizationRun = async (
  repository: AppRepository,
): Promise<AiMessage | null> => {
  const [latest] = await repository.listAiMessages("finance_categorization", 1);
  if (!latest || latest.promptVersion !== FINANCE_CATEGORIZATION_PROMPT_VERSION) {
    return null;
  }
  return latest;
};
