import type { MonthlySynthesisResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { loadLatestSurfaceResult } from "./latest-surface-result-loader";
import {
  MONTHLY_SYNTHESIS_PROMPT_VERSION,
  type MonthlySynthesisService,
} from "./monthly-synthesis-service";

export const loadLatestMonthlySynthesis = async (
  repository: AppRepository,
  synthesisService: MonthlySynthesisService,
  monthKey: string,
): Promise<MonthlySynthesisResult | null> =>
  loadLatestSurfaceResult(
    repository,
    {
      surface: "monthly_synthesis",
      scopeKey: monthKey,
      promptVersion: MONTHLY_SYNTHESIS_PROMPT_VERSION,
    },
    (message) => synthesisService.resultFromMessage(repository, message),
  );
