import { addDays, getWeekStartSunday } from "../lib/gtd/shared";
import type {
  DailyEntry,
  MonthlyReview,
  MonthlyReviewSectionKey,
  WeeklyReview,
  WeeklyRitualSectionKey,
} from "./types";
import {
  getMonthEndDate,
  getMonthKey,
  getMonthStartDate,
  getPreviousMonthKey,
} from "./monthly-review";

export type JournalKind = "daily" | "weekly" | "monthly";
export type JournalKindFilter = "all" | JournalKind;
export type JournalPeriodPreset = "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth" | "custom";
export type JournalSortOrder = "olderFirst" | "newerFirst";

export interface JournalDateRange {
  startDate: string;
  endDate: string;
}

export interface JournalFeedField {
  key: string;
  text: string;
}

export interface JournalFeedItem {
  kind: JournalKind;
  id: string;
  sortDate: string;
  periodStartDate: string;
  periodEndDate: string;
  href: string;
  fields: JournalFeedField[];
}

export interface BuildJournalFeedInput {
  dailyEntries: DailyEntry[];
  weeklyReviews: WeeklyReview[];
  monthlyReviews: MonthlyReview[];
  range: JournalDateRange;
  kind: JournalKindFilter;
  sort: JournalSortOrder;
}

export const dailyJournalFieldKeys = [
  "morningIntention",
  "nightReflection",
  "tomorrowFocus",
] as const;

export const weeklyJournalFieldKeys: WeeklyRitualSectionKey[] = [
  "bilan",
  "budget",
  "tempsEtPlan",
  "collecte",
  "calendrier",
  "gtd",
  "alignement",
  "dimanche",
];

export const monthlyJournalFieldKeys: MonthlyReviewSectionKey[] = [
  "bilan",
  "journaux",
  "finances",
  "temps",
  "progressionObjectifs",
  "missionObjectifs",
  "nettoyageListes",
  "calendrier",
  "grosProjets",
  "developpement",
];

const kindRank: Record<JournalKind, number> = {
  daily: 0,
  weekly: 1,
  monthly: 2,
};

const isLocalDate = (value: string | undefined): value is string =>
  Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));

export const isCompleteJournalCustomRange = (custom?: {
  startDate: string;
  endDate: string;
}): custom is { startDate: string; endDate: string } =>
  isLocalDate(custom?.startDate) && isLocalDate(custom?.endDate);

const hasJournalText = (value: string): boolean => value.trim().length > 0;

const collectNoteFields = (
  notes: Record<string, string>,
  keys: readonly string[],
): JournalFeedField[] =>
  keys.flatMap((key) => {
    const text = notes[key] ?? "";
    return hasJournalText(text) ? [{ key, text }] : [];
  });

export const journalPeriodOverlaps = (
  periodStart: string,
  periodEnd: string,
  rangeStart: string,
  rangeEnd: string,
): boolean => periodStart <= rangeEnd && periodEnd >= rangeStart;

const thisWeekRange = (today: string): JournalDateRange => {
  const startDate = getWeekStartSunday(today);
  return { startDate, endDate: addDays(startDate, 6) };
};

export const resolveJournalDateRange = (
  preset: JournalPeriodPreset,
  today: string,
  custom?: { startDate: string; endDate: string },
): JournalDateRange => {
  if (preset === "thisWeek") {
    return thisWeekRange(today);
  }

  if (preset === "lastWeek") {
    const thisWeekStart = getWeekStartSunday(today);
    const startDate = addDays(thisWeekStart, -7);
    return { startDate, endDate: addDays(startDate, 6) };
  }

  if (preset === "thisMonth") {
    const monthKey = getMonthKey(today);
    return { startDate: getMonthStartDate(monthKey), endDate: getMonthEndDate(monthKey) };
  }

  if (preset === "lastMonth") {
    const monthKey = getPreviousMonthKey(today);
    return { startDate: getMonthStartDate(monthKey), endDate: getMonthEndDate(monthKey) };
  }

  if (!isCompleteJournalCustomRange(custom)) {
    return thisWeekRange(today);
  }

  const startDate = custom.startDate <= custom.endDate ? custom.startDate : custom.endDate;
  const endDate = custom.startDate <= custom.endDate ? custom.endDate : custom.startDate;
  return { startDate, endDate };
};

const toDailyItem = (entry: DailyEntry): JournalFeedItem | null => {
  const fields = collectNoteFields(
    {
      morningIntention: entry.morningIntention,
      nightReflection: entry.nightReflection,
      tomorrowFocus: entry.tomorrowFocus,
    },
    dailyJournalFieldKeys,
  );
  if (fields.length === 0) {
    return null;
  }

  return {
    kind: "daily",
    id: entry.date,
    sortDate: entry.date,
    periodStartDate: entry.date,
    periodEndDate: entry.date,
    href: `/historique?date=${entry.date}`,
    fields,
  };
};

const toWeeklyItem = (review: WeeklyReview): JournalFeedItem | null => {
  const fields = collectNoteFields(review.notes, weeklyJournalFieldKeys);
  if (fields.length === 0) {
    return null;
  }

  return {
    kind: "weekly",
    id: review.weekStartDate,
    sortDate: review.weekStartDate,
    periodStartDate: review.weekStartDate,
    periodEndDate: review.weekEndDate,
    href: `/semaine?date=${review.weekStartDate}`,
    fields,
  };
};

const toMonthlyItem = (review: MonthlyReview): JournalFeedItem | null => {
  const fields = collectNoteFields(review.notes, monthlyJournalFieldKeys);
  if (fields.length === 0) {
    return null;
  }

  return {
    kind: "monthly",
    id: review.monthKey,
    sortDate: review.monthStartDate,
    periodStartDate: review.monthStartDate,
    periodEndDate: review.monthEndDate,
    href: `/mois?month=${review.monthKey}`,
    fields,
  };
};

const compareFeedItems = (left: JournalFeedItem, right: JournalFeedItem): number => {
  const byDate = left.sortDate.localeCompare(right.sortDate);
  if (byDate !== 0) {
    return byDate;
  }

  return kindRank[left.kind] - kindRank[right.kind];
};

export const buildJournalFeed = (input: BuildJournalFeedInput): JournalFeedItem[] => {
  const includeDaily = input.kind === "all" || input.kind === "daily";
  const includeWeekly = input.kind === "all" || input.kind === "weekly";
  const includeMonthly = input.kind === "all" || input.kind === "monthly";
  const { startDate, endDate } = input.range;

  const items: JournalFeedItem[] = [];

  if (includeDaily) {
    for (const entry of input.dailyEntries) {
      if (entry.date < startDate || entry.date > endDate) {
        continue;
      }
      const item = toDailyItem(entry);
      if (item) {
        items.push(item);
      }
    }
  }

  if (includeWeekly) {
    for (const review of input.weeklyReviews) {
      if (!journalPeriodOverlaps(review.weekStartDate, review.weekEndDate, startDate, endDate)) {
        continue;
      }
      const item = toWeeklyItem(review);
      if (item) {
        items.push(item);
      }
    }
  }

  if (includeMonthly) {
    for (const review of input.monthlyReviews) {
      if (!journalPeriodOverlaps(review.monthStartDate, review.monthEndDate, startDate, endDate)) {
        continue;
      }
      const item = toMonthlyItem(review);
      if (item) {
        items.push(item);
      }
    }
  }

  items.sort(compareFeedItems);
  return input.sort === "newerFirst" ? items.reverse() : items;
};
