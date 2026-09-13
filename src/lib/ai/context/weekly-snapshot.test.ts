import { afterEach, vi } from "vitest";
import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import { buildWeekDates } from "../../../domain/weekly-review";
import type { Project, Task } from "../../../domain/types";
import { MemoryRepository } from "../../storage/memory-repository";
import {
  buildWeeklySnapshot,
  resolveWeeklySnapshotInputs,
  type WeeklySnapshotInputs,
} from "./weekly-snapshot";

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

const now = "2026-08-08T12:00:00.000Z";

const buildTask = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? "task:default",
  title: "Tache",
  notes: "",
  status: "active",
  bucket: "next_action",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "manual",
  sourceExternalId: null,
  sourceUrl: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const buildProject = (overrides: Partial<Project>): Project => ({
  id: overrides.id ?? "project:default",
  title: "Projet",
  status: "active",
  statusChangedAt: now,
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const buildWeeklyInputs = (overrides: Partial<WeeklySnapshotInputs>): WeeklySnapshotInputs => {
  const weekStartDate = buildWeekDates("2026-08-02");

  return {
    weekStartDate,
    summary: {
      weekStartDate,
      weekEndDate: "2026-08-08",
      sleepAverage: 80,
      sleepQuality: 80,
      trcDaysRespected: 5,
      respectTrc: (5 / 7) * 100,
      screenTimeTotalMinutes: 700,
      phoneScreenTime: 90,
      pomodorisTotal: 20,
      pomodoris: 70,
      disciplineAverage: 0.8,
      discipline: 80,
      tasksAddedTotal: 10,
      tasksCompletedTotal: 8,
      tasksCompletionRate: 80,
      calorieAverage: 3000,
      physicalActivity: 78,
      productivityPulse: null,
      rescueTimeGoalsScore: null,
      weeklyScore: 0.75,
      days: [],
    },
    weekEntries: [],
    historyEntries: [],
    review: null,
    tasks: [],
    projects: [],
    pomodoroTaskSummaries: [],
    completedFocusSessionCount: 0,
    productivityPulse: null,
    rescueTimeGoalsScore: null,
    rescueTimeGoalItems: [],
    rescuetimeConfigured: false,
    now,
    ...overrides,
  };
};

describe("buildWeeklySnapshot", () => {
  it("names the stale next action in gtd.staleNextActionsSample at full scope", () => {
    const staleTask = buildTask({
      id: "task-stale",
      title: "Relancer le fournisseur",
      bucket: "next_action",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const inputs = buildWeeklyInputs({ tasks: [staleTask] });

    const snapshot = buildWeeklySnapshot(inputs, "full");

    expect(snapshot.gtd.staleNextActionsSample).toEqual([
      { id: "task-stale", title: "Relancer le fournisseur" },
    ]);
  });

  it("omits the task title below metrics_and_structure scope", () => {
    const staleTask = buildTask({
      id: "task-stale",
      title: "Relancer le fournisseur",
      bucket: "next_action",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const inputs = buildWeeklyInputs({ tasks: [staleTask] });

    const snapshot = buildWeeklySnapshot(inputs, "metrics");

    expect(snapshot.gtd.staleNextActionsSample).toEqual([{ id: "task-stale" }]);
  });

  it("passes RescueTime goal items through to the snapshot at full scope", () => {
    const inputs = buildWeeklyInputs({
      rescueTimeGoalItems: [
        {
          goalId: 1,
          title: "Deep work",
          isMore: true,
          actualHours: 3,
          weeklyTargetHours: 10,
          achievement: 0.3,
          scheduleLabel: "Working days",
        },
      ],
    });

    const snapshot = buildWeeklySnapshot(inputs, "full");

    expect(snapshot.rescueTimeGoals).toEqual([
      { title: "Deep work", isMore: true, actualHours: 3, weeklyTargetHours: 10, achievement: 0.3 },
    ]);
  });

  it("does not report dispersion when the top focus time is spread across one project", () => {
    const project = buildProject({ id: "project-1", title: "Refonte site" });
    const inputs = buildWeeklyInputs({
      projects: [project],
      pomodoroTaskSummaries: Array.from({ length: 10 }, (_, index) => ({
        taskId: `task-${index}`,
        taskTitle: `Tache ${index}`,
        projectId: "project-1",
        totalSeconds: 300,
        sessionCount: 1,
      })),
    });

    const snapshot = buildWeeklySnapshot(inputs, "full");

    expect(snapshot.focus.taskConcentration).toBeCloseTo(1);
    expect(snapshot.focus.topTask).toMatchObject({ taskId: null, title: "Refonte site" });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
