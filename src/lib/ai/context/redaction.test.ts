import { computeAnnualGoalMeasurement } from "../../../domain/annual-goal-measurement";
import { createEmptyAnnualGoal } from "../../../domain/annual-goals";
import { createEmptyDailyEntry, updateMetric, updatePrinciple } from "../../../domain/daily-entry";
import { buildWeekDates } from "../../../domain/weekly-review";
import type { AnnualGoalSnapshot, Project, Task } from "../../../domain/types";
import { buildDailySnapshot, type DailySnapshotInputs } from "./daily-snapshot";
import { buildGoalPacingSnapshot, type GoalPacingSnapshotInputs } from "./goal-pacing-snapshot";
import { buildMonthlySnapshot, type MonthlySnapshotInputs } from "./monthly-snapshot";
import { buildWeeklySnapshot, type WeeklySnapshotInputs } from "./weekly-snapshot";

/**
 * Recursively collects every value found under a `title` key anywhere in `value`, including
 * inside arrays and nested objects. Used to assert redaction by construction rather than by
 * checking one hand-picked field per surface.
 */
const collectTitleValues = (value: unknown, found: unknown[] = []): unknown[] => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTitleValues(item, found);
    }
    return found;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "title") {
        found.push(nested);
      }
      collectTitleValues(nested, found);
    }
  }

  return found;
};

const now = "2026-03-01T12:00:00.000Z";

const buildProject = (overrides: Partial<Project> = {}): Project => ({
  id: overrides.id ?? "project:secret",
  title: "Projet secret",
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

const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: overrides.id ?? "task:secret",
  title: "Tache secrete",
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

const buildDailyInputs = (): DailySnapshotInputs => {
  let entry = createEmptyDailyEntry("2026-03-01");
  entry = updateMetric(entry, "pomodoris", 4);
  entry = updatePrinciple(entry, "priereDuMatin", true);
  const projectWithoutNextAction = buildProject({ id: "project:without-next-action" });

  return {
    date: "2026-03-01",
    entry,
    historyEntries: [entry],
    tasks: [buildTask({ id: "task:next-action", bucket: "next_action" })],
    projects: [projectWithoutNextAction],
    pomodoroTaskSummaries: [
      {
        taskId: "task:top",
        taskTitle: "Tache la plus travaillee",
        projectId: null,
        totalSeconds: 1200,
        sessionCount: 2,
      },
    ],
    completedFocusSessionCount: 2,
    productivityPulseWeekToDate: 60,
    rescuetimeConfigured: true,
    now,
  };
};

const buildWeeklyInputs = (): WeeklySnapshotInputs => {
  const weekStartDate = buildWeekDates("2026-03-01");

  return {
    weekStartDate,
    summary: {
      weekStartDate,
      weekEndDate: "2026-03-07",
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
    tasks: [buildTask({ id: "task:stale", updatedAt: "2026-01-01T00:00:00.000Z" })],
    projects: [buildProject({ id: "project:without-next-action" })],
    pomodoroTaskSummaries: [
      {
        taskId: "task:top",
        taskTitle: "Tache la plus travaillee",
        projectId: null,
        totalSeconds: 1200,
        sessionCount: 2,
      },
    ],
    completedFocusSessionCount: 2,
    productivityPulse: null,
    rescueTimeGoalsScore: null,
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
    rescuetimeConfigured: true,
    now,
  };
};

const buildGoalSnapshot = (): AnnualGoalSnapshot => {
  const goal = createEmptyAnnualGoal({
    id: "goal:secret",
    title: "Objectif secret",
    targetValue: 100,
    unit: "%",
    status: "active",
    milestones: [{ id: "milestone:1", title: "Etape secrete", completedAt: null, sortOrder: 0 }],
  });
  const result = computeAnnualGoalMeasurement(
    goal,
    2026,
    "2026-06-15",
    { currentValue: 40, monthlyValues: [] },
    [],
  );

  return {
    goal,
    sourceType: "manual",
    sourceLabel: null,
    currentValue: result.currentValue,
    progressRatio: result.progressRatio,
    monthlyProgress: result.monthlyProgress,
    linkedWeeklyMetricLabels: [],
    linkedDailyHabitLabels: [],
    measurement: result.measurement,
  };
};

const buildMonthlyInputs = (): MonthlySnapshotInputs => ({
  monthKey: "2026-06",
  summary: {
    monthKey: "2026-06",
    monthStartDate: "2026-06-01",
    monthEndDate: "2026-06-30",
    daysTracked: 30,
    weeksCovered: 4,
    weeklyReviewsCompleted: 4,
    sleepAverage: 80,
    trcRate: 70,
    screenTimeTotalMinutes: 3000,
    pomodorisTotal: 80,
    disciplineAverage: 0.75,
    tasksCompletionRate: 80,
    weeklyScoreAverage: 0.7,
    weeks: [],
  },
  review: null,
  goalSnapshots: [buildGoalSnapshot()],
});

const buildGoalPacingInputs = (): GoalPacingSnapshotInputs => ({
  year: 2026,
  asOfDate: "2026-06-15",
  evaluationMonthKey: "2026-06",
  goalSnapshots: [buildGoalSnapshot()],
});

describe("redaction: metrics scope never leaks a title", () => {
  it("daily snapshot has no title anywhere at scope metrics", () => {
    const snapshot = buildDailySnapshot(buildDailyInputs(), "metrics");
    expect(collectTitleValues(snapshot)).toEqual([]);
  });

  it("weekly snapshot has no title anywhere at scope metrics", () => {
    const snapshot = buildWeeklySnapshot(buildWeeklyInputs(), "metrics");
    expect(collectTitleValues(snapshot)).toEqual([]);
    // rescueTimeGoals itself is gated on includeStructure, but confirm it doesn't smuggle titles either way.
    expect(snapshot.rescueTimeGoals).toEqual([]);
  });

  it("monthly snapshot has no title anywhere at scope metrics", () => {
    const snapshot = buildMonthlySnapshot(buildMonthlyInputs(), "metrics");
    expect(collectTitleValues(snapshot)).toEqual([]);
  });

  it("goal pacing snapshot has no title anywhere at scope metrics", () => {
    const snapshot = buildGoalPacingSnapshot(buildGoalPacingInputs(), "metrics");
    expect(collectTitleValues(snapshot)).toEqual([]);
  });

  it("sanity check: the fixtures do carry titles at full scope, proving the walker isn't vacuous", () => {
    expect(
      collectTitleValues(buildDailySnapshot(buildDailyInputs(), "full")).length,
    ).toBeGreaterThan(0);
    expect(
      collectTitleValues(buildWeeklySnapshot(buildWeeklyInputs(), "full")).length,
    ).toBeGreaterThan(0);
    expect(
      collectTitleValues(buildMonthlySnapshot(buildMonthlyInputs(), "full")).length,
    ).toBeGreaterThan(0);
    expect(
      collectTitleValues(buildGoalPacingSnapshot(buildGoalPacingInputs(), "full")).length,
    ).toBeGreaterThan(0);
  });
});
