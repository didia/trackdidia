import type { Project, ProjectStatus, Task, TaskEvent, TaskEventType } from "../../domain/types";
import {
  buildDailyTaskBreakdown,
  buildDailyTaskStats,
  createTaskFromInput,
  effectiveTaskContextIds,
  formatAssociationCopy,
  projectAssignmentLabel,
  projectsForAssignment,
} from "./engine";

const buildProject = (id: string, title: string, status: ProjectStatus): Project => ({
  id,
  title,
  status,
  statusChangedAt: "2026-03-01T10:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
});

describe("createTaskFromInput", () => {
  it("honors an explicitly requested bucket even when scheduledFor is also supplied", () => {
    const task = createTaskFromInput({
      title: "Planifiee",
      bucket: "planned",
      projectId: "project:1",
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });

    expect(task.bucket).toBe("planned");
    expect(task.scheduledFor).toBe("2026-05-01T09:00:00.000Z");
    expect(task.plannedOrder).toBeNull();
  });

  it("still infers Scheduled from scheduledFor only when no bucket is requested", () => {
    const task = createTaskFromInput({
      title: "Sans bucket explicite",
      scheduledFor: "2026-05-01T09:00:00.000Z",
    });

    expect(task.bucket).toBe("scheduled");
  });

  it("defaults to inbox when neither bucket nor scheduledFor is provided", () => {
    const task = createTaskFromInput({ title: "Brut" });
    expect(task.bucket).toBe("inbox");
  });
});

describe("projectsForAssignment", () => {
  const activeAlpha = buildProject("p-active-a", "Alpha", "active");
  const activeZeta = buildProject("p-active-z", "Zeta", "active");
  const onHold = buildProject("p-hold", "Hold", "on_hold");
  const completed = buildProject("p-done", "Done", "completed");
  const cancelled = buildProject("p-cancel", "Cancel", "cancelled");
  const allProjects = [cancelled, completed, onHold, activeZeta, activeAlpha];

  it("suggests only active projects, sorted by title", () => {
    expect(projectsForAssignment(allProjects).map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z",
    ]);
  });

  it("omits on hold, completed, and cancelled projects", () => {
    const ids = projectsForAssignment(allProjects).map((project) => project.id);
    expect(ids).not.toContain("p-hold");
    expect(ids).not.toContain("p-done");
    expect(ids).not.toContain("p-cancel");
  });

  it("keeps the currently assigned inactive project in the list", () => {
    expect(projectsForAssignment(allProjects, "p-hold").map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z",
      "p-hold",
    ]);
  });

  it("does not duplicate an already active current project", () => {
    expect(projectsForAssignment(allProjects, "p-active-z").map((project) => project.id)).toEqual([
      "p-active-a",
      "p-active-z",
    ]);
  });

  it("labels a retained inactive project with its status", () => {
    expect(projectAssignmentLabel(onHold)).toBe("Hold (En pause)");
    expect(projectAssignmentLabel(completed)).toBe("Done (Termine)");
    expect(projectAssignmentLabel(cancelled)).toBe("Cancel (Retire)");
    expect(projectAssignmentLabel(activeAlpha)).toBe("Alpha");
  });
});

describe("formatAssociationCopy", () => {
  it("shows the project title when the task has a project and no contexts", () => {
    expect(formatAssociationCopy("MentorIA", [], "Sans contexte")).toBe("MentorIA");
  });

  it("shows context names when the task has contexts and no project", () => {
    expect(formatAssociationCopy(null, ["Perso"], "Sans contexte")).toBe("Perso");
  });

  it("shows project then contexts when both are present", () => {
    expect(formatAssociationCopy("MentorIA", ["Perso"], "Sans contexte")).toBe("MentorIA • Perso");
  });

  it("falls back when the task has neither a project nor contexts", () => {
    expect(formatAssociationCopy(null, [], "Sans contexte")).toBe("Sans contexte");
  });
});

describe("effectiveTaskContextIds", () => {
  const persoProject = buildProject("project:mentoria", "MentorIA", "active");
  persoProject.contextIds = ["context:perso"];
  const bareProject = buildProject("project:bare", "Bare", "active");

  it("returns the task contexts when the task has its own", () => {
    expect(
      effectiveTaskContextIds({ contextIds: ["context:call"], projectId: persoProject.id }, [
        persoProject,
      ]),
    ).toEqual(["context:call"]);
  });

  it("inherits the project contexts when the task has none", () => {
    expect(
      effectiveTaskContextIds({ contextIds: [], projectId: persoProject.id }, [persoProject]),
    ).toEqual(["context:perso"]);
  });

  it("returns an empty list when the task and project have no contexts", () => {
    expect(
      effectiveTaskContextIds({ contextIds: [], projectId: bareProject.id }, [bareProject]),
    ).toEqual([]);
  });

  it("returns an empty list when the task has no project", () => {
    expect(effectiveTaskContextIds({ contextIds: [], projectId: null }, [persoProject])).toEqual(
      [],
    );
  });
});

const buildTask = (overrides: Partial<Task> = {}): Task => ({
  id: "task:1",
  title: "Task",
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
  createdAt: "2026-04-01T08:00:00.000Z",
  updatedAt: "2026-04-01T08:00:00.000Z",
  ...overrides,
});

const buildEvent = (
  taskId: string,
  type: TaskEventType,
  eventDate: string,
  metadata: Record<string, string> = {},
): TaskEvent => ({
  id: `task-event:${taskId}:${type}`,
  taskId,
  type,
  eventDate,
  eventAt: `${eventDate}T12:00:00.000Z`,
  createdAt: `${eventDate}T12:00:00.000Z`,
  dedupeKey: null,
  metadata,
});

describe("buildDailyTaskStats added counting", () => {
  const date = "2026-04-08";

  it("does not count a task that is only scheduled for the day", () => {
    const scheduled = buildTask({
      id: "task-scheduled",
      bucket: "scheduled",
      scheduledFor: `${date}T15:30:00`,
      createdAt: `${date}T09:00:00.000Z`,
      updatedAt: `${date}T09:00:00.000Z`,
    });
    const events = [
      buildEvent("task-scheduled", "task_created", date, { bucket: "scheduled" }),
      buildEvent("task-scheduled", "task_scheduled_for_day", date, {
        scheduledFor: `${date}T15:30:00`,
      }),
    ];

    expect(buildDailyTaskStats([scheduled], events, date)).toMatchObject({
      tasksAdded: 0,
      tasksCompleted: 0,
    });
    expect(buildDailyTaskBreakdown([scheduled], events, date).addedTasks).toEqual([]);
  });

  it("counts a scheduled task when it moves into next actions", () => {
    const promoted = buildTask({
      id: "task-promoted",
      bucket: "next_action",
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: `${date}T10:00:00.000Z`,
    });
    const events = [
      buildEvent("task-promoted", "task_moved_to_next_action", date, { from: "scheduled" }),
    ];

    expect(buildDailyTaskStats([promoted], events, date)).toMatchObject({
      tasksAdded: 1,
      tasksCompleted: 0,
    });
    expect(buildDailyTaskBreakdown([promoted], events, date).addedTasks).toEqual([
      expect.objectContaining({ id: "task-promoted" }),
    ]);
  });

  it("counts a scheduled task completed in place as both added and completed", () => {
    const completed = buildTask({
      id: "task-done-scheduled",
      bucket: "scheduled",
      status: "completed",
      scheduledFor: `${date}T15:30:00`,
      completedAt: `${date}T18:00:00.000Z`,
      createdAt: "2026-04-07T09:00:00.000Z",
      updatedAt: `${date}T18:00:00.000Z`,
    });
    const events = [
      buildEvent("task-done-scheduled", "task_completed", date, { bucket: "scheduled" }),
    ];

    expect(buildDailyTaskStats([completed], events, date)).toMatchObject({
      tasksAdded: 1,
      tasksCompleted: 1,
    });
    expect(buildDailyTaskBreakdown([completed], events, date)).toEqual(
      expect.objectContaining({
        addedTasks: [expect.objectContaining({ id: "task-done-scheduled" })],
        completedTasks: [expect.objectContaining({ id: "task-done-scheduled" })],
      }),
    );
  });

  it("counts Sunday next-action carryover but not scheduled carryover", () => {
    const sunday = "2026-04-05";
    const leftoverNext = buildTask({
      id: "task-na-carry",
      bucket: "next_action",
      createdAt: "2026-03-30T08:00:00.000Z",
      updatedAt: "2026-03-30T08:00:00.000Z",
    });
    const leftoverScheduled = buildTask({
      id: "task-sched-carry",
      bucket: "scheduled",
      // Future-dated: same-day or overdue Scheduled would already have been
      // auto-promoted before stats run, so only a later date can still carry as Scheduled.
      scheduledFor: "2026-04-08T10:00:00",
      createdAt: "2026-03-30T08:00:00.000Z",
      updatedAt: "2026-03-30T08:00:00.000Z",
    });
    const events = [
      buildEvent("task-na-carry", "weekly_carryover", sunday, { bucket: "next_action" }),
      buildEvent("task-sched-carry", "weekly_carryover", sunday, { bucket: "scheduled" }),
    ];

    expect(buildDailyTaskStats([leftoverNext, leftoverScheduled], events, sunday)).toMatchObject({
      tasksAdded: 1,
      tasksCompleted: 0,
    });
    expect(
      buildDailyTaskBreakdown([leftoverNext, leftoverScheduled], events, sunday).addedTasks,
    ).toEqual([expect.objectContaining({ id: "task-na-carry" })]);
  });
});
