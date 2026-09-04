import type { AiMessage, WeeklySynthesisResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { parseWeeklySynthesisJson } from "./proposals/weekly-synthesis-validator";
import type { WeeklySynthesisService } from "./weekly-synthesis-service";

const sourceFromMessage = (message: AiMessage): WeeklySynthesisResult["source"] => {
  if (message.status === "ok") {
    return "ai";
  }

  if (message.status === "fallback") {
    return "fallback";
  }

  return "local";
};

export const loadLatestWeeklySynthesis = async (
  repository: AppRepository,
  synthesisService: WeeklySynthesisService,
  weekStartDate: string,
): Promise<WeeklySynthesisResult | null> => {
  const messages = await repository.listAiMessages("weekly_synthesis", 20);
  const latest = messages
    .filter((message) => message.scopeKey === weekStartDate && message.bodyJson)
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

  const parsed = parseWeeklySynthesisJson(latest.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  const proposals = await repository.listAiProposals(latest.id);
  return {
    message: latest,
    synthesis: parsed.value,
    proposals,
    source: sourceFromMessage(latest),
  };
};
