import type { MidWeekSteeringResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { loadLatestSurfaceResult } from "./latest-surface-result-loader";
import {
  MID_WEEK_STEERING_PROMPT_VERSION,
  type MidWeekSteeringService,
} from "./mid-week-steering-service";

/** Hydrates the latest stored steering for the week; `result.steering.asOfDate` dates it. */
export const loadLatestMidWeekSteering = async (
  repository: AppRepository,
  steeringService: MidWeekSteeringService,
  weekStartDate: string,
): Promise<MidWeekSteeringResult | null> =>
  loadLatestSurfaceResult(
    repository,
    {
      surface: "mid_week_steering",
      scopeKey: weekStartDate,
      promptVersion: MID_WEEK_STEERING_PROMPT_VERSION,
    },
    (message) => steeringService.resultFromMessage(repository, message),
  );
