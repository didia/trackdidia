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
  const scopeKey = String(year);
  const messages = await repository.listAiMessages("goal_pacing", 20);
  const latest = messages
    .filter((message) => message.scopeKey === scopeKey && message.bodyJson)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (!latest) {
    return null;
  }

  const fromService = await pacingService.resultFromMessage(repository, latest);
  if (fromService) {
    return fromService;
  }

  if (!latest.bodyJson) {
    return null;
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
