import { createEmptyAnnualGoal } from "../../domain/annual-goals";
import { createEmptyDailyEntry, defaultAppSettings, updateNote } from "../../domain/daily-entry";
import type { AnnualGoalMeasurement } from "../../domain/types";
import { buildWeekDates } from "../../domain/weekly-review";
import { MemoryRepository } from "../storage/memory-repository";
import { loadVerseCatalog } from "../pastor/verse-catalog";
import type { DailySnapshotInputs } from "./context/daily-snapshot";
import type { GoalPacingSnapshotInputs } from "./context/goal-pacing-snapshot";
import type { MonthlySnapshotInputs } from "./context/monthly-snapshot";
import type { WeeklySnapshotInputs } from "./context/weekly-snapshot";
import { GoalPacingService } from "./goal-pacing-service";
import { WeeklySynthesisService } from "./weekly-synthesis-service";
import { MonthlySynthesisService } from "./monthly-synthesis-service";
import { CoachPulseService } from "./coach-pulse-service";
import { PastorVerseService } from "./pastor-verse-service";
import type { AiProvider } from "./provider";
const buildNumericMeasurement = (
  progressRatio: number,
  expectedProgressRatio: number,
): AnnualGoalMeasurement => ({
  measurementType: "numeric",
  direction: "increase",
  currentPeriodKey: null,
  currentPeriodCount: null,
  cadenceTarget: null,
  adherenceRatio: null,
  periodsMet: 0,
  periodsElapsed: 0,
  currentStreak: 0,
  milestonesCompleted: 0,
  milestonesTotal: 0,
  milestoneProgressRatio: null,
  expectedProgressRatio,
  onPace: progressRatio >= expectedProgressRatio - 0.1,
});
const buildPacingInputs = (year = 2026, progressRatio = 0.6): GoalPacingSnapshotInputs => ({
  year,
  asOfDate: "2026-08-29",
  evaluationMonthKey: "2026-08",
  goalSnapshots: [
    {
      goal: createEmptyAnnualGoal({
        id: "goal-1",
        title: "Discipline",
        targetValue: 100,
        unit: "%",
        status: "active",
      }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: 60,
      progressRatio,
      monthlyProgress: [{ monthKey: "2026-08", value: 65 }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
      measurement: buildNumericMeasurement(progressRatio, 0.65),
    },
  ],
});
const buildWeeklyInputs = (weekStartDate = "2026-08-02"): WeeklySnapshotInputs => {
  const weekDates = [
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
  ];
  const weekEntries = weekDates.map((date) => {
    let entry = createEmptyDailyEntry(date);
    entry = updateNote(entry, "morningIntention", `Intention ${date}`);
    return entry;
  });

  return {
    weekStartDate: buildWeekDates(weekStartDate),
    summary: {
      weekStartDate: buildWeekDates(weekStartDate),
      weekEndDate: "2026-08-08",
      sleepAverage: 80,
      sleepQuality: 80,
      trcDaysRespected: 5,
      respectTrc: (5 / 7) * 100,
      screenTimeTotalMinutes: 700,
      phoneScreenTime: 90,
      pomodorisTotal: 20,
      pomodoris: 70,
      disciplineAverage: 0.8,
      discipline: 80,
      tasksAddedTotal: 10,
      tasksCompletedTotal: 8,
      tasksCompletionRate: 80,
      calorieAverage: 3000,
      physicalActivity: 78,
      productivityPulse: null,
      rescueTimeGoalsScore: null,
      weeklyScore: 0.75,
      days: [],
    },
    weekEntries,
    historyEntries: weekEntries,
    review: null,
    tasks: [],
    projects: [],
    pomodoroTaskSummaries: [],
    completedFocusSessionCount: 0,
    productivityPulse: null,
    rescueTimeGoalsScore: null,
    rescueTimeGoalItems: [],
    rescuetimeConfigured: false,
    now: "2026-08-08T12:00:00.000Z",
  };
};
const numericMeasurement: AnnualGoalMeasurement = {
  measurementType: "numeric",
  direction: "increase",
  currentPeriodKey: null,
  currentPeriodCount: null,
  cadenceTarget: null,
  adherenceRatio: null,
  periodsMet: 0,
  periodsElapsed: 0,
  currentStreak: 0,
  milestonesCompleted: 0,
  milestonesTotal: 0,
  milestoneProgressRatio: null,
  expectedProgressRatio: null,
  onPace: true,
};
const buildMonthlyInputs = (monthKey = "2026-04"): MonthlySnapshotInputs => ({
  monthKey,
  summary: {
    monthKey,
    monthStartDate: "2026-04-01",
    monthEndDate: "2026-04-30",
    daysTracked: 10,
    weeksCovered: 4,
    weeklyReviewsCompleted: 2,
    sleepAverage: 80,
    trcRate: 70,
    screenTimeTotalMinutes: 1200,
    pomodorisTotal: 40,
    disciplineAverage: 0.75,
    tasksCompletionRate: 80,
    weeklyScoreAverage: 0.72,
    weeks: [
      {
        weekStartDate: "2026-03-30",
        weekEndDate: "2026-04-05",
        weeklyScore: 0.7,
        reviewStatus: "closed",
        noteCount: 2,
      },
    ],
  },
  review: null,
  goalSnapshots: [
    {
      goal: createEmptyAnnualGoal({ id: "goal-1", title: "Sommeil", targetValue: 100, unit: "%" }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: 70,
      progressRatio: 0.7,
      monthlyProgress: [{ monthKey, value: 75 }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
      measurement: numericMeasurement,
    },
  ],
});
const buildSnapshotInputs = (entry = createEmptyDailyEntry("2026-08-29")): DailySnapshotInputs => ({
  date: entry.date,
  entry,
  historyEntries: [entry],
  tasks: [],
  projects: [],
  pomodoroTaskSummaries: [],
  completedFocusSessionCount: 0,
  productivityPulseWeekToDate: null,
  rescuetimeConfigured: false,
  now: "2026-08-29T12:00:00.000Z",
});

const bodies = {
  goal: {
    goals: [
      {
        goalId: "goal-1",
        onPace: true,
        gap: "Proche",
        requiredWeeklyBehaviour: "Focus",
        riskLevel: "low",
        recommendation: "Continuer",
      },
    ],
  },
  weekly: {
    headline: "IA",
    scoreExplanation: "Score",
    strongestAxis: "Discipline",
    weakestAxes: ["Sommeil", "Pomodoris"],
    sectionDrafts: { bilan: "Bilan" },
    nextWeekObjectives: [{ title: "Focus", kind: "manual" }],
    gtdActions: [],
  },
  monthly: {
    headline: "IA",
    weekPattern: "Stable",
    sectionDrafts: { bilan: "Bilan" },
    goalEvaluationDrafts: [
      { goalId: "goal-1", score: 80, trend: "up", notes: "Bien", blockers: "" },
    ],
  },
  coach: {
    stance: "open",
    headline: "IA",
    read: "Signal",
    move: null,
    intentionDraft: "Intention",
  },
  pastor: {
    pick: "list",
    verseId: loadVerseCatalog()[0].id,
    principleKey: null,
    intent: "reinforcement",
    title: "Titre",
    explanation: "Ancrage. Enseignement.",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

for (const surface of ["goal", "weekly", "monthly", "coach", "pastor"] as const) {
  for (const mode of ["local", "ok", "repair", "invalid", "throw"] as const) {
    it(`${surface} persists the original ${mode} message and proposals`, async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const settings = defaultAppSettings();
      settings.aiEnabled = mode !== "local";
      settings.aiApiKey = "test-only-key";
      let calls = 0;
      const provider: AiProvider = {
        generateStructured: vi.fn(async () => {
          calls += 1;
          if (mode === "throw") throw new Error("provider failed");
          return {
            text:
              mode === "invalid" || (mode === "repair" && calls === 1)
                ? "bad JSON"
                : JSON.stringify(bodies[surface]),
            model: `fixture-model-${calls}`,
            usage: {
              tokensPrompt: 10 * calls,
              tokensCompletion: 20 * calls,
              latencyMs: 100 * calls,
            },
          };
        }),
      };
      if (surface === "goal")
        await new GoalPacingService(provider).buildPacing(repository, {
          year: 2026,
          settings,
          snapshotInputs: buildPacingInputs(),
        });
      if (surface === "weekly")
        await new WeeklySynthesisService(provider).buildSynthesis(repository, {
          weekStartDate: "2026-08-02",
          settings,
          snapshotInputs: buildWeeklyInputs(),
        });
      if (surface === "monthly")
        await new MonthlySynthesisService(provider).buildSynthesis(repository, {
          monthKey: "2026-04",
          settings,
          snapshotInputs: buildMonthlyInputs(),
        });
      if (surface === "coach")
        await new CoachPulseService(provider).buildPulse(repository, {
          stance: "open",
          entry: createEmptyDailyEntry("2026-08-29"),
          settings,
          snapshotInputs: buildSnapshotInputs(),
          trigger: "explicit",
        });
      if (surface === "pastor")
        await new PastorVerseService(provider).buildVerse(repository, {
          date: "2026-08-29",
          settings,
          trigger: "auto",
        });
      const messages = await repository.listAiMessages();
      const snapshots = await Promise.all(
        messages.map(async ({ id, createdAt, ...message }) => ({
          message,
          proposals: (await repository.listAiProposals(id)).map(
            ({ id, messageId, createdAt, ...proposal }) => proposal,
          ),
        })),
      );
      expect(snapshots).toMatchSnapshot();
      expect(calls).toBe(mode === "local" ? 0 : mode === "repair" || mode === "invalid" ? 2 : 1);
    });
  }
}
