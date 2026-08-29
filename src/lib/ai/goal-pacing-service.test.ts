import { defaultAppSettings } from "../../domain/daily-entry";
import { createEmptyAnnualGoal } from "../../domain/annual-goals";
import { MemoryRepository } from "../storage/memory-repository";
import { buildGoalPacingSnapshot, type GoalPacingSnapshotInputs } from "./context/goal-pacing-snapshot";
import { GoalPacingService } from "./goal-pacing-service";
import type { AiProvider } from "./provider";

const buildPacingInputs = (year = 2026): GoalPacingSnapshotInputs => ({
  year,
  asOfDate: "2026-08-29",
  evaluationMonthKey: "2026-08",
  goalSnapshots: [
    {
      goal: createEmptyAnnualGoal({ id: "goal-1", title: "Discipline", targetValue: 100, unit: "%" }),
      sourceType: "manual",
      sourceLabel: null,
      currentValue: 60,
      progressRatio: 0.6,
      monthlyProgress: [{ monthKey: "2026-08", value: 65 }],
      linkedWeeklyMetricLabels: [],
      linkedDailyHabitLabels: []
    }
  ]
});

describe("buildGoalPacingSnapshot", () => {
  it("computes onPace from annual progress fraction", () => {
    const snapshot = buildGoalPacingSnapshot(buildPacingInputs(), "full");
    expect(snapshot.expectedProgressRatio).toBeGreaterThan(0.5);
    expect(snapshot.goals[0].onPace).toBe(typeof snapshot.goals[0].onPace === "boolean");
    expect(snapshot.goals[0].title).toBe("Discipline");
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
      snapshotInputs: buildPacingInputs()
    });

    expect(result.source).toBe("local");
    expect(result.pacing.goals).toHaveLength(1);
    expect(result.pacing.goals[0].recommendation).toBeTruthy();
  });
});
