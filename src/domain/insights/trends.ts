import { resolveMetricValue } from "../daily-entry";
import { metricDefinitions } from "../definitions";
import type { DailyEntry, MetricKey } from "../types";
import { TREND_LONG_WINDOW_DAYS, TREND_SHORT_WINDOW_DAYS } from "./constants";
import { average, entriesInTrailingWindow, latestEntryDate, sortEntriesByDate, trailingEvidenceWindow } from "./shared";
import type { Finding } from "./types";

export type TrendDirection = "up" | "down" | "flat";

const resolveDirection = (delta: number, baseline: number): TrendDirection => {
  const epsilon = Math.max(0.001, Math.abs(baseline) * 0.02);
  if (delta > epsilon) {
    return "up";
  }
  if (delta < -epsilon) {
    return "down";
  }
  return "flat";
};

export interface MetricTrendFinding extends Finding {
  metricKey: MetricKey;
  average7d: number;
  average28d: number;
  /** Number of observations backing `average7d`. `0` means the trailing 7-day window has no data — `direction` is forced to `"flat"` and `delta` to `0` in that case, since there is nothing to compare against the 28-day average. */
  shortSampleSize: number;
  delta: number;
  direction: TrendDirection;
}

/**
 * Per-metric 7-day and 28-day trailing averages, their delta and direction
 * (spec `ai-integration-v2.md` §3). `referenceDate` defaults to the most recent entry's date.
 */
export const computeMetricTrendFindings = (entries: DailyEntry[], referenceDate?: string): MetricTrendFinding[] => {
  const ordered = sortEntriesByDate(entries);
  const reference = referenceDate ?? latestEntryDate(ordered);

  if (!reference) {
    return [];
  }

  const upToReference = ordered.filter((entry) => entry.date <= reference);
  const shortWindow = entriesInTrailingWindow(upToReference, reference, TREND_SHORT_WINDOW_DAYS);
  const longWindow = entriesInTrailingWindow(upToReference, reference, TREND_LONG_WINDOW_DAYS);
  const evidenceWindow = trailingEvidenceWindow(reference, TREND_LONG_WINDOW_DAYS);

  return metricDefinitions.map(({ key }) => {
    const shortValues = shortWindow
      .map((entry) => resolveMetricValue(entry, key))
      .filter((value): value is number => value !== null);
    const longValues = longWindow
      .map((entry) => resolveMetricValue(entry, key))
      .filter((value): value is number => value !== null);

    const shortSampleSize = shortValues.length;
    const average7d = average(shortValues);
    const average28d = average(longValues);
    // With no observations in the trailing 7-day window, `average7d` is a meaningless 0 (not
    // "the metric collapsed to zero"), so the comparison against the 28-day average is suppressed
    // rather than reported as a `"down"` trend.
    const delta = shortSampleSize > 0 ? average7d - average28d : 0;
    const direction = shortSampleSize > 0 ? resolveDirection(delta, average28d) : "flat";

    return {
      id: `trend:${key}:${reference}`,
      severity: "info",
      evidenceWindow,
      sampleSize: longValues.length,
      value: average7d,
      label:
        shortSampleSize > 0
          ? `Moyenne 7j de ${key}: ${average7d.toFixed(1)} (moyenne 28j: ${average28d.toFixed(1)}, tendance ${direction}).`
          : `Pas de donnee pour ${key} sur les 7 derniers jours (moyenne 28j: ${average28d.toFixed(1)}).`,
      metricKey: key,
      average7d,
      average28d,
      shortSampleSize,
      delta,
      direction
    };
  });
};

export interface WeeklyScoreTrendPoint {
  weekStartDate: string;
  weeklyScore: number;
}

export interface WeeklyScoreTrendFinding extends Finding {
  latestWeekStartDate: string;
  latestScore: number;
  baselineAverage: number;
  delta: number;
  direction: TrendDirection;
}

/**
 * Weekly-score trajectory (spec `ai-integration-v2.md` §3): the most recent weekly score
 * versus the average of prior weeks. `points` must be ordered oldest to newest.
 */
export const computeWeeklyScoreTrend = (points: WeeklyScoreTrendPoint[]): WeeklyScoreTrendFinding | null => {
  if (points.length < 2) {
    return null;
  }

  const ordered = [...points].sort((left, right) => left.weekStartDate.localeCompare(right.weekStartDate));
  const latest = ordered[ordered.length - 1];
  const priorWeeks = ordered.slice(0, -1);
  const baselineAverage = average(priorWeeks.map((point) => point.weeklyScore));
  const delta = latest.weeklyScore - baselineAverage;
  const direction = resolveDirection(delta, baselineAverage);

  return {
    id: `trend:weekly_score:${latest.weekStartDate}`,
    severity: "info",
    evidenceWindow: {
      from: ordered[0].weekStartDate,
      to: latest.weekStartDate,
      days: ordered.length * 7
    },
    sampleSize: priorWeeks.length,
    value: latest.weeklyScore,
    label: `Score hebdomadaire de la derniere semaine: ${latest.weeklyScore.toFixed(1)} (moyenne des semaines precedentes: ${baselineAverage.toFixed(1)}, tendance ${direction}).`,
    latestWeekStartDate: latest.weekStartDate,
    latestScore: latest.weeklyScore,
    baselineAverage,
    delta,
    direction
  };
};
