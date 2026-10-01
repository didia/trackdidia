import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import { buildMidWeekReviewSummary } from "../../../domain/mid-week-review";
import { computeRescueTimeGoalsSnapshot } from "../../../domain/rescuetime-goals";
import type { DailyEntry } from "../../../domain/types";
import type { MidWeekSnapshotInputs } from "../context/mid-week-snapshot";

export const MID_WEEK_TEST_WEEK = "2026-08-02";
export const MID_WEEK_TEST_AS_OF = "2026-08-05";

/** Wednesday fixture: lagging pomodoros, a lagging titled RescueTime goal, journal and decisions. */
export const buildMidWeekInputs = (
  overrides: { asOfDate?: string; decisions?: string | null; pomodoris?: number } = {},
): MidWeekSnapshotInputs => {
  const weekEntries: DailyEntry[] = Array.from({ length: 7 }, (_, index) => {
    const entry = createEmptyDailyEntry(`2026-08-0${2 + index}`);
    if (index < 3) {
      entry.metrics.pomodoris = index === 0 ? (overrides.pomodoris ?? 8) : 0;
      entry.nightReflection = index === 1 ? "Journée difficile chez Acme" : "";
    }
    return entry;
  });
  const goalsSnapshot = computeRescueTimeGoalsSnapshot(
    MID_WEEK_TEST_WEEK,
    "2026-08-08",
    [
      {
        goalId: 7,
        title: "Projet Secret",
        isMore: true,
        actualHours: 1,
        weeklyTargetHours: 14,
        achievement: 0.07,
        scheduleLabel: "24x7",
      },
    ],
    { rescuetimeConfigured: true },
  );
  const summary = buildMidWeekReviewSummary({
    weekStartDate: MID_WEEK_TEST_WEEK,
    asOfDate: overrides.asOfDate ?? MID_WEEK_TEST_AS_OF,
    weekEntries,
    summary: null,
    goalsSnapshot,
    pulseSnapshot: null,
    objectivesSnapshot: null,
  });
  return {
    summary,
    weekEntries,
    decisions: "decisions" in overrides ? (overrides.decisions ?? null) : "Couper le téléphone",
  };
};
