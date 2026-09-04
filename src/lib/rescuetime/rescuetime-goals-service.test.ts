import { MemoryRepository } from "../storage/memory-repository";
import type { RescueTimeGoalsClient } from "./goals-client";
import { RescueTimeGoalsService } from "./rescuetime-goals-service";

describe("RescueTimeGoalsService", () => {
  it("scores enabled RescueTime goals for a week", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => [
        {
          id: 1,
          display_name: "more than 2h on Personal (24x7)",
          amount_seconds: 7200,
          is_more: true,
          enabled: true,
          taxon_id: 15,
          taxonomy_name: "overview",
          schedule_name: "24x7",
          overview: { name: "Personal" },
        },
      ]),
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 12600, "Personal"]],
      })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeGoalsSnapshot("2026-08-02");

    expect(mockClient.listGoals).toHaveBeenCalledWith("rt-test-key");
    expect(snapshot.fetchError).toBeUndefined();
    expect(snapshot.score).toBe(0.25);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      title: "more than 2h on Personal (24x7)",
      achievement: 0.25,
    });
    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "overview",
        begin: "2026-08-02",
        end: "2026-08-08",
      }),
    );
  });

  it("computes productivity pulse for a week without schedule filter", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => []),
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Productivity"],
        rows: [
          [1, 3600, 2],
          [2, 3600, 0],
        ],
      })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeProductivityPulse("2026-08-02");

    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "productivity",
        begin: "2026-08-02",
        end: "2026-08-08",
        sourceType: "computers",
      }),
    );
    expect(snapshot.weekStartDate).toBe("2026-08-02");
    expect(snapshot.pulse).toBe(75);
    expect(snapshot.fetchError).toBeUndefined();
  });

  it("returns null pulse when RescueTime is not configured", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const service = new RescueTimeGoalsService(repository);
    const snapshot = await service.computeProductivityPulse("2026-08-02");

    expect(snapshot.rescuetimeConfigured).toBe(false);
    expect(snapshot.pulse).toBeNull();
  });
});
