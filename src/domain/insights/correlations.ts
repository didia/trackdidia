import { computeDisciplineScore } from "../daily-entry";
import { principleDefinitions } from "../definitions";
import type { DailyEntry, PrincipleKey } from "../types";
import { MIN_SAMPLE_DAYS } from "./constants";
import { average, buildEvidenceWindow, sortEntriesByDate } from "./shared";
import type { Finding } from "./types";

export interface CorrelationFinding extends Finding {
  principleKey: PrincipleKey;
  meanDisciplineWhenTrue: number;
  meanDisciplineWhenFalse: number;
  sampleSizeTrue: number;
  sampleSizeFalse: number;
  /** `meanDisciplineWhenTrue - meanDisciplineWhenFalse`. Positive means higher discipline on `true` days. */
  diff: number;
}

/**
 * Difference of mean discipline on days a principle is `true` vs `false`, with sample size
 * (spec `ai-integration-v2.md` §3). Below `MIN_SAMPLE_DAYS` total qualifying days, or when
 * one side of the comparison has no data, the finding is omitted rather than weakened —
 * this is an observation, never a causal claim.
 */
export const computeCorrelationFindings = (entries: DailyEntry[]): CorrelationFinding[] => {
  const ordered = sortEntriesByDate(entries);
  const findings: CorrelationFinding[] = [];

  for (const { key } of principleDefinitions) {
    const trueEntries = ordered.filter((entry) => entry.principleChecks[key] === true);
    const falseEntries = ordered.filter((entry) => entry.principleChecks[key] === false);
    const sampleSize = trueEntries.length + falseEntries.length;

    if (sampleSize < MIN_SAMPLE_DAYS || trueEntries.length === 0 || falseEntries.length === 0) {
      continue;
    }

    const meanDisciplineWhenTrue = average(trueEntries.map((entry) => computeDisciplineScore(entry)));
    const meanDisciplineWhenFalse = average(falseEntries.map((entry) => computeDisciplineScore(entry)));
    const diff = meanDisciplineWhenTrue - meanDisciplineWhenFalse;
    const qualifyingDates = [...trueEntries, ...falseEntries].map((entry) => entry.date).sort();

    findings.push({
      id: `correlation:${key}`,
      severity: diff >= 0.1 ? "positive" : diff <= -0.1 ? "watch" : "info",
      evidenceWindow: buildEvidenceWindow(qualifyingDates[0], qualifyingDates[qualifyingDates.length - 1]),
      sampleSize,
      value: diff,
      label: `Discipline moyenne associee aux jours avec ${key}: ${Math.round(meanDisciplineWhenTrue * 100)}% (vs ${Math.round(meanDisciplineWhenFalse * 100)}% sans, n=${sampleSize}).`,
      principleKey: key,
      meanDisciplineWhenTrue,
      meanDisciplineWhenFalse,
      sampleSizeTrue: trueEntries.length,
      sampleSizeFalse: falseEntries.length,
      diff
    });
  }

  return findings;
};
