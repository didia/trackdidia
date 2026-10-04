import type { Task } from "../../domain/types";
import { createTaskFromInput } from "./engine";
import {
  hasContext,
  hasScheduledDate,
  selectTasksForBucketNormalization,
} from "./bucket-normalization";

const task = (overrides: Partial<Task> = {}): Task => ({
  ...createTaskFromInput({ title: "t", bucket: "inbox", contextIds: [] }),
  ...overrides,
});

const NOW = "2026-10-03T12:00:00.000Z";

describe("selectTasksForBucketNormalization", () => {
  it("selects active tasks with the context that are not already in the bucket", () => {
    const tasks = [
      task({ id: "match", contextIds: ["context:reading"], bucket: "next_action" }),
      task({ id: "already", contextIds: ["context:reading"], bucket: "reference" }),
      task({ id: "other", contextIds: ["context:other"] }),
      task({ id: "done", contextIds: ["context:reading"], status: "completed" }),
      task({ id: "cancelled", contextIds: ["context:reading"], status: "cancelled" }),
    ];

    const updates = selectTasksForBucketNormalization(
      tasks,
      hasContext("context:reading"),
      "reference",
      NOW,
    );

    expect(updates.map((update) => update.id)).toEqual(["match"]);
    expect(updates[0]).toMatchObject({ bucket: "reference", updatedAt: NOW });
  });

  it("selects tasks with a scheduled date and leaves date and order untouched", () => {
    const tasks = [
      task({ id: "dated", scheduledFor: "2026-10-05", bucket: "next_action", plannedOrder: 2 }),
      task({ id: "undated" }),
    ];

    const updates = selectTasksForBucketNormalization(tasks, hasScheduledDate, "scheduled", NOW);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "dated",
      bucket: "scheduled",
      scheduledFor: "2026-10-05",
      plannedOrder: 2,
    });
  });

  it("does not mutate the input tasks and accepts any iterable", () => {
    const original = task({ id: "a", scheduledFor: "2026-10-05", contextIds: ["context:x"] });
    const updates = selectTasksForBucketNormalization(
      new Map([[original.id, original]]).values(),
      hasScheduledDate,
      "scheduled",
      NOW,
    );

    expect(original.bucket).toBe("inbox");
    expect(updates[0]).not.toBe(original);
    expect(updates[0].contextIds).not.toBe(original.contextIds);
  });

  it("returns an empty plan when nothing matches", () => {
    expect(selectTasksForBucketNormalization([task()], hasScheduledDate, "scheduled", NOW)).toEqual(
      [],
    );
  });
});
