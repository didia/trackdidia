import { describe, expect, it } from "vitest";
import type { Task } from "../../domain/types";
import { planBulkBucketMove } from "./bulk-move";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Task",
  notes: "",
  bucket: "inbox",
  status: "active",
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
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("planBulkBucketMove", () => {
  it("skips unknown ids", () => {
    const plan = planBulkBucketMove([makeTask()], ["missing"], "next_action");
    expect(plan).toEqual({ updates: [], skippedCount: 1 });
  });

  it("skips scheduled moves for tasks without a date", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", scheduledFor: "2026-09-30" })];
    const plan = planBulkBucketMove(tasks, ["a", "b"], "scheduled");
    expect(plan.skippedCount).toBe(1);
    expect(plan.updates.map((task) => task.id)).toEqual(["b"]);
    expect(plan.updates[0].scheduledFor).toBe("2026-09-30");
  });

  it("skips planned moves for tasks without a project", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b", projectId: "p1" })];
    const plan = planBulkBucketMove(tasks, ["a", "b"], "planned");
    expect(plan.skippedCount).toBe(1);
    expect(plan.updates.map((task) => task.id)).toEqual(["b"]);
  });

  it("keeps the date for planned and clears it for other buckets", () => {
    const task = makeTask({ projectId: "p1", scheduledFor: "2026-09-30" });
    expect(planBulkBucketMove([task], [task.id], "planned").updates[0].scheduledFor).toBe(
      "2026-09-30",
    );
    const cleared = planBulkBucketMove([task], [task.id], "next_action").updates[0];
    expect(cleared.bucket).toBe("next_action");
    expect(cleared.scheduledFor).toBeNull();
  });

  it("does not mutate inputs and preserves id order", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    const plan = planBulkBucketMove(tasks, ["b", "a"], "someday_maybe");
    expect(plan.updates.map((task) => task.id)).toEqual(["b", "a"]);
    expect(tasks[0].bucket).toBe("inbox");
  });
});
