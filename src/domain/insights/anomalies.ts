import { getWeekStartSunday } from "../../lib/gtd/shared";
import { t } from "../../i18n";
import { resolveMetricValue } from "../daily-entry";
import { metricDefinitions, principleDefinitions } from "../definitions";
import type { DailyEntry, MetricKey } from "../types";
import { MIN_SAMPLE_DAYS } from "./constants";
import { average, buildEvidenceWindow, latestEntryDate, sortEntriesByDate } from "./shared";
import type { Finding } from "./types";

export type AnomalySubject = MetricKey | "discipline";
export type AnomalyScope = "today" | "week";

export interface AnomalyFinding extends Finding {
  subject: AnomalySubject;
  scope: AnomalyScope;
  currentValue: number;
  baselineMean: number;
  delta: number;
}

/**
 * Discipline score for one day, computed over only the principles that have actually been
 * answered (`true` or `false`) rather than over every principle (contrast with the
 * all-principles denominator `computeDisciplineScore` uses elsewhere, e.g. for the day's
 * completion percentage). An in-progress day — say, this morning, with only the
 * morning/anytime principles logged so far — otherwise looks identical to a day where every
 * still-unanswered principle was explicitly failed, and a partially-answered day is then
 * structurally guaranteed to look like a collapse next to a baseline of fully-answered days,
 * no matter how the "is this day far enough along" threshold is set. Scoring over the
 * answered subset means a perfect partial day still scores `1.00`, and a day with nothing
 * answered yet naturally drops out (`null`, filtered by callers) instead of scoring `0`.
 */
const computeAnsweredDisciplineScore = (entry: DailyEntry): number | null => {
  const answered = principleDefinitions.filter(({ key }) => entry.principleChecks[key] !== null);
  if (answered.length === 0) {
    return null;
  }

  const trueCount = answered.filter(({ key }) => entry.principleChecks[key] === true).length;
  return trueCount / answered.length;
};

const resolveSubjectValue = (entry: DailyEntry, subject: AnomalySubject): number | null =>
  subject === "discipline" ? computeAnsweredDisciplineScore(entry) : resolveMetricValue(entry, subject);

const anomalySeverity = (delta: number, baselineMean: number): AnomalyFinding["severity"] => {
  const denominator = Math.abs(baselineMean) > 0.0001 ? Math.abs(baselineMean) : 1;
  const ratio = delta / denominator;

  if (ratio <= -0.25) {
    return "watch";
  }
  if (ratio >= 0.25) {
    return "positive";
  }
  return "info";
};

const buildFinding = (
  subject: AnomalySubject,
  scope: AnomalyScope,
  referenceDate: string,
  currentValue: number,
  baselineValues: number[],
  baselineFrom: string
): AnomalyFinding | null => {
  if (baselineValues.length < MIN_SAMPLE_DAYS) {
    return null;
  }

  const baselineMean = average(baselineValues);
  const delta = currentValue - baselineMean;

  return {
    id: `anomaly:${scope}:${subject}:${referenceDate}`,
    severity: anomalySeverity(delta, baselineMean),
    evidenceWindow: buildEvidenceWindow(baselineFrom, referenceDate),
    sampleSize: baselineValues.length,
    value: currentValue,
    label: t(scope === "today" ? "anomalyToday" : "anomalyWeek", {
      ns: "insights",
      subject: subject === "discipline" ? t("subjectDiscipline", { ns: "insights" }) : t(`${subject}.label`, { ns: "metrics" }),
      value: currentValue.toFixed(2),
      mean: baselineMean.toFixed(2),
      count: baselineValues.length
    }),
    subject,
    scope,
    currentValue,
    baselineMean,
    delta
  };
};

/**
 * Today and this-week values versus a personal baseline, gated by a minimum sample floor
 * (spec `ai-integration-v2.md` §3). Below `MIN_SAMPLE_DAYS` of baseline evidence, the
 * comparison is omitted rather than reported with low confidence.
 */
export const computeAnomalyFindings = (entries: DailyEntry[], referenceDate?: string): AnomalyFinding[] => {
  const ordered = sortEntriesByDate(entries);
  const reference = referenceDate ?? latestEntryDate(ordered);

  if (!reference) {
    return [];
  }

  const subjects: AnomalySubject[] = ["discipline", ...metricDefinitions.map(({ key }) => key)];
  const findings: AnomalyFinding[] = [];

  const todayEntry = ordered.find((entry) => entry.date === reference);
  const beforeToday = ordered.filter((entry) => entry.date < reference);

  const weekStart = getWeekStartSunday(reference);
  const currentWeekEntries = ordered.filter((entry) => entry.date >= weekStart && entry.date <= reference);
  const beforeWeek = ordered.filter((entry) => entry.date < weekStart);

  for (const subject of subjects) {
    if (todayEntry) {
      const currentValue = resolveSubjectValue(todayEntry, subject);
      const baselineValues = beforeToday
        .map((entry) => resolveSubjectValue(entry, subject))
        .filter((value): value is number => value !== null);

      if (currentValue !== null && beforeToday.length > 0) {
        const finding = buildFinding(subject, "today", reference, currentValue, baselineValues, beforeToday[0].date);
        if (finding) {
          findings.push(finding);
        }
      }
    }

    const currentWeekValues = currentWeekEntries
      .map((entry) => resolveSubjectValue(entry, subject))
      .filter((value): value is number => value !== null);
    const baselineWeekValues = beforeWeek
      .map((entry) => resolveSubjectValue(entry, subject))
      .filter((value): value is number => value !== null);

    if (currentWeekValues.length > 0 && beforeWeek.length > 0) {
      const finding = buildFinding(
        subject,
        "week",
        reference,
        average(currentWeekValues),
        baselineWeekValues,
        beforeWeek[0].date
      );
      if (finding) {
        findings.push(finding);
      }
    }
  }

  return findings;
};
