import { toLocalDateString } from "../../lib/gtd/shared";
import type { PomodoroTaskSummary } from "../types";
import { POMODORO_DAILY_TARGET_SESSIONS } from "./constants";
import { buildEvidenceWindow } from "./shared";
import type { Finding } from "./types";

export type FocusFindingKind = "focus_totals" | "task_concentration" | "focus_pulse_alignment";
export type FocusPulseAlignment = "aligned_high" | "aligned_low" | "focus_high_pulse_low" | "pulse_high_focus_low";

export interface FocusFinding extends Finding {
  kind: FocusFindingKind;
  alignment?: FocusPulseAlignment;
}

const buildFinding = (
  kind: FocusFindingKind,
  now: string,
  value: number,
  sampleSize: number,
  label: string,
  severity: Finding["severity"] = "info",
  alignment?: FocusPulseAlignment
): FocusFinding => {
  const nowDate = toLocalDateString(now);
  return {
    id: `focus:${kind}:${nowDate}`,
    severity,
    evidenceWindow: buildEvidenceWindow(nowDate, nowDate),
    sampleSize,
    value,
    label,
    kind,
    alignment
  };
};

/**
 * Pomodoro totals, task concentration and focus-versus-RescueTime-pulse alignment
 * (spec `ai-integration-v2.md` §3). `productivityPulseWeekToDate` is the already-fetched
 * RescueTime pulse (0-100) for the current Sunday-to-date week, or `null`/`undefined` when
 * RescueTime is not configured — in that case the alignment finding is omitted, not guessed.
 *
 * Phase 0 has no same-period daily RescueTime pulse to compare against `completedFocusSessionCount`
 * (a daily count), so `focus_pulse_alignment` is an approximate, mismatched-period comparison
 * (today's focus load vs. the week-to-date pulse) — the label says so explicitly rather than
 * implying the two figures cover the same period.
 */
export const computeFocusFindings = (
  taskSummaries: PomodoroTaskSummary[],
  completedFocusSessionCount: number,
  now: string,
  productivityPulseWeekToDate?: number | null
): FocusFinding[] => {
  const findings: FocusFinding[] = [];
  const totalSeconds = taskSummaries.reduce((sum, summary) => sum + summary.totalSeconds, 0);
  const totalMinutes = Math.round(totalSeconds / 60);

  findings.push(
    buildFinding(
      "focus_totals",
      now,
      completedFocusSessionCount,
      completedFocusSessionCount,
      `${completedFocusSessionCount} session(s) de focus completee(s), ${totalMinutes} minute(s) au total.`
    )
  );

  if (totalSeconds > 0) {
    const topTaskSeconds = Math.max(...taskSummaries.map((summary) => summary.totalSeconds));
    const concentration = topTaskSeconds / totalSeconds;
    findings.push(
      buildFinding(
        "task_concentration",
        now,
        concentration,
        taskSummaries.length,
        `${Math.round(concentration * 100)}% du temps de focus concentre sur une seule tache.`,
        concentration >= 0.6 ? "positive" : "info"
      )
    );
  }

  if (productivityPulseWeekToDate !== null && productivityPulseWeekToDate !== undefined) {
    const focusRatio = Math.min(1, completedFocusSessionCount / POMODORO_DAILY_TARGET_SESSIONS);
    const pulseRatio = productivityPulseWeekToDate / 100;
    const diff = focusRatio - pulseRatio;
    const bothHigh = focusRatio >= 0.5 && pulseRatio >= 0.5;
    const bothLow = focusRatio < 0.5 && pulseRatio < 0.5;

    let alignment: FocusPulseAlignment;
    if (bothHigh) {
      alignment = "aligned_high";
    } else if (bothLow) {
      alignment = "aligned_low";
    } else if (diff > 0) {
      alignment = "focus_high_pulse_low";
    } else {
      alignment = "pulse_high_focus_low";
    }

    findings.push(
      buildFinding(
        "focus_pulse_alignment",
        now,
        diff,
        completedFocusSessionCount,
        `Sessions focus du jour comparees (approximation, periodes differentes) au pulse RescueTime de la semaine en cours a ce jour (${Math.round(productivityPulseWeekToDate)}/100) (alignement: ${alignment}).`,
        bothHigh ? "positive" : bothLow ? "watch" : "info",
        alignment
      )
    );
  }

  return findings;
};
