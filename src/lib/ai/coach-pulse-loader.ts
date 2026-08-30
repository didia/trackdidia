import type { AiMessage, CoachPulseResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import type { CoachPulseService } from "./coach-pulse-service";

const sourceFromMessage = (message: AiMessage): CoachPulseResult["source"] => {
  if (message.status === "ok") {
    return "ai";
  }

  if (message.status === "fallback") {
    return "fallback";
  }

  return "local";
};

/** Latest scheduled pulse message for a day (excludes evening `close`). */
export const latestScheduledPulseMessage = (messages: AiMessage[]): AiMessage | null => {
  const scheduled = messages
    .filter((message) => message.stance && message.stance !== "close" && message.bodyJson)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return scheduled[0] ?? null;
};

export const loadLatestCoachPulseForDate = async (
  repository: AppRepository,
  coachService: CoachPulseService,
  date: string
): Promise<CoachPulseResult | null> => {
  const messages = await repository.listAiMessagesForDate(date);
  const latest = latestScheduledPulseMessage(messages);

  if (!latest) {
    return null;
  }

  return coachService.resultFromMessage(repository, latest);
};
