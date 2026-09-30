import { dailyJournalFieldKeys } from "../../../domain/journal-feed";
import {
  type MidWeekReviewSummary,
  type MidWeekSignal,
  rankMidWeekSignals,
} from "../../../domain/mid-week-review";
import type { AiPayloadScope, DailyEntry } from "../../../domain/types";
import { t } from "../../../i18n";
import { addDays } from "../../gtd/shared";
import type { Surface } from "./types";

const NOTE_CHAR_CAP = 1_200;
const DECISIONS_CHAR_CAP = 2_000;

export interface MidWeekSnapshotDay {
  date: string;
  notes: { key: string; text: string }[];
}

export interface MidWeekSnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  weekStartDate: string;
  asOfDate: string;
  completedDays: number;
  remainingDays: number;
  paceScore: number | null;
  /** Ranked `lagging` and `at_risk` signal keys: the only keys an action may reference. */
  actionableKeys: string[];
  signals: MidWeekSignal[];
  /** Present only at `full` scope: non-empty journal fields of completed days. */
  journal?: MidWeekSnapshotDay[];
  /** Present only at `full` scope: the owner's saved mid-week decisions text. */
  decisions?: string;
}

export interface MidWeekSnapshotInputs {
  summary: MidWeekReviewSummary;
  weekEntries: DailyEntry[];
  /** Saved decisions text for the week, or `null` when none. */
  decisions: string | null;
}

/**
 * The single place where mid-week payload redaction happens.
 * - Goal and objective titles (user-authored) need `includeStructure`; below it the label falls
 *   back to the category name. Metric, principle, habit, task and journal labels are fixed
 *   enum names and always safe.
 * - Journal text and decisions need `full`.
 */
export const buildMidWeekSnapshot = (
  inputs: MidWeekSnapshotInputs,
  scope: AiPayloadScope,
): MidWeekSnapshot => {
  const includeStructure = scope === "metrics_and_structure" || scope === "full";
  const includeFreeText = scope === "full";
  const { summary } = inputs;
  const { window } = summary;

  const signals = summary.signals.map((signal): MidWeekSignal => {
    const userTitled = signal.category === "rescuetime" || signal.category === "objective";
    return userTitled && !includeStructure
      ? { ...signal, label: t(`midWeek.category.${signal.category}`, { ns: "reviews" }) }
      : signal;
  });

  const snapshot: MidWeekSnapshot = {
    surface: "midweek",
    scope,
    weekStartDate: window.weekStartDate,
    asOfDate: window.asOfDate,
    completedDays: window.completedDays,
    remainingDays: window.remainingDays,
    paceScore: summary.paceScore,
    actionableKeys: rankMidWeekSignals(
      signals.filter((signal) => signal.status === "lagging" || signal.status === "at_risk"),
    ).map((signal) => signal.key),
    signals,
  };

  if (includeFreeText) {
    const completedDates = new Set(
      Array.from({ length: window.completedDays }, (_, index) =>
        addDays(window.weekStartDate, index),
      ),
    );
    snapshot.journal = inputs.weekEntries
      .filter((entry) => completedDates.has(entry.date))
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((entry) => ({
        date: entry.date,
        notes: dailyJournalFieldKeys.flatMap((key) => {
          const raw = entry[key]?.trim() ?? "";
          return raw ? [{ key, text: raw.slice(0, NOTE_CHAR_CAP) }] : [];
        }),
      }))
      .filter((day) => day.notes.length > 0);
    const decisions = inputs.decisions?.trim() ?? "";
    if (decisions) {
      snapshot.decisions = decisions.slice(0, DECISIONS_CHAR_CAP);
    }
  }

  return snapshot;
};
