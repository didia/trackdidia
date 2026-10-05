import type { Task } from "../../domain/types";
import { createTaskFromInput } from "./engine";
import { applyScheduleChange } from "./schedule";

const task = (overrides: Partial<Task> = {}): Task => ({
  ...createTaskFromInput({ title: "t", bucket: "inbox", contextIds: ["context:a"] }),
  ...overrides,
});

describe("applyScheduleChange", () => {
  it("moves a non-planned task to Scheduled when a date is set", () => {
    for (const bucket of ["inbox", "next_action", "waiting_for", "scheduled"] as const) {
      expect(applyScheduleChange(task({ bucket }), "2026-10-05")).toMatchObject({
        bucket: "scheduled",
        scheduledFor: "2026-10-05",
      });
    }
  });

  it("sends a Scheduled task back to Next Actions when the date is cleared", () => {
    expect(
      applyScheduleChange(task({ bucket: "scheduled", scheduledFor: "2026-10-05" }), null),
    ).toMatchObject({ bucket: "next_action", scheduledFor: null });
  });

  it("leaves other buckets unchanged when the date is cleared", () => {
    expect(
      applyScheduleChange(task({ bucket: "waiting_for", scheduledFor: "2026-10-05" }), null),
    ).toMatchObject({ bucket: "waiting_for", scheduledFor: null });
  });

  it("keeps an active planned task planned for set and clear", () => {
    const planned = task({ bucket: "planned", projectId: "project:1" });
    expect(applyScheduleChange(planned, "2026-10-05")).toMatchObject({
      bucket: "planned",
      scheduledFor: "2026-10-05",
    });
    expect(applyScheduleChange({ ...planned, scheduledFor: "2026-10-05" }, null)).toMatchObject({
      bucket: "planned",
      scheduledFor: null,
    });
  });

  it("does not exempt a non-active planned task from the date rule", () => {
    expect(
      applyScheduleChange(task({ bucket: "planned", status: "completed" }), "2026-10-05"),
    ).toMatchObject({ bucket: "scheduled" });
  });

  it("does not mutate its input or change unrelated fields", () => {
    const original = task({ bucket: "inbox", notes: "keep" });
    const next = applyScheduleChange(original, "2026-10-05");
    expect(original.bucket).toBe("inbox");
    expect(original.scheduledFor).toBeNull();
    expect(next).toMatchObject({
      notes: "keep",
      contextIds: ["context:a"],
      updatedAt: original.updatedAt,
    });
  });
});
