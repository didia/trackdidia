import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import { addDays } from "../gtd/shared";
import { MemoryRepository } from "./memory-repository";

describe("MemoryRepository", () => {
  it("persists daily entries in memory", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const entry = createEmptyDailyEntry("2026-03-31");
    entry.morningIntention = "Tenir le cap";

    await repository.saveDailyEntry(entry);

    await expect(repository.getDailyEntry("2026-03-31")).resolves.toMatchObject({
      morningIntention: "Tenir le cap"
    });
  });

  it("persists settings", async () => {
    const repository = new MemoryRepository();
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    await repository.saveSettings(settings);

    await expect(repository.getSettings()).resolves.toMatchObject({
      aiEnabled: true,
      aiApiKey: "secret"
    });
  });

  it("imports Google Tasks payload and exposes normalized GTD data", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const summary = await repository.importGoogleTasksExport({
      items: [
        {
          id: "list-1",
          title: "Next Actions - Perso (3)",
          items: [
            { id: "task-1", title: "Appeler maman", status: "needsAction", updated: "2026-03-30T14:00:00.000Z" },
            { id: "task-2", title: "Deja fait", status: "completed", updated: "2026-03-29T14:00:00.000Z" }
          ]
        },
        {
          id: "list-2",
          title: "Projects - RDC Etudes",
          items: [{ id: "project-1", title: "Memoire data", status: "needsAction", updated: "2026-03-30T14:00:00.000Z" }]
        }
      ]
    });

    const tasks = await repository.listTasks();
    const projects = await repository.listProjects();
    const contexts = await repository.listContexts();

    expect(summary).toMatchObject({
      importedTasks: 1,
      importedProjects: 1,
      skippedCompletedTasks: 1
    });
    expect(tasks[0]).toMatchObject({
      title: "Appeler maman",
      bucket: "next_action"
    });
    expect(projects[0]).toMatchObject({
      title: "Memoire data"
    });
    expect(contexts.map((context) => context.name)).toEqual(expect.arrayContaining(["Perso", "RDC Etudes"]));
  });

  it("moves reading tasks into the References bucket", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.createTask({
      id: "task-reading",
      title: "Lire un essai",
      bucket: "next_action",
      contextIds: ["context:reading"]
    });

    await repository.createTask({
      id: "task-other",
      title: "Faire un call",
      bucket: "next_action",
      contextIds: ["context:call"]
    });

    const movedCount = await repository.moveTasksWithContextToBucket("context:reading", "reference");
    const tasks = await repository.listTasks({ includeCompleted: true });

    expect(movedCount).toBe(1);
    expect(tasks.find((task) => task.id === "task-reading")?.bucket).toBe("reference");
    expect(tasks.find((task) => task.id === "task-other")?.bucket).toBe("next_action");
  });

  it("moves active dated tasks into Scheduled", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.createTask({
      id: "task-date",
      title: "Relire un document",
      bucket: "reference",
      contextIds: ["context:reading"],
      scheduledFor: "2026-04-02T10:00:00.000Z"
    });

    await repository.createTask({
      id: "task-no-date",
      title: "Sans date",
      bucket: "reference",
      contextIds: ["context:reading"]
    });

    const movedCount = await repository.moveTasksWithScheduledDatesToBucket("scheduled");
    const tasks = await repository.listTasks({ includeCompleted: true });

    expect(movedCount).toBe(0);
    expect(tasks.find((task) => task.id === "task-date")?.bucket).toBe("scheduled");
    expect(tasks.find((task) => task.id === "task-no-date")?.bucket).toBe("reference");
  });

  it("collapses imported recurring tasks and can clear past recurrences", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.importGoogleTasksExport({
      items: [
        {
          id: "list-1",
          title: "Next Actions - Perso (3)",
          items: [
            {
              id: "task-old",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-22T10:00:00.000Z" }],
              updated: "2026-03-22T10:00:00.000Z"
            },
            {
              id: "task-new",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
              updated: "2026-03-29T10:00:00.000Z"
            }
          ]
        }
      ]
    });

    await repository.collapseGoogleRecurringTasks({
      items: [
        {
          id: "list-1",
          title: "Next Actions - Perso (3)",
          items: [
            {
              id: "task-old",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-22T10:00:00.000Z" }],
              updated: "2026-03-22T10:00:00.000Z"
            },
            {
              id: "task-new",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
              updated: "2026-03-29T10:00:00.000Z"
            }
          ]
        }
      ]
    });

    const tasksAfterCollapse = await repository.listTasks({ includeCompleted: true });
    expect(tasksAfterCollapse).toHaveLength(1);
    expect(tasksAfterCollapse[0]).toMatchObject({
      recurrenceGroupId: "rec-1",
      pendingPastRecurrences: 1,
      scheduledFor: "2026-03-29T10:00:00.000Z"
    });

    await repository.clearPastRecurrences("google-recurrence:rec-1");
    const tasksAfterClear = await repository.listTasks({ includeCompleted: true });
    expect(tasksAfterClear[0].pendingPastRecurrences).toBe(0);
  });

  it("computes daily task stats from GTD events", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = addDays(today, -1);

    await repository.createTask({
      id: "task-start",
      title: "Action deja la",
      bucket: "next_action",
      createdAt: `${yesterday}T08:00:00.000Z`
    });

    await repository.createTask({
      id: "task-move",
      title: "Inbox a clarifier",
      bucket: "inbox",
      createdAt: `${yesterday}T08:00:00.000Z`
    });

    await repository.moveTask("task-move", "next_action", []);

    await repository.createTask({
      id: "task-scheduled",
      title: "Call planifie",
      bucket: "scheduled",
      scheduledFor: `${today}T15:30:00.000Z`,
      createdAt: `${today}T09:00:00.000Z`
    });

    await repository.completeTask("task-start", `${today}T18:00:00.000Z`);

    await expect(repository.computeDailyTaskStats(today)).resolves.toMatchObject({
      tasksAtStart: 1,
      tasksAdded: 2,
      tasksCompleted: 1,
      tasksRemaining: 2
    });

    await expect(repository.getDailyTaskBreakdown(today)).resolves.toMatchObject({
      addedTasks: [
        expect.objectContaining({ id: "task-scheduled" }),
        expect.objectContaining({ id: "task-move" })
      ],
      completedTasks: [expect.objectContaining({ id: "task-start" })]
    });
  });

  it("tracks project status duration from the last status change", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const createdProject = await repository.saveProject({
      id: "project-1",
      title: "Projet test",
      status: "active",
      statusChangedAt: "2026-03-01T10:00:00.000Z",
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z"
    });

    const afterNotesEdit = await repository.saveProject({
      ...createdProject,
      notes: "Note modifiee"
    });

    expect(afterNotesEdit.statusChangedAt).toBe(createdProject.statusChangedAt);

    const afterStatusChange = await repository.saveProject({
      ...afterNotesEdit,
      status: "on_hold"
    });

    expect(afterStatusChange.statusChangedAt).not.toBe(createdProject.statusChangedAt);
  });
});
