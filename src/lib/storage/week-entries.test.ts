import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { MemoryRepository } from "./memory-repository";
import { loadDecoratedWeekEntries } from "./week-entries";

describe("loadDecoratedWeekEntries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns seven entries, filling days without a row with empty entries", async () => {
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
    expect(entries.every((entry) => entry.suggestedMetrics === undefined)).toBe(true);
  });

  it("applies suggested pomodoro and task metrics from real sessions and task events", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 3, 9, 0, 0)); // Monday 2026-08-03
    const task = await repository.createTask({ title: "Rédiger", bucket: "next_action" });
    await repository.completeTask(task.id);
    const started = await repository.startPomodoro({ taskId: null, title: "Focus" });
    const session = started.activeSession;
    if (!session) {
      throw new Error("Session Pomodoro manquante");
    }
    await repository.stopPomodoroSession(
      session.id,
      "completed",
      new Date(new Date(session.startedAt).getTime() + 25 * 60 * 1000).toISOString(),
    );
    vi.useRealTimers();
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-03"));

    const entries = await loadDecoratedWeekEntries(repository, "2026-08-02");

    expect(entries[1].suggestedMetrics).toMatchObject({
      pomodoris: 1,
      tachesAjoutes: 1,
      tachesRealises: 1,
    });
    // A day with no entry row stays undecorated.
    expect(entries[2].suggestedMetrics).toBeUndefined();
  });
});
