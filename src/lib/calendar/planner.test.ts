import { describe, expect, it } from "vitest";
import type { CalendarSyncLink } from "../../domain/calendar-sync";
import type { Task } from "../../domain/types";
import { baseLink, baseSettings, baseTask } from "./calendar-sync-test-helpers";
import { buildCalendarSyncSignatureForTask } from "./eligibility";
import { planCalendarSync } from "./planner";

const today = "2026-01-12";
const now = "2026-01-12T14:00:00.000Z";
const settings = baseSettings();

const plan = (
  tasks: Task[],
  links: CalendarSyncLink[] = [],
  overrides: Partial<Parameters<typeof planCalendarSync>[0]> = {},
) => planCalendarSync({ tasks, links, today, now, settings, ...overrides });

/**
 * An unrelated, ineligible task used to keep `tasks` non-empty in tests that exercise an
 * orphan link, so the empty-task-set valve (which fires on a wholly empty task list) does
 * not mask the behavior under test.
 */
const unrelatedTask = (): Task =>
  baseTask({ id: "unrelated", bucket: "next_action", scheduledFor: null });

describe("planCalendarSync — eligibility -> create", () => {
  it("creates for a Scheduled task", () => {
    const task = baseTask({ bucket: "scheduled" });
    const result = plan([task]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0].taskId).toBe(task.id);
  });

  it("creates for a Planned task attached to a project", () => {
    const task = baseTask({ bucket: "planned", projectId: "project:1" });
    expect(plan([task]).creates).toHaveLength(1);
  });

  it("creates nothing for a Planned task without a project", () => {
    const task = baseTask({ bucket: "planned", projectId: null });
    expect(plan([task]).creates).toHaveLength(0);
  });

  it("creates nothing for a Next Action", () => {
    expect(plan([baseTask({ bucket: "next_action", scheduledFor: null })]).creates).toHaveLength(0);
  });

  it("creates nothing for a deadline-only task", () => {
    const task = baseTask({ bucket: "scheduled", scheduledFor: null, deadline: "2026-01-20" });
    expect(plan([task]).creates).toHaveLength(0);
  });
});

describe("planCalendarSync — update only on signature change", () => {
  it("no-ops when the signature is unchanged", () => {
    const task = baseTask();
    const link = baseLink(task, settings);
    const result = plan([task], [link]);
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("updates when the title changes", () => {
    const task = baseTask({ title: "New title" });
    const link = baseLink(baseTask({ title: "Old title" }), settings);
    const result = plan([task], [link]);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].eventId).toBe(link.eventId);
  });

  it("updates on a same-day time change (one update)", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T16:00:00" });
    const link = baseLink(baseTask({ scheduledFor: "2026-01-12T09:00:00" }), settings, {
      occurrenceKey: "2026-01-12",
    });
    const result = plan([task], [link]);
    expect(result.updates).toHaveLength(1);
    expect(result.deletes).toHaveLength(0);
  });

  it("no-ops across a Planned <-> Scheduled bucket change retaining scheduledFor", () => {
    const task = baseTask({ bucket: "planned", projectId: "project:1" });
    const link = baseLink(baseTask({ bucket: "scheduled" }), settings);
    const result = plan([task], [link]);
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });
});

describe("planCalendarSync — cross-day reschedule", () => {
  it("deletes the old event and creates the new one", () => {
    const task = baseTask({ scheduledFor: "2026-01-20T09:00:00" });
    const link = baseLink(task, settings, { occurrenceKey: "2026-01-12" });
    const result = plan([task], [link]);
    expect(result.deletes).toEqual([
      expect.objectContaining({
        occurrenceKey: "2026-01-12",
        eventId: link.eventId,
        reason: "reschedule",
      }),
    ]);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-20" })]);
  });

  it("deletes and recreates for an overdue Planned task re-dated to the future", () => {
    const task = baseTask({
      bucket: "planned",
      projectId: "project:1",
      scheduledFor: "2026-02-01T09:00:00",
    });
    const link = baseLink(task, settings, { occurrenceKey: "2026-01-01" });
    const result = plan([task], [link]);
    expect(result.deletes[0].reason).toBe("reschedule");
    expect(result.creates[0].occurrenceKey).toBe("2026-02-01");
  });

  it("deletes and recreates when a today task is moved to the future", () => {
    const task = baseTask({ scheduledFor: "2026-01-20T09:00:00" });
    const link = baseLink(task, settings, { occurrenceKey: today });
    const result = plan([task], [link]);
    expect(result.deletes[0].occurrenceKey).toBe(today);
    expect(result.creates[0].occurrenceKey).toBe("2026-01-20");
  });
});

describe("planCalendarSync — exit rule", () => {
  it("deletes a completed task's event dated tomorrow", () => {
    const task = baseTask({ status: "completed", scheduledFor: null });
    const link = baseLink(baseTask(), settings, { occurrenceKey: "2026-01-13" });
    const result = plan([task], [link]);
    expect(result.deletes).toEqual([
      expect.objectContaining({ occurrenceKey: "2026-01-13", reason: "exit" }),
    ]);
    expect(result.detaches).toHaveLength(0);
  });

  it("detaches a completed task's event dated today", () => {
    const task = baseTask({ status: "completed", scheduledFor: null });
    const link = baseLink(baseTask(), settings, { occurrenceKey: today });
    const result = plan([task], [link]);
    expect(result.detaches).toEqual([
      expect.objectContaining({ occurrenceKey: today, reason: "completed" }),
    ]);
    expect(result.deletes).toHaveLength(0);
  });

  it("deletes a cancelled task's future event and detaches today's", () => {
    const cancelledFuture = baseTask({ id: "a", status: "cancelled", scheduledFor: null });
    const linkFuture = baseLink(baseTask({ id: "a" }), settings, { occurrenceKey: "2026-01-13" });
    expect(plan([cancelledFuture], [linkFuture]).deletes[0].reason).toBe("exit");

    const cancelledToday = baseTask({ id: "b", status: "cancelled", scheduledFor: null });
    const linkToday = baseLink(baseTask({ id: "b" }), settings, { occurrenceKey: today });
    expect(plan([cancelledToday], [linkToday]).detaches[0].reason).toBe("cancelled");
  });

  it("deletes an unscheduled future link and detaches an unscheduled past link", () => {
    const futureTask = baseTask({ id: "a", bucket: "next_action", scheduledFor: null });
    const futureLink = baseLink(baseTask({ id: "a" }), settings, { occurrenceKey: "2026-01-13" });
    expect(plan([futureTask], [futureLink]).deletes[0].reason).toBe("exit");

    const pastTask = baseTask({ id: "b", bucket: "next_action", scheduledFor: null });
    const pastLink = baseLink(baseTask({ id: "b" }), settings, { occurrenceKey: "2026-01-01" });
    expect(plan([pastTask], [pastLink]).detaches[0].reason).toBe("unscheduled");
  });

  it("detaches an orphan link (task row deleted) with reason task_deleted", () => {
    const link = baseLink(baseTask({ id: "gone" }), settings, {
      occurrenceKey: today,
      taskId: "gone",
    });
    const result = plan([unrelatedTask()], [link]);
    expect(result.detaches).toEqual([expect.objectContaining({ reason: "task_deleted" })]);
  });
});

describe("planCalendarSync — promotion capture", () => {
  it("creates a pending link with no task row, then it would be detached by the reconciler", () => {
    const pendingTask = baseTask({ scheduledFor: "2026-01-12T09:00:00" });
    const { signature } = buildCalendarSyncSignatureForTask(pendingTask, settings);
    const link = baseLink(pendingTask, settings, {
      state: "pending",
      eventId: null,
      payloadSignature: signature,
      occurrenceKey: "2026-01-12",
      taskId: "task:gone",
    });
    const result = plan([unrelatedTask()], [link]);
    expect(result.creates).toEqual([
      expect.objectContaining({
        taskId: "task:gone",
        occurrenceKey: "2026-01-12",
        fromPendingSnapshot: true,
      }),
    ]);
    expect(result.deletes).toHaveLength(0);
  });

  it("deletes the old event and creates Friday's for a promoted task rescheduled (promoted today)", () => {
    const task = baseTask({ scheduledFor: "2026-01-16T09:00:00" }); // Friday
    const link = baseLink(task, settings, {
      state: "detached",
      detachReason: "promoted",
      occurrenceKey: today,
    });
    const result = plan([task], [link]);
    expect(result.deletes).toEqual([
      expect.objectContaining({ occurrenceKey: today, reason: "rescheduled_after_promotion" }),
    ]);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-16" })]);
  });

  it("deletes the old event and creates Friday's for a promoted task rescheduled (promoted last week)", () => {
    const task = baseTask({ scheduledFor: "2026-01-16T09:00:00" });
    const link = baseLink(task, settings, {
      state: "detached",
      detachReason: "promoted",
      occurrenceKey: "2026-01-05",
    });
    const result = plan([task], [link]);
    expect(result.deletes[0].reason).toBe("rescheduled_after_promotion");
    expect(result.creates[0].occurrenceKey).toBe("2026-01-16");
  });

  it("keeps the old event for a recurrence-generated task rescheduled after promotion", () => {
    const task = baseTask({ scheduledFor: "2026-01-16T09:00:00", isRecurringInstance: true });
    const link = baseLink(task, settings, {
      state: "detached",
      detachReason: "promoted",
      occurrenceKey: today,
    });
    const result = plan([task], [link]);
    expect(result.deletes).toHaveLength(0);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-16" })]);
  });

  it("PATCHes to the live payload when a pending link's task is re-dated later the same day", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T14:00:00", title: "Edited" });
    const link = baseLink(
      baseTask({ scheduledFor: "2026-01-12T09:00:00", title: "Original" }),
      settings,
      {
        state: "pending",
        eventId: null,
        occurrenceKey: "2026-01-12",
      },
    );
    const result = plan([task], [link]);
    expect(result.creates).toEqual([
      expect.objectContaining({ occurrenceKey: "2026-01-12", fromPendingSnapshot: false }),
    ]);
    expect(result.deletes).toHaveLength(0);
  });

  it("PATCHes to the live payload when a promoted-detached link's task is re-dated later the same day", () => {
    const task = baseTask({ scheduledFor: "2026-01-12T14:00:00", title: "Edited" });
    const link = baseLink(
      baseTask({ scheduledFor: "2026-01-12T09:00:00", title: "Original" }),
      settings,
      {
        state: "detached",
        detachReason: "promoted",
        occurrenceKey: "2026-01-12",
      },
    );
    const result = plan([task], [link]);
    expect(result.updates).toEqual([
      expect.objectContaining({ occurrenceKey: "2026-01-12", eventId: link.eventId }),
    ]);
    expect(result.deletes).toHaveLength(0);
  });

  it("drops a pending link K1 when the task is live under a different non-recurring key K2, no create-then-delete", () => {
    const task = baseTask({ id: "t1", scheduledFor: "2026-01-20T09:00:00" });
    const pendingLink = baseLink(baseTask({ id: "t1" }), settings, {
      state: "pending",
      eventId: null,
      occurrenceKey: "2026-01-12",
    });
    const result = plan([task], [pendingLink]);
    expect(result.purges).toEqual([{ taskId: "t1", occurrenceKey: "2026-01-12" }]);
    expect(result.deletes).toHaveLength(0);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-20" })]);
  });

  it("drops a pending link older than 7 days without creating", () => {
    const link = baseLink(baseTask({ id: "stale" }), settings, {
      state: "pending",
      eventId: null,
      occurrenceKey: "2026-01-01", // 11 days before today
      taskId: "stale",
    });
    const result = plan([unrelatedTask()], [link]);
    expect(result.creates).toHaveLength(0);
    expect(result.purges).toEqual([{ taskId: "stale", occurrenceKey: "2026-01-01" }]);
  });

  it("creates a pending link exactly at the 7-day cap", () => {
    const link = baseLink(baseTask({ id: "edge" }), settings, {
      state: "pending",
      eventId: null,
      occurrenceKey: "2026-01-05", // exactly 7 days before today
      taskId: "edge",
    });
    const result = plan([unrelatedTask()], [link]);
    expect(result.creates).toHaveLength(1);
    expect(result.purges).toHaveLength(0);
  });
});

describe("planCalendarSync — captured edits on an owned event", () => {
  const edited = baseTask({ scheduledFor: "2026-01-12T09:00:00", title: "Edited" });
  const pendingLink = (overrides: Partial<CalendarSyncLink> = {}): CalendarSyncLink =>
    baseLink(edited, settings, { state: "pending", eventId: "event:1", ...overrides });
  const promotedTask = (overrides: Partial<Task> = {}): Task =>
    baseTask({ bucket: "next_action", scheduledFor: null, title: "Edited", ...overrides });

  it("updates from the snapshot (not create) when the pending link owns an event", () => {
    const result = plan([promotedTask()], [pendingLink()]);
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toEqual([
      expect.objectContaining({
        eventId: "event:1",
        occurrenceKey: "2026-01-12",
        payloadSignature: pendingLink().payloadSignature,
        fromPendingSnapshot: true,
      }),
    ]);
  });

  it("detaches a stale pending link that owns an event as promoted instead of purging", () => {
    const stale = pendingLink({ occurrenceKey: "2026-01-01" });
    const result = plan([promotedTask()], [stale]);
    expect(result.purges).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
    expect(result.detaches).toEqual([
      { taskId: "task:1", occurrenceKey: "2026-01-01", reason: "promoted" },
    ]);
  });

  it("deletes the owned event when a pending link's task is re-dated to another day", () => {
    const redated = baseTask({ scheduledFor: "2026-01-16T09:00:00", title: "Edited" });
    const result = plan([redated], [pendingLink()]);
    expect(result.purges).toHaveLength(0);
    expect(result.deletes).toEqual([
      expect.objectContaining({
        occurrenceKey: "2026-01-12",
        eventId: "event:1",
        reason: "reschedule",
      }),
    ]);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-16" })]);
  });

  it("still PATCHes a same-key pending link whose snapshot equals the live signature", () => {
    const result = plan([edited], [pendingLink()]);
    expect(result.updates).toEqual([
      expect.objectContaining({ eventId: "event:1", fromPendingSnapshot: false }),
    ]);
  });

  it("keeps retrying a captured snapshot that failed (left pending with failure metadata)", () => {
    const retry = pendingLink({ eventId: null, failureCount: 3, lastError: "boom" });
    const result = plan([promotedTask()], [retry]);
    expect(result.detaches).toHaveLength(0);
    expect(result.creates).toEqual([
      expect.objectContaining({ occurrenceKey: "2026-01-12", fromPendingSnapshot: true }),
    ]);
  });

  it("re-dating after an unchanged-synced capture deletes the promoted placeholder", () => {
    const promotedLink = baseLink(edited, settings, {
      state: "detached",
      detachReason: "promoted",
    });
    const redated = baseTask({ scheduledFor: "2026-01-16T09:00:00", title: "Edited" });
    const result = plan([redated], [promotedLink]);
    expect(result.deletes).toEqual([
      expect.objectContaining({ eventId: "event:1", reason: "rescheduled_after_promotion" }),
    ]);
  });
});

describe("planCalendarSync — terminal links", () => {
  it("never deletes a completed-detached link via the reschedule exception", () => {
    const task = baseTask({ scheduledFor: "2026-01-20T09:00:00" });
    const link = baseLink(task, settings, {
      state: "detached",
      detachReason: "completed",
      occurrenceKey: today,
    });
    const result = plan([task], [link]);
    expect(result.deletes).toHaveLength(0);
    // The old (completed) key never re-syncs, but the new key still gets its own event.
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-20" })]);
  });

  it("never deletes a cancelled-detached link via the reschedule exception", () => {
    const task = baseTask({ scheduledFor: "2026-01-20T09:00:00" });
    const link = baseLink(task, settings, {
      state: "detached",
      detachReason: "cancelled",
      occurrenceKey: today,
    });
    expect(plan([task], [link]).deletes).toHaveLength(0);
  });

  it("never re-plans a detached link that stays at the same key", () => {
    const task = baseTask({ title: "Changed title" });
    const link = baseLink(baseTask({ title: "Original" }), settings, {
      state: "detached",
      detachReason: "completed",
    });
    const result = plan([task], [link]);
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });
});

describe("planCalendarSync — recurring templates", () => {
  it("creates three links for three occurrences and never patches past ones", () => {
    const tasks = [
      baseTask({ id: "r1", isRecurringInstance: true, scheduledFor: "2026-01-10T09:00:00" }),
    ];
    const links = [
      baseLink(tasks[0], settings, {
        occurrenceKey: "2026-01-08",
        state: "detached",
        detachReason: "promoted",
      }),
      baseLink(tasks[0], settings, {
        occurrenceKey: "2026-01-09",
        state: "detached",
        detachReason: "promoted",
      }),
    ];
    const result = plan(tasks, links);
    // Past occurrences (recurring) are never touched; only today's occurrence creates.
    expect(result.deletes).toHaveLength(0);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-10" })]);
    expect(result.updates).toHaveLength(0);
  });
});

describe("planCalendarSync — recurring occurrence advancement", () => {
  it("keeps the previous synced occurrence's event when generation reuses the task id", () => {
    const yesterday = baseTask({
      id: "r1",
      isRecurringInstance: true,
      scheduledFor: "2026-01-11T09:00:00",
    });
    const nextOccurrence = baseTask({
      id: "r1",
      isRecurringInstance: true,
      scheduledFor: "2026-01-12T09:00:00",
    });
    const link = baseLink(yesterday, settings, { occurrenceKey: "2026-01-11" });
    const result = plan([nextOccurrence], [link]);
    expect(result.deletes).toHaveLength(0);
    expect(result.detaches).toEqual([
      { taskId: "r1", occurrenceKey: "2026-01-11", reason: "promoted" },
    ]);
    expect(result.creates).toEqual([expect.objectContaining({ occurrenceKey: "2026-01-12" })]);
  });

  it("still deletes a recurring occurrence manually moved out of a future day", () => {
    const moved = baseTask({
      id: "r1",
      isRecurringInstance: true,
      scheduledFor: "2026-01-16T09:00:00",
    });
    const link = baseLink(moved, settings, { occurrenceKey: "2026-01-14" });
    const result = plan([moved], [link]);
    expect(result.deletes).toEqual([expect.objectContaining({ reason: "reschedule" })]);
  });
});

describe("planCalendarSync — overdue Planned stays synced", () => {
  it("does nothing for an overdue Planned task that is still synced", () => {
    const task = baseTask({
      bucket: "planned",
      projectId: "project:1",
      scheduledFor: "2026-01-01T09:00:00",
    });
    const link = baseLink(task, settings, { occurrenceKey: "2026-01-01" });
    const result = plan([task], [link]);
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
    expect(result.deletes).toHaveLength(0);
    expect(result.detaches).toHaveLength(0);
  });
});

describe("planCalendarSync — foreign generation purge", () => {
  it("purges a link from a prior generation without any remote action", () => {
    const task = baseTask();
    const link = baseLink(task, settings, { generation: settings.generation - 1 });
    const result = plan([task], [link]);
    expect(result.purges).toEqual([{ taskId: task.id, occurrenceKey: link.occurrenceKey }]);
    expect(result.deletes).toHaveLength(0);
    // The task is still desired, so it gets its own fresh link under the current generation.
    expect(result.creates).toEqual([
      expect.objectContaining({ occurrenceKey: link.occurrenceKey }),
    ]);
  });
});

describe("planCalendarSync — safety valves", () => {
  it("aborts with calendar_sync_empty_task_set when tasks is empty but links exist", () => {
    const link = baseLink(baseTask(), settings);
    const result = plan([], [link]);
    expect(result.abort).toEqual({
      reason: "empty_task_set",
      lastError: "calendar_sync_empty_task_set",
    });
    expect(result.creates).toHaveLength(0);
    expect(result.deletes).toHaveLength(0);
  });

  it("does nothing when deletes exist but tasks and links are both empty", () => {
    expect(plan([], [])).toEqual({
      creates: [],
      updates: [],
      deletes: [],
      detaches: [],
      purges: [],
    });
  });

  it("needs_confirmation when deletes exceed max(10, 25% of active links)", () => {
    const activeLinks: CalendarSyncLink[] = Array.from({ length: 20 }, (_, index) =>
      baseLink(baseTask({ id: `t${index}` }), settings, { occurrenceKey: "2026-01-13" }),
    );
    // 20 active links -> threshold max(10, 5) = 10; all 20 tasks are gone (future -> delete).
    const result = plan([unrelatedTask()], activeLinks);
    expect(result.abort?.reason).toBe("needs_confirmation");
    expect(result.abort?.deleteCount).toBe(20);
    expect(result.deletes).toHaveLength(0);
    expect(result.creates).toHaveLength(0);
  });

  it("compares against the unrounded 25% threshold (41 links: 10 deletes pass, 11 confirm)", () => {
    const kept = baseTask({ id: "kept", scheduledFor: "2026-01-12T15:00:00" });
    const build = (deleteCount: number) => {
      const keptLinks = Array.from({ length: 41 - deleteCount }, (_, index) =>
        baseLink(baseTask({ id: `k${index}` }), settings),
      );
      const gone = Array.from({ length: deleteCount }, (_, index) =>
        baseLink(baseTask({ id: `g${index}` }), settings, { occurrenceKey: "2026-01-13" }),
      );
      const tasks = [kept, ...keptLinks.map((link) => baseTask({ id: link.taskId }))];
      return plan(tasks, [...keptLinks, ...gone]);
    };
    expect(build(10).abort).toBeUndefined();
    expect(build(10).deletes).toHaveLength(10);
    expect(build(11).abort?.reason).toBe("needs_confirmation");
  });

  it("confirmMassDelete executes when the recomputed delete count is <= n", () => {
    const activeLinks: CalendarSyncLink[] = Array.from({ length: 20 }, (_, index) =>
      baseLink(baseTask({ id: `t${index}` }), settings, { occurrenceKey: "2026-01-13" }),
    );
    const result = plan([unrelatedTask()], activeLinks, { confirmedMassDelete: 20 });
    expect(result.abort).toBeUndefined();
    expect(result.deletes).toHaveLength(20);
  });

  it("confirmMassDelete re-trips when the recomputed count grew past n", () => {
    const activeLinks: CalendarSyncLink[] = Array.from({ length: 20 }, (_, index) =>
      baseLink(baseTask({ id: `t${index}` }), settings, { occurrenceKey: "2026-01-13" }),
    );
    const result = plan([unrelatedTask()], activeLinks, { confirmedMassDelete: 19 });
    expect(result.abort?.reason).toBe("needs_confirmation");
    expect(result.abort?.deleteCount).toBe(20);
    expect(result.deletes).toHaveLength(0);
  });
});

describe("planCalendarSync — idempotence", () => {
  it("produces nothing on a second run with unchanged tasks and synced links", () => {
    const task = baseTask();
    const link = baseLink(task, settings);
    const first = plan([task], [link]);
    expect(first).toEqual({ creates: [], updates: [], deletes: [], detaches: [], purges: [] });
    const second = plan([task], [link]);
    expect(second).toEqual(first);
  });
});
