import type { AppRepository } from "../../storage/repository";
import { buildCoachAnalyticsSummary, joinProposalsWithMessages } from "./proposal-analytics";

const ANALYTICS_HISTORY_SINCE = "2020-01-01T00:00:00.000Z";

export const loadCoachAnalytics = async (
  repository: AppRepository,
  referenceDate = new Date(),
): Promise<ReturnType<typeof buildCoachAnalyticsSummary>> => {
  const [proposals, messages] = await Promise.all([
    repository.listAiProposalsSince(ANALYTICS_HISTORY_SINCE),
    repository.listAiMessagesSince(ANALYTICS_HISTORY_SINCE),
  ]);

  return buildCoachAnalyticsSummary(joinProposalsWithMessages(proposals, messages), referenceDate);
};
