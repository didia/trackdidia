import { createEmptyWeeklyObjective } from "../../domain/weekly-objectives";
import { MemoryRepository } from "../storage/memory-repository";
import { WeeklyObjectivesService } from "./weekly-objectives-service";
import type { RescueTimeClient } from "./client";

describe("WeeklyObjectivesService", () => {
  it("computes a snapshot from repository data and a mocked RescueTime client", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const objective = await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Software Development",
        kind: "time",
        targetHours: 2,
        rescuetimeKind: "category",
        rescuetimeThing: "Software Development"
      })
    );

    await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Budget review",
        kind: "manual"
      })
    );

    await repository.saveWeeklyObjectiveResult({
      weekStartDate: "2026-08-02",
      objectiveId: (await repository.listWeeklyObjectives()).find((item) => item.kind === "manual")!.id,
      achieved: true,
      updatedAt: "2026-08-09T12:00:00.000Z"
    });

    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });

    const mockClient: RescueTimeClient = {
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 3600, "Software Development"]]
      }))
    };

    const service = new WeeklyObjectivesService(repository, mockClient);
    const snapshot = await service.computeWeeklyObjectivesSnapshot("2026-08-02");

    expect(snapshot.score).toBe(0.75);
    expect(snapshot.items.find((item) => item.objective.id === objective.id)).toMatchObject({
      actualHours: 1,
      achievement: 0.5,
      source: "rescuetime"
    });
    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "category",
        begin: "2026-08-02",
        end: "2026-08-08"
      })
    );
  });
});
