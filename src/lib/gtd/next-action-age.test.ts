import type { TaskEvent } from "../../domain/types";
import { nextActionAgeDays } from "./next-action-age";

const event = (overrides: Partial<TaskEvent>): TaskEvent => ({
  id: "task-event:1",
  taskId: "task:1",
  type: "task_moved_to_next_action",
  eventDate: "2026-09-09",
  eventAt: "2026-09-09T16:00:00.000Z",
  createdAt: "2026-09-09T16:00:00.000Z",
  dedupeKey: null,
  metadata: {},
  ...overrides,
});

describe("nextActionAgeDays", () => {
  it("counts local calendar days since the latest move-to-next-action event", () => {
    expect(
      nextActionAgeDays(
        { id: "task:1", createdAt: "2026-01-01T00:00:00.000Z" },
        [
          event({ eventAt: "2026-09-01T12:00:00.000Z" }),
          event({ id: "task-event:2", eventAt: "2026-09-09T16:00:00.000Z" }),
        ],
        "2026-09-11",
      ),
    ).toBe(2);
  });

  it("falls back to createdAt when the task has no next-action event", () => {
    expect(
      nextActionAgeDays(
        { id: "task:1", createdAt: "2026-09-08T14:00:00.000Z" },
        [event({ taskId: "task:other" })],
        "2026-09-11",
      ),
    ).toBe(3);
  });

  it("returns 0 when the task entered next actions today", () => {
    expect(
      nextActionAgeDays(
        { id: "task:1", createdAt: "2026-09-11T10:00:00.000Z" },
        [event({ eventAt: "2026-09-11T14:00:00.000Z" })],
        "2026-09-11",
      ),
    ).toBe(0);
  });
});
