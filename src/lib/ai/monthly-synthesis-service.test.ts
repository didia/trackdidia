import { createEmptyAnnualGoal } from "../../domain/annual-goals";
import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import { buildMonthlySnapshot, type MonthlySnapshotInputs } from "./context/monthly-snapshot";
import { MonthlySynthesisService } from "./monthly-synthesis-service";
import type { AiProvider } from "./provider";

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
    },
  ],
});

describe("buildMonthlySnapshot redaction", () => {
  it("omits review notes below full scope", () => {
    const inputs = buildMonthlyInputs();
    inputs.review = {
      monthKey: inputs.monthKey,
      monthStartDate: inputs.summary.monthStartDate,
      monthEndDate: inputs.summary.monthEndDate,
      status: "draft",
      notes: {
        bilan: "Notes libres",
        journaux: "",
        finances: "",
        temps: "",
        progressionObjectifs: "",
        missionObjectifs: "",
        nettoyageListes: "",
        calendrier: "",
        grosProjets: "",
        developpement: "",
      },
      ritualChecklist: {
        bilan: false,
        journaux: false,
        finances: false,
        temps: false,
        progressionObjectifs: false,
        missionObjectifs: false,
        nettoyageListes: false,
        calendrier: false,
        grosProjets: false,
        developpement: false,
      },
      updatedAt: "2026-04-30T12:00:00.000Z",
    };

    const metrics = buildMonthlySnapshot(inputs, "metrics");
    const full = buildMonthlySnapshot(inputs, "full");

    expect(metrics.notes).toBeUndefined();
    expect(full.notes?.bilan).toBe("Notes libres");
    expect(metrics.goals[0].title).toBeUndefined();
    expect(full.goals[0].title).toBe("Sommeil");
  });
});

describe("MonthlySynthesisService", () => {
  it("persists local synthesis when AI is disabled", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const settings = defaultAppSettings();
    settings.aiEnabled = false;

    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);
    const result = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs: buildMonthlyInputs(),
    });

    expect(result.source).toBe("local");
    expect(result.synthesis.headline).toBeTruthy();
    expect(result.proposals.some((proposal) => proposal.type === "goal_evaluation")).toBe(true);
  });

  it("returns cached result for identical input hash", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"));

    const settings = defaultAppSettings();
    settings.aiEnabled = false;

    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);
    const first = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs: buildMonthlyInputs(),
    });
    const second = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs: buildMonthlyInputs(),
    });

    expect(first.message.id).toBe(second.message.id);
    expect(second.source).toBe("cache");
  });

  it("uses cache on identical input hash when AI is enabled", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          headline: "IA",
          weekPattern: "Stable",
          sectionDrafts: {},
          goalEvaluationDrafts: [
            {
              goalId: "goal-1",
              score: 80,
              trend: "up",
              notes: "Bien",
              blockers: "",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 },
      })),
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const snapshotInputs = buildMonthlyInputs();

    const first = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs,
      trigger: "explicit",
    });
    const second = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs,
      trigger: "explicit",
    });

    expect(first.source).toBe("ai");
    expect(second.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("drops goal evaluation drafts for unknown goal ids", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          headline: "IA",
          weekPattern: "Stable",
          sectionDrafts: {},
          goalEvaluationDrafts: [
            {
              goalId: "unknown-goal",
              score: 80,
              trend: "up",
              notes: "Hallucination",
              blockers: "",
            },
            {
              goalId: "goal-1",
              score: 70,
              trend: "steady",
              notes: "Reel",
              blockers: "",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 2, latencyMs: 3 },
      })),
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await service.buildSynthesis(repository, {
      monthKey: "2026-04",
      settings,
      snapshotInputs: buildMonthlyInputs(),
      trigger: "explicit",
    });

    const goalProposals = result.proposals.filter(
      (proposal) => proposal.type === "goal_evaluation",
    );
    expect(goalProposals).toHaveLength(1);
    expect(JSON.parse(goalProposals[0].payloadJson).goalId).toBe("goal-1");
  });
});
