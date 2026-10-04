import type { Task } from "../../domain/types";
import { createTaskFromInput } from "./engine";
import { planGoogleRecurringCollapse } from "./google-recurring-collapse";

const task = (overrides: Partial<Task> = {}): Task => ({
  ...createTaskFromInput({ title: "t", bucket: "scheduled", contextIds: [] }),
  source: "google_import",
  ...overrides,
});

const NOW = "2026-10-03T12:00:00.000Z";

describe("planGoogleRecurringCollapse", () => {
  it("ignores desired tasks that are not recurring", () => {
    const plan = planGoogleRecurringCollapse(
      { tasks: [task({ id: "plain", recurrenceGroupId: null })], recurringSourceTaskIds: {} },
      [task({ id: "plain" })],
      NOW,
    );
    expect(plan).toEqual({ upserts: [], deleteIds: [] });
  });

  it("upserts the desired task and deletes duplicates found by group id and source id", () => {
    const desired = task({ id: "desired", recurrenceGroupId: "group:1", notes: "new" });
    const existing = [
      task({ id: "old-group", recurrenceGroupId: "group:1", notes: "  ", projectId: "project:1" }),
      task({ id: "old-source", sourceExternalId: "google:a", recurrenceGroupId: null }),
      task({ id: "unrelated", recurrenceGroupId: "group:2" }),
      task({ id: "manual", recurrenceGroupId: "group:1", source: "manual" }),
    ];

    const plan = planGoogleRecurringCollapse(
      { tasks: [desired], recurringSourceTaskIds: { desired: ["google:a"] } },
      existing,
      NOW,
    );

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      id: "desired",
      notes: "new",
      projectId: "project:1",
      updatedAt: NOW,
    });
    expect([...plan.deleteIds].sort()).toEqual(["old-group", "old-source"]);
  });

  it("keeps a non-blank existing note and prefers the existing row matching the desired id", () => {
    const desired = task({ id: "desired", recurrenceGroupId: "group:1", notes: "new" });
    const plan = planGoogleRecurringCollapse(
      { tasks: [desired], recurringSourceTaskIds: {} },
      [
        task({
          id: "other",
          recurrenceGroupId: "group:1",
          notes: "other note",
          projectId: "p:other",
        }),
        task({
          id: "desired",
          recurrenceGroupId: "group:1",
          notes: "kept note",
          projectId: "p:own",
        }),
      ],
      NOW,
    );

    expect(plan.upserts[0]).toMatchObject({ notes: "kept note", projectId: "p:own" });
    expect(plan.deleteIds).toEqual(["other"]);
  });

  it("falls back to the first match when the desired id does not exist yet", () => {
    const desired = task({ id: "desired", recurrenceGroupId: "group:1", notes: "new" });
    const plan = planGoogleRecurringCollapse(
      { tasks: [desired], recurringSourceTaskIds: {} },
      [task({ id: "first", recurrenceGroupId: "group:1", notes: "first note", projectId: "p:1" })],
      NOW,
    );

    expect(plan.upserts[0]).toMatchObject({ notes: "first note", projectId: "p:1" });
    expect(plan.deleteIds).toEqual(["first"]);
  });

  it("uses the desired values when nothing exists and never deletes the desired id", () => {
    const desired = task({ id: "desired", recurrenceGroupId: "group:1", notes: "new" });
    const plan = planGoogleRecurringCollapse(
      { tasks: [desired], recurringSourceTaskIds: {} },
      [],
      NOW,
    );

    expect(plan.upserts[0]).toMatchObject({ id: "desired", notes: "new", projectId: null });
    expect(plan.deleteIds).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const desired = task({ id: "desired", recurrenceGroupId: "group:1" });
    const existing = [task({ id: "old", recurrenceGroupId: "group:1" })];
    const snapshot = structuredClone({ desired, existing });

    planGoogleRecurringCollapse({ tasks: [desired], recurringSourceTaskIds: {} }, existing, NOW);

    expect({ desired, existing }).toEqual(snapshot);
  });
});
