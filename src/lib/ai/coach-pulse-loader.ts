import type { AiMessage, CoachPulseResult, DailyEntry } from "../../domain/types";
import { nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import type { CoachPulseService } from "./coach-pulse-service";
import { resolveDueCommitmentsOnClose } from "./memory/lifecycle";

const latestPulseMessage = (
  messages: AiMessage[],
  predicate: (message: AiMessage) => boolean
): AiMessage | null => {
  const matches = messages
    .filter((message) => Boolean(message.bodyJson) && predicate(message))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return matches[0] ?? null;
};

/** Latest scheduled pulse message for a day (excludes evening `close`). */
export const latestScheduledPulseMessage = (messages: AiMessage[]): AiMessage | null =>
  latestPulseMessage(messages, (message) => Boolean(message.stance && message.stance !== "close"));

/** Latest evening `close` pulse for a day. */
export const latestClosePulseMessage = (messages: AiMessage[]): AiMessage | null =>
  latestPulseMessage(messages, (message) => message.stance === "close");

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

export const loadLatestClosePulseForDate = async (
  repository: AppRepository,
  coachService: CoachPulseService,
  date: string,
  entry: DailyEntry
): Promise<CoachPulseResult | null> => {
  const messages = await repository.listAiMessagesForDate(date);
  const latest = latestClosePulseMessage(messages);

  if (!latest) {
    return null;
  }

  const result = await coachService.resultFromMessage(repository, latest);
  if (!result) {
    return null;
  }

  await resolveDueCommitmentsOnClose(repository, date, entry, nowIso());
  return result;
};
