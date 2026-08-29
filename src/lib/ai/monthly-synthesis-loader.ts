import type { AiMessage, MonthlySynthesisResult } from "../../domain/types";
import { parseMonthlySynthesisJson } from "./proposals/monthly-synthesis-validator";
import type { AppRepository } from "../storage/repository";
import type { MonthlySynthesisService } from "./monthly-synthesis-service";

const sourceFromMessage = (message: AiMessage): MonthlySynthesisResult["source"] => {
  if (message.status === "ok") {
    return "ai";
  }

  if (message.status === "fallback") {
    return "fallback";
  }

  return "local";
};

export const loadLatestMonthlySynthesis = async (
  repository: AppRepository,
  synthesisService: MonthlySynthesisService,
  monthKey: string
): Promise<MonthlySynthesisResult | null> => {
  const messages = await repository.listAiMessages("monthly_synthesis", 20);
  const latest = messages
    .filter((message) => message.scopeKey === monthKey && message.bodyJson)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (!latest) {
    return null;
  }

  const fromService = await synthesisService.resultFromMessage(repository, latest);
  if (fromService) {
    return fromService;
  }

  if (!latest.bodyJson) {
    return null;
  }

  const parsed = parseMonthlySynthesisJson(latest.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  const proposals = await repository.listAiProposals(latest.id);
  return {
    message: latest,
    synthesis: parsed.value,
    proposals,
    source: sourceFromMessage(latest)
  };
};
