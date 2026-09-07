import { afterEach, vi } from "vitest";
import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { resolveWeeklySnapshotInputs } from "./weekly-snapshot";

describe("resolveWeeklySnapshotInputs history boundary", () => {
  it("loads all seven week dates even when more than 180 newer entries exist globally", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekStart = "2026-01-04";
    const weekDates = [
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ];

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

  it("defaults now to a day-stable local noon instead of the wall clock", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStart = "2026-08-02";

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 9, 15, 30, 123));
    const first = await resolveWeeklySnapshotInputs(repository, weekStart);

    vi.setSystemTime(new Date(2026, 7, 8, 18, 45, 1, 999));
    const second = await resolveWeeklySnapshotInputs(repository, weekStart);

    expect(first.now).toBe("2026-08-08T12:00:00");
    expect(second.now).toBe(first.now);

    vi.setSystemTime(new Date(2026, 7, 9, 8, 0, 0));
    const afterWeekEnd = await resolveWeeklySnapshotInputs(repository, weekStart);
    expect(afterWeekEnd.now).toBe("2026-08-08T12:00:00");
  });

  it("advances now across calendar days while the week is still in progress", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStart = "2026-08-02";

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 5, 9, 0, 0));
    const wednesday = await resolveWeeklySnapshotInputs(repository, weekStart);
    vi.setSystemTime(new Date(2026, 7, 6, 9, 0, 0));
    const thursday = await resolveWeeklySnapshotInputs(repository, weekStart);

    expect(wednesday.now).toBe("2026-08-05T12:00:00");
    expect(thursday.now).toBe("2026-08-06T12:00:00");
  });

  it("bounds pomodoro summaries per calendar day instead of pinning every day to noon", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const spy = vi.spyOn(repository, "listPomodoroTaskSummaries");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 5, 16, 0, 0));
    await resolveWeeklySnapshotInputs(repository, "2026-08-02");

    expect(spy).toHaveBeenCalledWith("2026-08-02", "2026-08-02T23:59:59");
    expect(spy).toHaveBeenCalledWith("2026-08-05", new Date().toISOString());
    expect(spy).toHaveBeenCalledWith("2026-08-06", "2026-08-06T00:00:00");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
