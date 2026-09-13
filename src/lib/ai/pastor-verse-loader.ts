import type { PastorVerseResult } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { PASTOR_VERSE_PROMPT_VERSION, type PastorVerseService } from "./pastor-verse-service";

/**
 * Latest cached verse for `date`, or `null` if none exists yet or it's on a stale schema. An
 * `ok` row (a real AI result) always wins regardless of recency — mirroring the rest of the coach
 * surfaces, a later `fallback` row must never hide an earlier success. A `local` row (no AI
 * configured — see `PastorVerseService.buildVerse`) is used only when there is no `ok` row yet,
 * so the offline/no-AI case still reuses today's pick instead of regenerating (and re-persisting)
 * on every mount.
 */
export const loadLatestPastorVerse = async (
  repository: AppRepository,
  service: PastorVerseService,
  date: string,
): Promise<PastorVerseResult | null> => {
  const scopeKey = `pastor:${date}`;
  const [ok, local] = await Promise.all([
    repository.getLatestAiMessage("pastor_verse", scopeKey, "ok"),
    repository.getLatestAiMessage("pastor_verse", scopeKey, "local"),
  ]);
  const latest = ok ?? local;
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
