import { createEmptyDailyEntry, updateMetric, updatePrinciple } from "./daily-entry";
import { buildMonthlyReviewSummary, createEmptyMonthlyReview, isFirstSaturdayOfMonth, updateMonthlyReviewChecklist, updateMonthlyReviewNote } from "./monthly-review";
import type { WeeklyReview, WeeklyReviewSummary } from "./types";

describe("monthly review domain", () => {
  it("builds a monthly summary from daily entries and weekly reviews", () => {
    const entries = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"].map((date) => {
      let entry = createEmptyDailyEntry(date);
      entry = updateMetric(entry, "qualiteSommeil", 80);
      entry = updateMetric(entry, "tempsEcranTelephone", 100);
      entry = updateMetric(entry, "pomodoris", 4);
      entry = updateMetric(entry, "tachesAjoutes", 4);
      entry = updateMetric(entry, "tachesRealises", 3);
      entry = updatePrinciple(entry, "priereDuMatin", true);
      entry = updatePrinciple(entry, "respectTrc", true);
      return entry;
    });

    const weeklyReviews: WeeklyReview[] = [
      {
        weekStartDate: "2026-03-01",
        weekEndDate: "2026-03-07",
        status: "closed",
        notes: {
          bilan: "ok",
          budget: "",
          tempsEtPlan: "",
          collecte: "",
          calendrier: "",
          gtd: "",
          alignement: "",
          dimanche: ""
        },
        ritualChecklist: {
          bilan: true,
          budget: false,
          tempsEtPlan: false,
          collecte: false,
          calendrier: false,
          gtd: false,
          alignement: false,
          dimanche: false
        },
        updatedAt: "2026-03-08T12:00:00.000Z"
      }
    ];

    const weeklySummaries: WeeklyReviewSummary[] = [
      {
        weekStartDate: "2026-03-01",
        weekEndDate: "2026-03-07",
        sleepAverage: 80,
        sleepQuality: 80,
        trcDaysRespected: 4,
        respectTrc: 57.14,
        screenTimeTotalMinutes: 400,
        phoneScreenTime: 120,
        pomodorisTotal: 16,
        pomodoris: 28,
        disciplineAverage: 0.2,
        discipline: 20,
        tasksAddedTotal: 16,
        tasksCompletedTotal: 12,
        tasksCompletionRate: 75,
        weeklyScore: 0.6,
        days: []
      }
    ];

    const summary = buildMonthlyReviewSummary("2026-03", entries, weeklyReviews, weeklySummaries);

    expect(summary.daysTracked).toBe(4);
    expect(summary.weeklyReviewsCompleted).toBe(1);
    expect(summary.sleepAverage).toBe(80);
    expect(summary.trcRate).toBe(100);
    expect(summary.screenTimeTotalMinutes).toBe(400);
    expect(summary.pomodorisTotal).toBe(16);
    expect(summary.tasksCompletionRate).toBe(75);
    expect(summary.weeklyScoreAverage).toBe(0.6);
  });

  it("supports monthly notes, checklist and first saturday detection", () => {
    const review = createEmptyMonthlyReview("2026-04");
    const withNote = updateMonthlyReviewNote(review, "bilan", "Bons apprentissages");
    const withCheck = updateMonthlyReviewChecklist(withNote, "developpement", true);

    expect(withCheck.notes.bilan).toBe("Bons apprentissages");
    expect(withCheck.ritualChecklist.developpement).toBe(true);
    expect(isFirstSaturdayOfMonth("2026-04-04")).toBe(true);
    expect(isFirstSaturdayOfMonth("2026-04-11")).toBe(false);
  });
});
