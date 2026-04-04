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

  it("creates and renames task contexts dynamically", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const created = await repository.saveContext({
      id: "context:deep-work",
      name: "Deep Work",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z"
    });

    const renamed = await repository.saveContext({
      ...created,
      name: "Travail profond"
    });

    await expect(repository.listContexts()).resolves.toEqual([
      expect.objectContaining({
        id: "context:deep-work",
        name: "Travail profond"
      })
    ]);

    expect(renamed.name).toBe("Travail profond");
  });

  it("generates one daily relationship task per category and keeps them in next actions", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const settings = await repository.getSettings();
    await repository.saveSettings({
      ...settings,
      relationshipDrawChildrenActivities: ["Lire une histoire ensemble"],
      relationshipDrawSpouseActivities: ["Boire un the ensemble"]
    });

    const generatedCount = await repository.generateDailyRelationshipTasks("2026-04-01");
    const tasks = await repository.listTasks({ includeCompleted: true });

    expect(generatedCount).toBe(2);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Avec enfants: Lire une histoire ensemble",
          bucket: "next_action",
          contextIds: expect.arrayContaining(["context:personnel"]),
          sourceExternalId: "relationship-draw:children:2026-04-01"
        }),
        expect.objectContaining({
          title: "Avec mon epouse: Boire un the ensemble",
          bucket: "next_action",
          contextIds: expect.arrayContaining(["context:personnel"]),
          sourceExternalId: "relationship-draw:spouse:2026-04-01"
        })
      ])
    );
  });

  it("does not generate a new relationship task while a previous one stays active", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const settings = await repository.getSettings();
    await repository.saveSettings({
      ...settings,
      relationshipDrawChildrenActivities: ["Lire une histoire ensemble"],
      relationshipDrawSpouseActivities: ["Boire un the ensemble"]
    });

    await repository.generateDailyRelationshipTasks("2026-04-01");
    const firstDayTasks = await repository.listTasks({ includeCompleted: true });
    const spouseTask = firstDayTasks.find((task) => task.sourceExternalId === "relationship-draw:spouse:2026-04-01");
    if (!spouseTask) {
      throw new Error("Tache epouse manquante");
    }

    await repository.completeTask(spouseTask.id, "2026-04-01T21:00:00.000Z");
    const generatedCount = await repository.generateDailyRelationshipTasks("2026-04-02");
    const tasks = await repository.listTasks({ includeCompleted: true });

    expect(generatedCount).toBe(1);
    expect(
      tasks.filter((task) => task.sourceExternalId?.startsWith("relationship-draw:children:"))
    ).toHaveLength(1);
    expect(
      tasks.filter((task) => task.sourceExternalId?.startsWith("relationship-draw:spouse:"))
    ).toHaveLength(2);
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

    await expect(repository.getDailyTaskBreakdown(today)).resolves.toEqual(
      expect.objectContaining({
        addedTasks: expect.arrayContaining([
          expect.objectContaining({ id: "task-scheduled" }),
          expect.objectContaining({ id: "task-move" })
        ]),
        completedTasks: expect.arrayContaining([expect.objectContaining({ id: "task-start" })])
      })
    );
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

  it("persists pomodoro sessions, free-form titles, task switches and daily stats", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.createTask({
      id: "task-focus",
      title: "Rediger le plan",
      bucket: "next_action"
    });

    const startedState = await repository.startPomodoro({
      taskId: "task-focus"
    });

    expect(startedState.activeSession).toMatchObject({
      kind: "focus",
      activeTaskId: "task-focus"
    });

    const activeSession = startedState.activeSession;
    if (!activeSession) {
      throw new Error("Session Pomodoro manquante");
    }

    const sessionId = activeSession.id;
    const startedAtMs = new Date(activeSession.startedAt).getTime();
    const switchAt = new Date(startedAtMs + 10 * 60 * 1000).toISOString();
    const completeAt = new Date(startedAtMs + 25 * 60 * 1000).toISOString();

    await repository.switchPomodoroTask(sessionId, null, "Inbox zero", switchAt);
    await repository.stopPomodoroSession(sessionId, "completed", completeAt);

    const today = new Date().toISOString().slice(0, 10);
    const summaries = await repository.listPomodoroTaskSummaries(today, completeAt);
    const stats = await repository.computeDailyPomodoroStats(today);

    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task-focus",
          sessionCount: 1
        }),
        expect.objectContaining({
          taskId: null,
          taskTitle: "Inbox zero",
          sessionCount: 1
        })
      ])
    );
    expect(stats.completedFocusSessions).toBe(1);
  });

  it("generates recurring tasks once per due day and exposes previews", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.saveRecurringTaskTemplate({
      id: "recurring-template:weekly-review",
      title: "Weekly review",
      notes: "",
      targetBucket: "next_action",
      contextIds: [],
      projectId: null,
      ruleType: "daily",
      dailyInterval: 1,
      weeklyInterval: 1,
      weeklyDays: [0],
      monthlyMode: "day_of_month",
      dayOfMonth: 1,
      nthWeek: 1,
      weekday: 6,
      scheduledTime: null,
      startDate: "2026-04-01",
      status: "active",
      lastGeneratedForDate: null,
      pendingMissedOccurrences: 0,
      statusChangedAt: "2026-04-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await repository.generateDueRecurringTasks("2026-04-01");
    await repository.generateDueRecurringTasks("2026-04-01");

    const tasks = await repository.listTasks({ includeCompleted: true });
    const previews = await repository.listRecurringPreviewOccurrences("2026-04-01", "2026-04-04");

    expect(tasks.filter((task) => task.recurringTemplateId === "recurring-template:weekly-review")).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      isRecurringInstance: true,
      recurrenceDueDate: "2026-04-04"
    });
    expect(previews.map((preview) => preview.dueDate)).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
  });

  it("increments missed recurring occurrences and lets a task edit apply to the whole series", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.saveRecurringTaskTemplate({
      id: "recurring-template:monthly-plan",
      title: "Planification mensuelle",
      notes: "",
      targetBucket: "scheduled",
      contextIds: [],
      projectId: null,
      ruleType: "monthly",
      dailyInterval: 1,
      weeklyInterval: 1,
      weeklyDays: [6],
      monthlyMode: "nth_weekday",
      dayOfMonth: null,
      nthWeek: 1,
      weekday: 6,
      scheduledTime: "09:00",
      startDate: "2026-04-01",
      status: "active",
      lastGeneratedForDate: null,
      pendingMissedOccurrences: 0,
      statusChangedAt: "2026-04-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });

    await repository.generateDueRecurringTasks("2026-04-04");
    await repository.generateDueRecurringTasks("2026-05-02");

    let tasks = await repository.listTasks({ includeCompleted: true });
    expect(tasks[0]).toMatchObject({
      recurrenceDueDate: "2026-05-02",
      pendingPastRecurrences: 1
    });

    await repository.applyRecurringEditScope(tasks[0].id, "series", {
      title: "Planification mensuelle revue"
    });

    const templates = await repository.listRecurringTaskTemplates();
    tasks = await repository.listTasks({ includeCompleted: true });

    expect(templates[0].title).toBe("Planification mensuelle revue");
    expect(tasks[0].title).toBe("Planification mensuelle revue");
  });

  it("persists weekly reviews and computes weekly summaries from daily entries", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekDates = [
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04"
    ];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 80;
      entry.metrics.tempsEcranTelephone = 90;
      entry.metrics.pomodoris = 5;
      entry.metrics.tachesAjoutes = 4;
      entry.metrics.tachesRealises = 3;
      entry.principleChecks.priereDuMatin = true;
      entry.principleChecks.respectTrc = true;
      await repository.saveDailyEntry(entry);
    }

    await repository.saveWeeklyReview({
      weekStartDate: "2026-03-29",
      weekEndDate: "2026-04-04",
      status: "closed",
      notes: {
        bilan: "Bonne semaine",
        budget: "",
        tempsEtPlan: "",
        collecte: "",
        calendrier: "",
        gtd: "",
        alignement: "",
        dimanche: ""
      },
      ritualChecklist: {
        bilan: true,
        budget: false,
        tempsEtPlan: false,
        collecte: false,
        calendrier: false,
        gtd: false,
        alignement: false,
        dimanche: true
      },
      updatedAt: "2026-04-04T18:00:00.000Z"
    });

    await expect(repository.getWeeklyReview("2026-03-29")).resolves.toMatchObject({
      status: "closed",
      notes: expect.objectContaining({
        bilan: "Bonne semaine"
      }),
      ritualChecklist: expect.objectContaining({
        dimanche: true
      })
    });

    await expect(repository.computeWeeklyReviewSummary("2026-03-29")).resolves.toMatchObject({
      sleepAverage: 80,
      trcDaysRespected: 7,
      screenTimeTotalMinutes: 630,
      pomodorisTotal: 35,
      tasksAddedTotal: 28,
      tasksCompletedTotal: 21
    });
  });

  it("persists monthly reviews and annual goals with linked snapshots", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    for (const date of ["2026-04-01", "2026-04-02", "2026-04-03"]) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 81;
      entry.metrics.tempsEcranTelephone = 90;
      entry.metrics.pomodoris = 5;
      entry.metrics.tachesAjoutes = 4;
      entry.metrics.tachesRealises = 3;
      entry.principleChecks.priereDuMatin = true;
      entry.principleChecks.respectTrc = true;
      await repository.saveDailyEntry(entry);
    }

    await repository.saveMonthlyReview({
      monthKey: "2026-04",
      monthStartDate: "2026-04-01",
      monthEndDate: "2026-04-30",
      status: "draft",
      notes: {
        bilan: "Cap clair",
        journaux: "",
        finances: "",
        temps: "",
        progressionObjectifs: "",
        missionObjectifs: "",
        nettoyageListes: "",
        calendrier: "",
        grosProjets: "",
        developpement: ""
      },
      ritualChecklist: {
        bilan: true,
        journaux: false,
        finances: false,
        temps: false,
        progressionObjectifs: false,
        missionObjectifs: false,
        nettoyageListes: false,
        calendrier: false,
        grosProjets: false,
        developpement: false
      },
      updatedAt: "2026-05-02T18:00:00.000Z"
    });

    await repository.saveAnnualGoal({
      id: "",
      title: "Sommeil annuel",
      dimension: "physique",
      description: "",
      targetValue: 80,
      unit: "/100",
      sourceId: "weekly_sleep_average",
      manualCurrentValue: null,
      evaluations: {
        "2026-04": {
          monthKey: "2026-04",
          score: 75,
          trend: "up",
          notes: "Bon rythme",
          blockers: ""
        }
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
      notes: expect.objectContaining({
        bilan: "Cap clair"
      })
    });

    await expect(repository.computeMonthlyReviewSummary("2026-04")).resolves.toMatchObject({
      daysTracked: 3,
      sleepAverage: 81,
      pomodorisTotal: 15
    });

    await expect(repository.computeAnnualGoalSnapshots(2026)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          goal: expect.objectContaining({
            title: "Sommeil annuel"
          }),
          sourceLabel: "Sommeil moyen hebdo"
        })
      ])
    );
  });
});
