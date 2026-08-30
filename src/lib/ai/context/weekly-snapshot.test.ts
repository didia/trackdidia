import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { resolveWeeklySnapshotInputs } from "./weekly-snapshot";

describe("resolveWeeklySnapshotInputs history boundary", () => {
  it("loads all seven week dates even when more than 180 newer entries exist globally", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekStart = "2026-01-04";
    const weekDates = ["2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10"];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 70;
      await repository.saveDailyEntry(entry);
    }

    for (let index = 0; index < 200; index += 1) {
      const date = `2026-07-${String((index % 28) + 1).padStart(2, "0")}`;
      await repository.saveDailyEntry(createEmptyDailyEntry(date));
    }

    const inputs = await resolveWeeklySnapshotInputs(repository, weekStart);

    expect(inputs.weekEntries).toHaveLength(7);
    expect(inputs.weekEntries.every((entry) => weekDates.includes(entry.date))).toBe(true);
    expect(inputs.historyEntries.every((entry) => entry.date <= "2026-01-10")).toBe(true);
    expect(inputs.historyEntries.some((entry) => entry.date === "2026-01-04")).toBe(true);
  });
});
