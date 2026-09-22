import type { WeeklySynthesisResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { loadLatestSurfaceResult } from "./latest-surface-result-loader";
import {
  WEEKLY_SYNTHESIS_PROMPT_VERSION,
  type WeeklySynthesisService,
} from "./weekly-synthesis-service";

export const loadLatestWeeklySynthesis = async (
  repository: AppRepository,
  synthesisService: WeeklySynthesisService,
  weekStartDate: string,
): Promise<WeeklySynthesisResult | null> =>
  loadLatestSurfaceResult(
    repository,
    {
      surface: "weekly_synthesis",
      scopeKey: weekStartDate,
      promptVersion: WEEKLY_SYNTHESIS_PROMPT_VERSION,
    },
    (message) => synthesisService.resultFromMessage(repository, message),
  );
