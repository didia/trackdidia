import { createEmptyAnnualGoal } from "../../domain/annual-goals";
import { defaultAppSettings } from "../../domain/daily-entry";
import type { AnnualGoalMeasurement } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import {
  buildGoalPacingSnapshot,
  type GoalPacingSnapshotInputs,
} from "./context/goal-pacing-snapshot";
import { GoalPacingService } from "./goal-pacing-service";
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

describe("buildGoalPacingSnapshot", () => {
  it("computes onPace from annual progress fraction", () => {
    const snapshot = buildGoalPacingSnapshot(buildPacingInputs(), "full");
    expect(snapshot.expectedProgressRatio).toBeGreaterThan(0.5);
    expect(snapshot.goals[0].onPace).toBe(true);
    expect(snapshot.goals[0].title).toBe("Discipline");
  });

  it("marks goals behind pace when progress is low", () => {
    const snapshot = buildGoalPacingSnapshot(buildPacingInputs(2026, 0.2), "full");
    expect(snapshot.goals[0].onPace).toBe(false);
  });
});

describe("GoalPacingService", () => {
  it("persists local pacing when AI is disabled", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const settings = defaultAppSettings();
    settings.aiEnabled = false;

    const service = new GoalPacingService({ generateStructured: vi.fn() } as unknown as AiProvider);
    const result = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs: buildPacingInputs(),
    });

    expect(result.source).toBe("local");
    expect(result.pacing.goals).toHaveLength(1);
    expect(result.pacing.goals[0].recommendation).toBeTruthy();
  });

  it("returns cached result for identical input hash", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const settings = defaultAppSettings();
    settings.aiEnabled = false;

    const service = new GoalPacingService({ generateStructured: vi.fn() } as unknown as AiProvider);
    const first = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs: buildPacingInputs(),
    });
    const second = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs: buildPacingInputs(),
    });

    expect(first.message.id).toBe(second.message.id);
    expect(second.source).toBe("cache");
  });

  it("uses cache on identical input hash when AI is enabled", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
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
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 },
      })),
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new GoalPacingService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const snapshotInputs = buildPacingInputs();

    const first = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs,
      trigger: "explicit",
    });
    const second = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs,
      trigger: "explicit",
    });

    expect(first.source).toBe("ai");
    expect(second.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("cache misses when asOfDate changes", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
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
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 },
      })),
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new GoalPacingService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs: buildPacingInputs(),
      trigger: "auto",
    });
    const nextDay = await service.buildPacing(repository, {
      year: 2026,
      settings,
      snapshotInputs: { ...buildPacingInputs(), asOfDate: "2026-08-30" },
      trigger: "auto",
    });

    expect(nextDay.source).toBe("ai");
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("cache hits for an ended year when the calendar advances past December 31", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
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
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 },
      })),
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new GoalPacingService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    await service.buildPacing(repository, {
      year: 2025,
      settings,
      snapshotInputs: { ...buildPacingInputs(2025), asOfDate: "2025-12-31" },
      trigger: "auto",
    });
    const nextYear = await service.buildPacing(repository, {
      year: 2025,
      settings,
      snapshotInputs: { ...buildPacingInputs(2025), asOfDate: "2026-01-02" },
      trigger: "auto",
    });

    expect(nextYear.source).toBe("cache");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });
});
