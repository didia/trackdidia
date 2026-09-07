import type { AiMessage, MonthlySynthesisResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import type { MonthlySynthesisService } from "./monthly-synthesis-service";
import { parseMonthlySynthesisJson } from "./proposals/monthly-synthesis-validator";

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
  monthKey: string,
): Promise<MonthlySynthesisResult | null> => {
  const latest = await repository.getLatestAiMessage("monthly_synthesis", monthKey, "ok");

  if (!latest?.bodyJson) {
    return null;
  }

  const fromService = await synthesisService.resultFromMessage(repository, latest);
  if (fromService) {
    return fromService;
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
    source: sourceFromMessage(latest),
  };
};
