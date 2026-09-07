import type { AiMessage, GoalPacingResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import type { GoalPacingService } from "./goal-pacing-service";
import { parseGoalPacingJson } from "./proposals/goal-pacing-validator";

const sourceFromMessage = (message: AiMessage): GoalPacingResult["source"] => {
  if (message.status === "ok") {
    return "ai";
  }

  if (message.status === "fallback") {
    return "fallback";
  }

  return "local";
};

export const loadLatestGoalPacing = async (
  repository: AppRepository,
  pacingService: GoalPacingService,
  year: number,
): Promise<GoalPacingResult | null> => {
  const latest = await repository.getLatestAiMessage("goal_pacing", String(year), "ok");

  if (!latest?.bodyJson) {
    return null;
  }

  const fromService = await pacingService.resultFromMessage(repository, latest);
  if (fromService) {
    return fromService;
  }

  const parsed = parseGoalPacingJson(latest.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  return {
    message: latest,
    pacing: parsed.value,
    source: sourceFromMessage(latest),
  };
};
