import { createEmptyAnnualGoal } from "../../../domain/annual-goals";
import type { AiProposal, Task } from "../../../domain/types";
import * as dateModule from "../../date";
import { MemoryRepository } from "../../storage/memory-repository";
import { applyCoachProposal } from "./apply-proposal";

const now = "2026-08-29T12:00:00.000Z";

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
  source: "manual",
  sourceExternalId: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe("applyCoachProposal gtd_action", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules a task for today", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-29");

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveTask(buildTask({ id: "task-schedule" }));

    const proposal: AiProposal = {
      id: "proposal-gtd",
      messageId: "message-gtd",
      type: "gtd_action",
      payloadJson: JSON.stringify({
        taskId: "task-schedule",
        action: "schedule",
        reason: "Planifier",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: now,
    };

    const applied = await applyCoachProposal(repository, proposal, "2026-08-02");

    expect(applied.taskId).toBe("task-schedule");
    const tasks = await repository.listTasks({ includeCompleted: true });
    expect(tasks.find((task) => task.id === "task-schedule")?.scheduledFor).toBe("2026-08-29");
  });

  it("returns no taskId when the task is missing", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const proposal: AiProposal = {
      id: "proposal-gtd-missing",
      messageId: "message-gtd",
      type: "gtd_action",
      payloadJson: JSON.stringify({
        taskId: "task-missing",
        action: "schedule",
        reason: "Planifier",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: now,
    };

    const applied = await applyCoachProposal(repository, proposal, "2026-08-02");

    expect(applied.taskId).toBeUndefined();
  });

  it("does not mutate completed tasks", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveTask(
      buildTask({
        id: "task-completed",
        status: "completed",
        completedAt: now,
        bucket: "next_action",
      }),
    );

    const proposal: AiProposal = {
      id: "proposal-gtd-completed",
      messageId: "message-gtd",
      type: "gtd_action",
      payloadJson: JSON.stringify({
        taskId: "task-completed",
        action: "drop",
        reason: "Stale",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: now,
    };

    const applied = await applyCoachProposal(repository, proposal, "2026-08-02");
    expect(applied.taskId).toBeUndefined();
    const tasks = await repository.listTasks({ includeCompleted: true });
    expect(tasks.find((task) => task.id === "task-completed")?.status).toBe("completed");
  });
});

describe("applyCoachProposal goal_evaluation", () => {
  it("writes an annual goal evaluation for the month", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({ id: "goal-annual", title: "Test goal" }),
    );

    const goals = await repository.listAnnualGoals();
    const goal = goals[0];

    const proposal: AiProposal = {
      id: "proposal-goal-eval",
      messageId: "message-monthly",
      type: "goal_evaluation",
      payloadJson: JSON.stringify({
        goalId: goal.id,
        monthKey: "2026-04",
        score: 82,
        trend: "up",
        notes: "Bon mois",
        blockers: "Fatigue en fin de mois",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: now,
    };

    const applied = await applyCoachProposal(repository, proposal, "2026-04");

    expect(applied.goalId).toBe(goal.id);
    expect(applied.monthKey).toBe("2026-04");
    const saved = (await repository.listAnnualGoals()).find((item) => item.id === goal.id);
    expect(saved?.evaluations["2026-04"]).toMatchObject({
      score: 82,
      trend: "up",
      notes: "Bon mois",
      blockers: "Fatigue en fin de mois",
    });
  });
});
