import type { AiMessage, GoalPacingResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { GOAL_PACING_PROMPT_VERSION, type GoalPacingService } from "./goal-pacing-service";
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

  if (!latest?.bodyJson || latest.promptVersion !== GOAL_PACING_PROMPT_VERSION) {
    // `getLatestAiMessage` only filters by (surface, scope, status) — it has no idea whether the
    // row still matches the current prompt/schema. Reject a stale prompt version here so a v1
    // cached row is never rendered as-is; `runPacing` will regenerate it fresh.
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
