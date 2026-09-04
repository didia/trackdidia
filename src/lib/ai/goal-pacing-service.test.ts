import { createEmptyAnnualGoal } from "../../domain/annual-goals";
import { defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import {
  buildGoalPacingSnapshot,
  type GoalPacingSnapshotInputs,
} from "./context/goal-pacing-snapshot";
import { GoalPacingService } from "./goal-pacing-service";
import type { AiProvider } from "./provider";

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
      }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: 60,
      progressRatio,
      monthlyProgress: [{ monthKey: "2026-08", value: 65 }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: [],
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
});
