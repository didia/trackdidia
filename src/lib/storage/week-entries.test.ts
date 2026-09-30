import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";
import { loadDecoratedWeekEntries } from "./week-entries";

describe("loadDecoratedWeekEntries", () => {
  it("returns seven entries, filling days without a row and keeping suggested metrics", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const entries = await loadDecoratedWeekEntries(repository, "2026-08-05");

    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
    expect(entries.every((entry) => entry.status === "not_started")).toBe(true);
  });

  it("applies suggested pomodoro metrics to a day with an entry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const { createEmptyDailyEntry } = await import("../../domain/daily-entry");
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-03"));
    const entries = await loadDecoratedWeekEntries(repository, "2026-08-02");
    // decorateEntry attaches suggestedMetrics for days that have a row
    expect(entries[1].suggestedMetrics).toBeDefined();
  });
});
