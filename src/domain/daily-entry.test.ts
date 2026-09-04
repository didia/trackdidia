import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  applyLegacyAiMaxTokensUpgrade,
  applyRoutineTransition,
  computeCompletionPercent,
  computeDisciplineScore,
  computeTaskCompletionPercent,
  createEmptyDailyEntry,
  DEFAULT_AI_MAX_TOKENS,
  defaultAppSettings,
  findMissingMetricKeys,
  findUnansweredPrincipleKeys,
  updateMetric,
  updateNote,
  updatePrinciple
} from "./daily-entry";
import { principleDefinitions } from "./definitions";

describe("daily entry domain", () => {
  it("computes discipline score from completed principles only", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updatePrinciple(entry, "priereDuMatin", true);
    entry = updatePrinciple(entry, "oxytocineDuMatin", false);
    entry = updatePrinciple(entry, "respectReveil", true);

    expect(computeDisciplineScore(entry)).toBeCloseTo(2 / principleDefinitions.length);
  });

  it("computes completion percent across metrics, principles and notes", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateMetric(entry, "pomodoris", 4);
    entry = updatePrinciple(entry, "priereDuMatin", true);
    entry = updateNote(entry, "morningIntention", "Rester net.");

    expect(computeCompletionPercent(entry)).toBeCloseTo(3 / 28);
  });

  it("computes daily task completion vs weekly pace (start + added over days left)", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = applyDailyTaskStats(entry, {
      date: "2026-03-31",
      tasksAtStart: 3,
      tasksAdded: 8,
      tasksCompleted: 2,
      tasksRemaining: 9
    });

    // Week Sun 2026-03-29 .. Sat 2026-04-04; Tue 03-31 => 5 days left inclusive
    // pace = (3 + 8) / 5; score = 2 / pace = 10/11
    expect(computeTaskCompletionPercent(entry)).toBeCloseTo(10 / 11);

    entry = updateMetric(entry, "tachesAjoutes", 10);
    entry = updateMetric(entry, "tachesRealises", 4);

    // (3 + 10) / 5 = 13/5; 4 / (13/5) = 20/13
    expect(computeTaskCompletionPercent(entry)).toBeCloseTo(20 / 13);
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

  it("finds missing manual metrics but ignores auto-suggested ones", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updateMetric(entry, "marche", 8000);
    entry = applyDailyTaskStats(entry, {
      date: "2026-03-31",
      tasksAtStart: 3,
      tasksAdded: 2,
      tasksCompleted: 1,
      tasksRemaining: 4
    });
    entry = applyDailyPomodoroStats(entry, {
      date: "2026-03-31",
      completedFocusSessions: 4
    });

    const missing = findMissingMetricKeys(entry);

    expect(missing).toContain("course");
    expect(missing).toContain("depenseCalorique");
    expect(missing).toContain("qualiteSommeil");
    expect(missing).not.toContain("marche");
    expect(missing).not.toContain("tachesDebut");
    expect(missing).not.toContain("tachesAjoutes");
    expect(missing).not.toContain("tachesFin");
    expect(missing).not.toContain("tachesRealises");
    expect(missing).not.toContain("pomodoris");
  });

  it("finds unanswered principles but not explicit false answers", () => {
    let entry = createEmptyDailyEntry("2026-03-31");
    entry = updatePrinciple(entry, "priereDuSoir", false);
    entry = updatePrinciple(entry, "retroJournalier", true);

    const unanswered = findUnansweredPrincipleKeys(entry);

    expect(unanswered).not.toContain("priereDuSoir");
    expect(unanswered).not.toContain("retroJournalier");
    expect(unanswered).toContain("attentionAMonEpouse");
    expect(unanswered).toHaveLength(principleDefinitions.length - 2);
  });
});

describe("applyLegacyAiMaxTokensUpgrade", () => {
  it("upgrades a stored factory 700 once and records the marker", () => {
    const settings = defaultAppSettings();
    settings.aiMaxTokens = 700;
    settings.aiMaxTokensUpgradeDoneAt = "";

    const upgraded = applyLegacyAiMaxTokensUpgrade(settings, "2026-09-04T12:00:00.000Z");

    expect(upgraded?.aiMaxTokens).toBe(DEFAULT_AI_MAX_TOKENS);
    expect(upgraded?.aiMaxTokensUpgradeDoneAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("keeps a custom value and still records the marker", () => {
    const settings = defaultAppSettings();
    settings.aiMaxTokens = 7000;
    settings.aiMaxTokensUpgradeDoneAt = "";

    const upgraded = applyLegacyAiMaxTokensUpgrade(settings, "2026-09-04T12:00:00.000Z");

    expect(upgraded?.aiMaxTokens).toBe(7000);
    expect(upgraded?.aiMaxTokensUpgradeDoneAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("does nothing after the marker is set, including a later 700", () => {
    const settings = defaultAppSettings();
    settings.aiMaxTokens = 700;
    settings.aiMaxTokensUpgradeDoneAt = "2026-09-04T12:00:00.000Z";

    expect(applyLegacyAiMaxTokensUpgrade(settings, "2026-09-05T12:00:00.000Z")).toBeNull();
  });
});
