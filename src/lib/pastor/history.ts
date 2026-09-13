import type { AiMessage, CatalogVerse, PastorVerseIntent } from "../../domain/types";
import { parseStoredPastorBody } from "../ai/proposals/pastor-verse-validator";
import { addDays } from "../gtd/shared";
import { formatReferenceFr } from "./bible-books";

export interface PastorHistoryVerseEntry {
  date: string;
  verseId: string | null;
  label: string;
  intent: PastorVerseIntent;
  isOffList: boolean;
}

export interface PastorHistorySummary {
  /** Latest 30 (date, verse) shows, most recent first. */
  recentVerses: PastorHistoryVerseEntry[];
  blockedVerseIds: string[];
  offListAllowed: boolean;
  lastShownDateByVerseId: Map<string, string>;
  timesShown30ByVerseId: Map<string, number>;
}

const PASTOR_SCOPE_PREFIX = "pastor:";
const RECENT_VERSE_LIMIT = 30;
const OFF_LIST_COOLDOWN_DAYS = 6;
const BLOCK_WINDOW_CANDIDATES_DAYS = [7, 3, 0];
const MIN_ELIGIBLE_CATALOG_SIZE = 3;

const scopeKeyDate = (scopeKey: string): string | null =>
  scopeKey.startsWith(PASTOR_SCOPE_PREFIX) ? scopeKey.slice(PASTOR_SCOPE_PREFIX.length) : null;

/**
 * Derives blocking/recency data from prior `pastor_verse` messages (spec §7). Only `ok`/`fallback`
 * rows on the current prompt version and `pastor:`-prefixed scope keys count — this deliberately
 * excludes `coach_pulse` rows sharing the same day (see the scope-key regression test) and stale
 * schema versions from before a prompt revision.
 */
export const summarizePastorHistory = (
  messages: AiMessage[],
  catalog: CatalogVerse[],
  date: string,
  promptVersion: string,
): PastorHistorySummary => {
  const eligible = messages.filter(
    (message) =>
      (message.status === "ok" || message.status === "fallback") &&
      message.promptVersion === promptVersion &&
      Boolean(message.bodyJson),
  );

  const latestByKey = new Map<string, { entry: PastorHistoryVerseEntry; createdAt: string }>();

  for (const message of eligible) {
    const messageDate = scopeKeyDate(message.scopeKey);
    if (!messageDate || messageDate > date) {
      continue;
    }

    const body = parseStoredPastorBody(message.bodyJson);
    if (!body) {
      continue;
    }

    const label = body.reference ? formatReferenceFr(body.reference) : "";
    const isOffList = body.pick === "outside";
    const key = `${messageDate}::${body.verseId ?? `outside:${label}`}`;
    const existing = latestByKey.get(key);
    if (!existing || message.createdAt > existing.createdAt) {
      latestByKey.set(key, {
        entry: {
          date: messageDate,
          verseId: body.verseId,
          label,
          intent: body.intent,
          isOffList,
        },
        createdAt: message.createdAt,
      });
    }
  }

  const orderedEntries = [...latestByKey.values()]
    .sort((left, right) => {
      const byDate = right.entry.date.localeCompare(left.entry.date);
      return byDate !== 0 ? byDate : right.createdAt.localeCompare(left.createdAt);
    })
    .map((item) => item.entry);

  const recentVerses = orderedEntries.slice(0, RECENT_VERSE_LIMIT);

  const lastShownDateByVerseId = new Map<string, string>();
  const timesShown30ByVerseId = new Map<string, number>();
  for (const entry of recentVerses) {
    if (!entry.verseId) {
      continue;
    }
    if (!lastShownDateByVerseId.has(entry.verseId)) {
      lastShownDateByVerseId.set(entry.verseId, entry.date);
    }
    timesShown30ByVerseId.set(entry.verseId, (timesShown30ByVerseId.get(entry.verseId) ?? 0) + 1);
  }

  let blockedVerseIds: string[] = [];
  for (const windowDays of BLOCK_WINDOW_CANDIDATES_DAYS) {
    const cutoff = addDays(date, -windowDays);
    const blocked = new Set(
      orderedEntries
        .filter((entry) => entry.verseId && entry.date >= cutoff && entry.date <= date)
        .map((entry) => entry.verseId as string),
    );
    const remaining = catalog.length - blocked.size;

    if (windowDays === 0) {
      // Always block today's verses unless doing so would block the whole catalog.
      blockedVerseIds = remaining > 0 ? [...blocked] : [];
      break;
    }

    if (remaining >= MIN_ELIGIBLE_CATALOG_SIZE) {
      blockedVerseIds = [...blocked];
      break;
    }
  }

  const offListCutoff = addDays(date, -OFF_LIST_COOLDOWN_DAYS);
  const offListAllowed = !orderedEntries.some(
    (entry) => entry.isOffList && entry.date >= offListCutoff && entry.date <= date,
  );

  return {
    recentVerses,
    blockedVerseIds,
    offListAllowed,
    lastShownDateByVerseId,
    timesShown30ByVerseId,
  };
};
