import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  applyRoutineTransition,
  computeCompletionPercent,
  computeDisciplineScore,
  createEmptyDailyEntry,
  updateMetric,
  updateNote,
  updatePrinciple
} from "./daily-entry";

describe("daily entry domain", () => {
  it("computes discipline score from answered principles only", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updatePrinciple(entry, "priereDuMatin", true);
    entry = updatePrinciple(entry, "oxytocineDuMatin", false);
    entry = updatePrinciple(entry, "respectReveil", true);

    expect(computeDisciplineScore(entry)).toBeCloseTo(2 / 3);
  });

  it("computes completion percent across metrics, principles and notes", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateMetric(entry, "pomodoris", 4);
    entry = updatePrinciple(entry, "priereDuMatin", true);
    entry = updateNote(entry, "morningIntention", "Rester net.");

    expect(computeCompletionPercent(entry)).toBeCloseTo(3 / 28);
  });

  it("supports morning completion, closure and reopening", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateNote(entry, "morningIntention", "Bien commencer.");
    entry = applyRoutineTransition(entry, "complete_morning");
    expect(entry.status).toBe("morning_done");

    entry = applyRoutineTransition(entry, "close_day");
    expect(entry.status).toBe("closed");

    entry = applyRoutineTransition(entry, "reopen_day");
    expect(entry.status).toBe("morning_done");
  });

  it("keeps manual GTD metric overrides while exposing automatic suggestions", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateMetric(entry, "tachesAjoutes", 7);
    entry = applyDailyTaskStats(entry, {
      date: "2026-03-31",
      tasksAtStart: 3,
      tasksAdded: 2,
      tasksCompleted: 1,
      tasksRemaining: 4
    });

    expect(entry.metrics.tachesAjoutes).toBe(7);
    expect(entry.suggestedMetrics?.tachesAjoutes).toBe(2);
    expect(entry.suggestedMetrics?.tachesDebut).toBe(3);
  });

  it("keeps manual pomodoro override while exposing automatic pomodoro suggestion", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateMetric(entry, "pomodoris", 6);
    entry = applyDailyPomodoroStats(entry, {
      date: "2026-03-31",
      completedFocusSessions: 4
    });

    expect(entry.metrics.pomodoris).toBe(6);
    expect(entry.suggestedMetrics?.pomodoris).toBe(4);
  });
});
