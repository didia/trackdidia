import type { PastorVerseResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { PASTOR_VERSE_PROMPT_VERSION, type PastorVerseService } from "./pastor-verse-service";

/** Latest cached `ok` verse for `date`, or `null` if none exists yet or it's on a stale schema. */
export const loadLatestPastorVerse = async (
  repository: AppRepository,
  service: PastorVerseService,
  date: string,
): Promise<PastorVerseResult | null> => {
  const latest = await repository.getLatestAiMessage("pastor_verse", `pastor:${date}`, "ok");
  if (!latest || latest.promptVersion !== PASTOR_VERSE_PROMPT_VERSION) {
    return null;
  }

  return service.resultFromMessage(repository, latest);
};

/** `createdAt` of the latest `fallback` row for `date`, used for the 60-minute retry cooldown. */
export const latestPastorFallbackAt = async (
  repository: AppRepository,
  date: string,
): Promise<string | null> => {
  const latest = await repository.getLatestAiMessage("pastor_verse", `pastor:${date}`, "fallback");
  return latest?.createdAt ?? null;
};
