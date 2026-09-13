import { dailyJournalFieldKeys } from "../../../domain/journal-feed";
import type {
  AiPayloadScope,
  CatalogVerse,
  DailyStatus,
  PrincipleChecks,
} from "../../../domain/types";
import { addDays } from "../../gtd/shared";
import { formatReferenceFr } from "../../pastor/bible-books";
import { type PastorHistorySummary, summarizePastorHistory } from "../../pastor/history";
import { computePrincipleSignals, type PrincipleSignals } from "../../pastor/signals";
import { loadVerseCatalog } from "../../pastor/verse-catalog";
import type { AppRepository } from "../../storage/repository";
import type { Surface } from "./types";

/** 7 prior days + the target day, matching the plan's journal-window decision. */
const HISTORY_LOOKBACK_DAYS = 7;
const HISTORY_MESSAGE_LIMIT = 120;
const NOTE_CHAR_CAP = 1_200;

export interface PastorSnapshotDayNote {
  key: string;
  text: string;
}

export interface PastorSnapshotDay {
  date: string;
  status: DailyStatus;
  principleChecks: PrincipleChecks;
  /** Non-empty `dailyJournalFieldKeys` notes only, trimmed and capped at 1,200 characters. */
  notes: PastorSnapshotDayNote[];
}

export interface PastorSnapshotCatalogEntry {
  id: string;
  label: string;
  principleKeys: string[];
  themes: string[];
  lastShownDate: string | null;
  timesShown30: number;
}

export interface PastorSnapshotRecentVerse {
  date: string;
  label: string;
  intent: string;
}

export interface PastorSnapshotDayView {
  date: string;
  status: DailyStatus;
  principleChecks: PrincipleChecks;
  /** Present only at `full` scope. */
  notes?: PastorSnapshotDayNote[];
}

export interface PastorSnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  date: string;
  days: PastorSnapshotDayView[];
  principleSignals: PrincipleSignals;
  /** Compact catalog view — never includes `note` or verse text. */
  catalog: PastorSnapshotCatalogEntry[];
  recentVerses: PastorSnapshotRecentVerse[];
  blockedVerseIds: string[];
  offListAllowed: boolean;
}

export interface PastorSnapshotInputs {
  date: string;
  days: PastorSnapshotDay[];
  catalog: CatalogVerse[];
  history: PastorHistorySummary;
}

/**
 * Shared by `PastorVerseService` and the Settings payload preview. `promptVersion` is passed in
 * (rather than imported from `pastor-verse-service.ts`) to avoid a circular import between the
 * service and this snapshot module.
 */
export const resolvePastorSnapshotInputs = async (
  repository: AppRepository,
  date: string,
  promptVersion: string,
): Promise<PastorSnapshotInputs> => {
  const startDate = addDays(date, -HISTORY_LOOKBACK_DAYS);
  const [entries, messages] = await Promise.all([
    repository.listDailyEntriesInRange(startDate, date),
    repository.listAiMessages("pastor_verse", HISTORY_MESSAGE_LIMIT),
  ]);
  const catalog = loadVerseCatalog();

  const days: PastorSnapshotDay[] = entries
    .filter((entry) => entry.date >= startDate && entry.date <= date)
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((entry) => ({
      date: entry.date,
      status: entry.status,
      principleChecks: entry.principleChecks,
      notes: dailyJournalFieldKeys.flatMap((key) => {
        const raw = entry[key]?.trim() ?? "";
        return raw ? [{ key, text: raw.slice(0, NOTE_CHAR_CAP) }] : [];
      }),
    }));

  const history = summarizePastorHistory(messages, catalog, date, promptVersion);

  return { date, days, catalog, history };
};

const buildCatalogEntries = (
  catalog: CatalogVerse[],
  history: PastorHistorySummary,
): PastorSnapshotCatalogEntry[] =>
  catalog.map((verse) => ({
    id: verse.id,
    label: formatReferenceFr(verse.reference),
    principleKeys: verse.principleKeys,
    themes: verse.themes ?? [],
    lastShownDate: history.lastShownDateByVerseId.get(verse.id) ?? null,
    timesShown30: history.timesShown30ByVerseId.get(verse.id) ?? 0,
  }));

/**
 * Pure, single redaction point (spec §6): `full` scope includes journal notes, while `metrics`
 * and `metrics_and_structure` strip all free text but keep principle signals and history.
 */
export const buildPastorSnapshot = (
  inputs: PastorSnapshotInputs,
  scope: AiPayloadScope,
): PastorSnapshot => {
  const includeNotes = scope === "full";

  return {
    surface: "pastor",
    scope,
    date: inputs.date,
    days: inputs.days.map((day) => ({
      date: day.date,
      status: day.status,
      principleChecks: day.principleChecks,
      ...(includeNotes ? { notes: day.notes } : {}),
    })),
    principleSignals: computePrincipleSignals(inputs.days, inputs.date),
    catalog: buildCatalogEntries(inputs.catalog, inputs.history),
    recentVerses: inputs.history.recentVerses.map((entry) => ({
      date: entry.date,
      label: entry.label,
      intent: entry.intent,
    })),
    blockedVerseIds: inputs.history.blockedVerseIds,
    offListAllowed: inputs.history.offListAllowed,
  };
};
