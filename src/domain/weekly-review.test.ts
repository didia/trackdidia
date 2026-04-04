import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  updateMetric,
  updatePrinciple
} from "./daily-entry";
import { buildWeeklyReviewSummary, createEmptyWeeklyReview, updateWeeklyReviewChecklist, updateWeeklyReviewNote } from "./weekly-review";

describe("weekly review domain", () => {
  it("builds weekly aggregates from seven daily entries", () => {
    const weekDates = [
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04"
    ];

    const entries = weekDates.map((date, index) => {
      let entry = createEmptyDailyEntry(date);
      entry = updateMetric(entry, "qualiteSommeil", 70 + index);
      entry = updateMetric(entry, "tempsEcranTelephone", 100);
      entry = applyDailyPomodoroStats(entry, {
        date,
        completedFocusSessions: 4
      });
      entry = applyDailyTaskStats(entry, {
        date,
        tasksAtStart: 5,
        tasksAdded: 4,
        tasksCompleted: 3,
        tasksRemaining: 2
      });

      if (index % 2 === 0) {
        entry = updatePrinciple(entry, "respectTrc", true);
      }

      entry = updatePrinciple(entry, "priereDuMatin", true);
      entry = updatePrinciple(entry, "objectifsAtteints", true);
      return entry;
    });

    const summary = buildWeeklyReviewSummary("2026-03-29", entries);

    expect(summary.weekStartDate).toBe("2026-03-29");
    expect(summary.weekEndDate).toBe("2026-04-04");
    expect(summary.sleepAverage).toBe(73);
    expect(summary.trcDaysRespected).toBe(4);
    expect(summary.screenTimeTotalMinutes).toBe(700);
    expect(summary.pomodorisTotal).toBe(28);
    expect(summary.tasksAddedTotal).toBe(28);
    expect(summary.tasksCompletedTotal).toBe(21);
    expect(summary.tasksCompletionRate).toBeCloseTo(75);
    expect(summary.disciplineAverage).toBeGreaterThan(0);
    expect(summary.weeklyScore).toBeGreaterThan(0);
    expect(summary.days).toHaveLength(7);
  });

  it("prefers manual overrides already resolved inside the daily entry", () => {
    let entry = createEmptyDailyEntry("2026-03-29");
    entry = applyDailyPomodoroStats(entry, {
      date: "2026-03-29",
      completedFocusSessions: 4
    });
    entry = applyDailyTaskStats(entry, {
      date: "2026-03-29",
      tasksAtStart: 2,
      tasksAdded: 3,
      tasksCompleted: 1,
      tasksRemaining: 4
    });
    entry = updateMetric(entry, "pomodoris", 6);
    entry = updateMetric(entry, "tachesAjoutes", 5);
    entry = updateMetric(entry, "tachesRealises", 4);

    const summary = buildWeeklyReviewSummary("2026-03-29", [
      entry,
      createEmptyDailyEntry("2026-03-30"),
      createEmptyDailyEntry("2026-03-31"),
      createEmptyDailyEntry("2026-04-01"),
      createEmptyDailyEntry("2026-04-02"),
      createEmptyDailyEntry("2026-04-03"),
      createEmptyDailyEntry("2026-04-04")
    ]);

    expect(summary.pomodorisTotal).toBe(6);
    expect(summary.tasksAddedTotal).toBe(5);
    expect(summary.tasksCompletedTotal).toBe(4);
  });

  it("returns zero-like aggregates when the week is empty", () => {
    const summary = buildWeeklyReviewSummary("2026-03-29", [
      createEmptyDailyEntry("2026-03-29"),
      createEmptyDailyEntry("2026-03-30"),
      createEmptyDailyEntry("2026-03-31"),
      createEmptyDailyEntry("2026-04-01"),
      createEmptyDailyEntry("2026-04-02"),
      createEmptyDailyEntry("2026-04-03"),
      createEmptyDailyEntry("2026-04-04")
    ]);

    expect(summary.sleepAverage).toBe(0);
    expect(summary.trcDaysRespected).toBe(0);
    expect(summary.screenTimeTotalMinutes).toBe(0);
    expect(summary.pomodorisTotal).toBe(0);
    expect(summary.tasksAddedTotal).toBe(0);
    expect(summary.tasksCompletedTotal).toBe(0);
    expect(summary.weeklyScore).toBeGreaterThanOrEqual(0);
  });

  it("updates ritual notes and checklist entries immutably", () => {
    const review = createEmptyWeeklyReview("2026-03-29");
    const withNote = updateWeeklyReviewNote(review, "bilan", "Semaine dense.");
    const withCheck = updateWeeklyReviewChecklist(withNote, "dimanche", true);

    expect(review.notes.bilan).toBe("");
    expect(withNote.notes.bilan).toBe("Semaine dense.");
    expect(withCheck.ritualChecklist.dimanche).toBe(true);
  });
});
