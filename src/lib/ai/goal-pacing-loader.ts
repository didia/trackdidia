import type { GoalPacingResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { GOAL_PACING_PROMPT_VERSION, type GoalPacingService } from "./goal-pacing-service";
import { loadLatestSurfaceResult } from "./latest-surface-result-loader";

export const loadLatestGoalPacing = async (
  repository: AppRepository,
  pacingService: GoalPacingService,
  year: number,
): Promise<GoalPacingResult | null> =>
  loadLatestSurfaceResult(
    repository,
    {
      surface: "goal_pacing",
      scopeKey: String(year),
      promptVersion: GOAL_PACING_PROMPT_VERSION,
    },
    (message) => pacingService.resultFromMessage(repository, message),
  );
