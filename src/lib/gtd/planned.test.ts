import { describe, expect, it } from "vitest";
import type { Project, Task } from "../../domain/types";
import {
  activePlannedTasksForProject,
  adjustPlannedFieldsForSave,
  compactPlannedOrders,
  countActiveNextActions,
  nextPlannedOrder,
  reconcileProjectPlannedTasks,
  sortedActivePlannedTasks,
  swapPlannedOrder,
} from "./planned";

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: overrides.id ?? "task:1",
  title: overrides.title ?? "Task",
  notes: "",
  status: overrides.status ?? "active",
  bucket: overrides.bucket ?? "planned",
  contextIds: [],
  projectId: overrides.projectId === undefined ? "project:1" : overrides.projectId,
  parentTaskId: null,
  scheduledFor: overrides.scheduledFor ?? null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: overrides.plannedOrder === undefined ? 0 : overrides.plannedOrder,
  source: "manual",
  sourceExternalId: null,
  createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const baseProject = (overrides: Partial<Project> = {}): Project => ({
  id: overrides.id ?? "project:1",
  title: overrides.title ?? "Project",
  status: overrides.status ?? "active",
  statusChangedAt: "2026-01-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("gtd/planned ordering", () => {
  it("selects only active planned tasks for a project", () => {
    const tasks = [
      baseTask({ id: "a", plannedOrder: 0 }),
      baseTask({ id: "b", status: "completed", plannedOrder: 1 }),
      baseTask({ id: "c", projectId: "project:2", plannedOrder: 0 }),
      baseTask({ id: "d", bucket: "next_action", plannedOrder: null }),
    ];

    expect(activePlannedTasksForProject(tasks, "project:1").map((task) => task.id)).toEqual(["a"]);
  });

  it("sorts by plannedOrder, then createdAt, then id as a deterministic tie-break", () => {
    const tasks = [
      baseTask({ id: "z", plannedOrder: null, createdAt: "2026-01-01T00:00:00.000Z" }),
      baseTask({ id: "a", plannedOrder: null, createdAt: "2026-01-01T00:00:00.000Z" }),
      baseTask({ id: "b", plannedOrder: 0, createdAt: "2026-01-02T00:00:00.000Z" }),
    ];

    expect(sortedActivePlannedTasks(tasks, "project:1").map((task) => task.id)).toEqual([
      "b",
      "a",
      "z",
    ]);
  });

  it("appends after the largest active planned order", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 3 })];
    expect(nextPlannedOrder(tasks, "project:1")).toBe(4);
    expect(nextPlannedOrder([], "project:1")).toBe(0);
  });

  it("excludes the task itself when computing the next order for a project switch", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 1 })];
    expect(nextPlannedOrder(tasks, "project:1", "b")).toBe(1);
  });

  it("compacts active planned tasks to a contiguous 0..n-1 order", () => {
    const tasks = [
      baseTask({ id: "a", plannedOrder: 5 }),
      baseTask({ id: "b", plannedOrder: 2 }),
      baseTask({ id: "c", status: "cancelled", plannedOrder: 0 }),
    ];

    const changed = compactPlannedOrders(tasks, "project:1");
    expect(changed.map((task) => [task.id, task.plannedOrder])).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
  });

  it("counts only active next_action tasks for the project", () => {
    const tasks = [
      baseTask({ id: "a", bucket: "next_action" }),
      baseTask({ id: "b", bucket: "next_action", status: "completed" }),
      baseTask({ id: "c", bucket: "next_action", projectId: "project:2" }),
    ];
    expect(countActiveNextActions(tasks, "project:1")).toBe(1);
  });
});

describe("adjustPlannedFieldsForSave", () => {
  it("requires a project to enter the planned bucket", () => {
    expect(() => adjustPlannedFieldsForSave(null, baseTask({ projectId: null }), [])).toThrow();
  });

  it("assigns the next order when a task freshly enters planned", () => {
    const existing = [baseTask({ id: "a", plannedOrder: 0 })];
    const result = adjustPlannedFieldsForSave(
      null,
      baseTask({ id: "b", plannedOrder: 999 }),
      existing,
    );
    expect(result.plannedOrder).toBe(1);
  });

  it("retains position when editing a planned task without changing its project", () => {
    const previous = baseTask({ id: "a", plannedOrder: 2 });
    const requested = { ...previous, title: "Updated", plannedOrder: 999 };
    const result = adjustPlannedFieldsForSave(previous, requested, [previous]);
    expect(result.plannedOrder).toBe(2);
  });

  it("re-appends at the destination when a planned task switches projects", () => {
    const previous = baseTask({ id: "a", projectId: "project:1", plannedOrder: 0 });
    const destinationSibling = baseTask({ id: "b", projectId: "project:2", plannedOrder: 0 });
    const requested = { ...previous, projectId: "project:2" };
    const result = adjustPlannedFieldsForSave(previous, requested, [previous, destinationSibling]);
    expect(result.plannedOrder).toBe(1);
  });

  it("retains scheduledFor and clears plannedOrder for Planned -> Scheduled", () => {
    const previous = baseTask({
      id: "a",
      plannedOrder: 4,
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });
    const requested = { ...previous, bucket: "scheduled" as const };
    const result = adjustPlannedFieldsForSave(previous, requested, [previous]);
    expect(result.scheduledFor).toBe("2026-05-01T09:00:00.000Z");
    expect(result.plannedOrder).toBeNull();
  });

  it("clears both scheduledFor and plannedOrder for every other Planned -> exit", () => {
    const previous = baseTask({
      id: "a",
      plannedOrder: 4,
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });
    for (const bucket of [
      "next_action",
      "inbox",
      "waiting_for",
      "someday_maybe",
      "reference",
    ] as const) {
      const requested = { ...previous, bucket };
      const result = adjustPlannedFieldsForSave(previous, requested, [previous]);
      expect(result.scheduledFor).toBeNull();
      expect(result.plannedOrder).toBeNull();
    }
  });

  it("retains scheduledFor and order for a completed/cancelled task that stays planned", () => {
    const previous = baseTask({
      id: "a",
      plannedOrder: 3,
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });
    const requested = {
      ...previous,
      status: "completed" as const,
      completedAt: "2026-05-02T00:00:00.000Z",
    };
    const result = adjustPlannedFieldsForSave(previous, requested, [previous]);
    expect(result.scheduledFor).toBe("2026-05-01T09:00:00.000Z");
    expect(result.plannedOrder).toBe(3);
  });
});

describe("reconcileProjectPlannedTasks", () => {
  it("promotes exactly one earliest task when the project has zero active next actions", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 1 })];
    const outcome = reconcileProjectPlannedTasks(tasks, baseProject(), "2026-01-02T00:00:00.000Z");
    expect(outcome.promotedTaskId).toBe("a");
    const promoted = outcome.updatedTasks.find((task) => task.id === "a")!;
    expect(promoted.bucket).toBe("next_action");
    expect(promoted.scheduledFor).toBeNull();
    expect(promoted.plannedOrder).toBeNull();
    const remaining = outcome.updatedTasks.find((task) => task.id === "b")!;
    expect(remaining.plannedOrder).toBe(0);
  });

  it("does not promote when the project already has an active next action", () => {
    const tasks = [
      baseTask({ id: "a", bucket: "next_action", plannedOrder: null }),
      baseTask({ id: "b", plannedOrder: 0 }),
    ];
    const outcome = reconcileProjectPlannedTasks(tasks, baseProject(), "2026-01-02T00:00:00.000Z");
    expect(outcome.promotedTaskId).toBeNull();
    expect(outcome.updatedTasks).toHaveLength(0);
  });

  it("never promotes for an inactive project", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 })];
    const outcome = reconcileProjectPlannedTasks(
      tasks,
      baseProject({ status: "on_hold" }),
      "2026-01-02T00:00:00.000Z",
    );
    expect(outcome.promotedTaskId).toBeNull();
  });

  it("is idempotent: a repeated call after promotion does not promote a second task", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 1 })];
    const first = reconcileProjectPlannedTasks(tasks, baseProject(), "2026-01-02T00:00:00.000Z");
    const afterFirst = tasks.map(
      (task) => first.updatedTasks.find((u) => u.id === task.id) ?? task,
    );
    const second = reconcileProjectPlannedTasks(
      afterFirst,
      baseProject(),
      "2026-01-02T00:00:00.000Z",
    );
    expect(second.promotedTaskId).toBeNull();
  });

  it("is unaffected by past, today, or future planned dates", () => {
    for (const scheduledFor of [
      "2020-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
      "2099-01-01T09:00:00.000Z",
    ]) {
      const tasks = [baseTask({ id: "a", plannedOrder: 0, scheduledFor })];
      const outcome = reconcileProjectPlannedTasks(
        tasks,
        baseProject(),
        "2026-01-02T00:00:00.000Z",
      );
      expect(outcome.promotedTaskId).toBe("a");
    }
  });
});

describe("swapPlannedOrder", () => {
  it("swaps a task with its adjacent active sibling", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 1 })];
    const updates = swapPlannedOrder(tasks, "b", "up", "2026-01-02T00:00:00.000Z")!;
    expect(updates.find((task) => task.id === "a")?.plannedOrder).toBe(1);
    expect(updates.find((task) => task.id === "b")?.plannedOrder).toBe(0);
  });

  it("is a harmless no-op at the first/last boundary", () => {
    const tasks = [baseTask({ id: "a", plannedOrder: 0 }), baseTask({ id: "b", plannedOrder: 1 })];
    expect(swapPlannedOrder(tasks, "a", "up", "2026-01-02T00:00:00.000Z")).toEqual([]);
    expect(swapPlannedOrder(tasks, "b", "down", "2026-01-02T00:00:00.000Z")).toEqual([]);
  });

  it("rejects a task that is not an active planned task with a project", () => {
    const tasks = [baseTask({ id: "a", bucket: "next_action" })];
    expect(swapPlannedOrder(tasks, "a", "up", "2026-01-02T00:00:00.000Z")).toBeNull();
  });

  it("never crosses projects: siblings come only from the same project", () => {
    const tasks = [
      baseTask({ id: "a", projectId: "project:1", plannedOrder: 0 }),
      baseTask({ id: "b", projectId: "project:2", plannedOrder: 0 }),
    ];
    expect(swapPlannedOrder(tasks, "a", "down", "2026-01-02T00:00:00.000Z")).toEqual([]);
  });
});
