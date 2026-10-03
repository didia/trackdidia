import { afterEach, vi } from "vitest";
import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import type {
  FinanceAccount,
  FinanceImportRow,
  FinancePerson,
  FinanceTransaction,
} from "../../domain/finance";
import { createEmptyMonthlyReview } from "../../domain/monthly-review";
import type { MidWeekLaggingSnapshot } from "../../domain/mid-week-review";
import type { CatalogVerse, RescueTimeSnapshotCacheEntry } from "../../domain/types";
import { createEmptyWeeklyReview } from "../../domain/weekly-review";
import { getTodayDate } from "../date";
import { addDays } from "../gtd/shared";
import { loadVerseCatalog } from "../pastor/verse-catalog";
import type { AppRepository } from "./repository";

/**
 * Implementation-agnostic behavioral spec for any `AppRepository`. Run this against every
 * repository implementation (see `memory-repository.test.ts` and
 * `tauri-sqlite-repository.test.ts`) so behavioral drift between implementations is caught by
 * the test suite instead of by review (docs/architecture.md's "Repository parity", issue #106).
 *
 * `factory` must return a repository that is already `initialize()`-d and backed by an
 * isolated store (a fresh in-memory Map, or a fresh `:memory:`/temp-file SQLite database) —
 * never a shared or on-disk app database.
 */
export const describeRepositoryContract = (name: string, factory: () => Promise<AppRepository>) => {
  describe(name, () => {
    describe("core", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("persists daily entries in memory", async () => {
        const repository = await factory();

        const entry = createEmptyDailyEntry("2026-03-31");
        entry.morningIntention = "Tenir le cap";

        await repository.saveDailyEntry(entry);

        await expect(repository.getDailyEntry("2026-03-31")).resolves.toMatchObject({
          morningIntention: "Tenir le cap",
        });
      });

      it("persists settings", async () => {
        const repository = await factory();
        const settings = defaultAppSettings();
        settings.aiEnabled = true;
        settings.aiApiKey = "secret";

        await repository.saveSettings(settings);

        await expect(repository.getSettings()).resolves.toMatchObject({
          aiEnabled: true,
          aiApiKey: "secret",
        });
      });

      it("round-trips aiMaxTokens of 700 through save and read", async () => {
        const repository = await factory();
        const settings = defaultAppSettings();
        settings.aiMaxTokens = 700;
        settings.aiMaxTokensUpgradeDoneAt = "2026-09-04T12:00:00.000Z";

        await repository.saveSettings(settings);

        await expect(repository.getSettings()).resolves.toMatchObject({ aiMaxTokens: 700 });
      });

      it("imports Google Tasks payload and exposes normalized GTD data", async () => {
        const repository = await factory();

        const summary = await repository.importGoogleTasksExport({
          items: [
            {
              id: "list-1",
              title: "Next Actions - Perso (3)",
              items: [
                {
                  id: "task-1",
                  title: "Appeler maman",
                  status: "needsAction",
                  updated: "2026-03-30T14:00:00.000Z",
                },
                {
                  id: "task-2",
                  title: "Deja fait",
                  status: "completed",
                  updated: "2026-03-29T14:00:00.000Z",
                },
              ],
            },
            {
              id: "list-2",
              title: "Projects - RDC Etudes",
              items: [
                {
                  id: "project-1",
                  title: "Memoire data",
                  status: "needsAction",
                  updated: "2026-03-30T14:00:00.000Z",
                },
              ],
            },
          ],
        });

        const tasks = await repository.listTasks();
        const projects = await repository.listProjects();
        const contexts = await repository.listContexts();

        expect(summary).toMatchObject({
          importedTasks: 1,
          importedProjects: 1,
          skippedCompletedTasks: 1,
        });
        expect(tasks[0]).toMatchObject({
          title: "Appeler maman",
          bucket: "next_action",
        });
        expect(projects[0]).toMatchObject({
          title: "Memoire data",
        });
        expect(contexts.map((context) => context.name)).toEqual(
          expect.arrayContaining(["Perso", "RDC Etudes"]),
        );
      });

      it("creates and renames task contexts dynamically", async () => {
        const repository = await factory();

        const created = await repository.saveContext({
          id: "context:deep-work",
          name: "Deep Work",
          createdAt: "2026-04-01T10:00:00.000Z",
          updatedAt: "2026-04-01T10:00:00.000Z",
        });

        const renamed = await repository.saveContext({
          ...created,
          name: "Travail profond",
        });

        await expect(repository.listContexts()).resolves.toEqual([
          expect.objectContaining({
            id: "context:deep-work",
            name: "Travail profond",
          }),
        ]);

        expect(renamed.name).toBe("Travail profond");
      });

      it("generates one daily relationship task per category and keeps them in next actions", async () => {
        const repository = await factory();

        const settings = await repository.getSettings();
        await repository.saveSettings({
          ...settings,
          relationshipDrawChildrenActivities: ["Lire une histoire ensemble"],
          relationshipDrawSpouseActivities: ["Boire un the ensemble"],
        });

        const generatedCount = await repository.generateDailyRelationshipTasks("2026-04-01");
        const tasks = await repository.listTasks({ includeCompleted: true });

        expect(generatedCount).toBe(2);
        expect(tasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              title: "Avec enfants : Lire une histoire ensemble",
              bucket: "next_action",
              contextIds: expect.arrayContaining(["context:personnel"]),
              sourceExternalId: "relationship-draw:children:2026-04-01",
            }),
            expect.objectContaining({
              title: "Avec mon épouse : Boire un the ensemble",
              bucket: "next_action",
              contextIds: expect.arrayContaining(["context:personnel"]),
              sourceExternalId: "relationship-draw:spouse:2026-04-01",
            }),
          ]),
        );
      });

      it("does not generate a new relationship task while a previous one stays active", async () => {
        const repository = await factory();

        const settings = await repository.getSettings();
        await repository.saveSettings({
          ...settings,
          relationshipDrawChildrenActivities: ["Lire une histoire ensemble"],
          relationshipDrawSpouseActivities: ["Boire un the ensemble"],
        });

        await repository.generateDailyRelationshipTasks("2026-04-01");
        const firstDayTasks = await repository.listTasks({ includeCompleted: true });
        const spouseTask = firstDayTasks.find(
          (task) => task.sourceExternalId === "relationship-draw:spouse:2026-04-01",
        );
        if (!spouseTask) {
          throw new Error("Tache epouse manquante");
        }

        await repository.completeTask(spouseTask.id, "2026-04-01T21:00:00.000Z");
        const generatedCount = await repository.generateDailyRelationshipTasks("2026-04-02");
        const tasks = await repository.listTasks({ includeCompleted: true });

        expect(generatedCount).toBe(1);
        expect(
          tasks.filter((task) => task.sourceExternalId?.startsWith("relationship-draw:children:")),
        ).toHaveLength(1);
        expect(
          tasks.filter((task) => task.sourceExternalId?.startsWith("relationship-draw:spouse:")),
        ).toHaveLength(2);
      });

      it("moves reading tasks into the References bucket", async () => {
        const repository = await factory();

        await repository.createTask({
          id: "task-reading",
          title: "Lire un essai",
          bucket: "next_action",
          contextIds: ["context:reading"],
        });

        await repository.createTask({
          id: "task-other",
          title: "Faire un call",
          bucket: "next_action",
          contextIds: ["context:call"],
        });

        const movedCount = await repository.moveTasksWithContextToBucket(
          "context:reading",
          "reference",
        );
        const tasks = await repository.listTasks({ includeCompleted: true });

        expect(movedCount).toBe(1);
        expect(tasks.find((task) => task.id === "task-reading")?.bucket).toBe("reference");
        expect(tasks.find((task) => task.id === "task-other")?.bucket).toBe("next_action");
      });

      it("moves active dated tasks into Scheduled", async () => {
        const repository = await factory();

        await repository.createTask({
          id: "task-date",
          title: "Relire un document",
          bucket: "reference",
          contextIds: ["context:reading"],
          scheduledFor: "2099-04-02T10:00:00.000Z",
        });

        await repository.createTask({
          id: "task-no-date",
          title: "Sans date",
          bucket: "reference",
          contextIds: ["context:reading"],
        });

        const movedCount = await repository.moveTasksWithScheduledDatesToBucket("scheduled");
        const tasks = await repository.listTasks({ includeCompleted: true });

        // `createTaskFromInput` now honors an explicitly requested bucket ("reference") even when
        // `scheduledFor` is also supplied, so the dated task starts out unmoved and this call is
        // what actually moves it into Scheduled.
        expect(movedCount).toBe(1);
        expect(tasks.find((task) => task.id === "task-date")?.bucket).toBe("scheduled");
        expect(tasks.find((task) => task.id === "task-no-date")?.bucket).toBe("reference");
      });

      it("collapses imported recurring tasks and can clear past recurrences", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-21T12:00:00.000Z"));

        const repository = await factory();

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
                  updated: "2026-03-22T10:00:00.000Z",
                },
                {
                  id: "task-new",
                  title: "Retro hebdomadaire",
                  status: "needsAction",
                  task_recurrence_id: "rec-1",
                  scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
                  updated: "2026-03-29T10:00:00.000Z",
                },
              ],
            },
          ],
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
                  updated: "2026-03-22T10:00:00.000Z",
                },
                {
                  id: "task-new",
                  title: "Retro hebdomadaire",
                  status: "needsAction",
                  task_recurrence_id: "rec-1",
                  scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
                  updated: "2026-03-29T10:00:00.000Z",
                },
              ],
            },
          ],
        });

        const tasksAfterCollapse = await repository.listTasks({ includeCompleted: true });
        expect(tasksAfterCollapse).toHaveLength(1);
        expect(tasksAfterCollapse[0]).toMatchObject({
          recurrenceGroupId: "rec-1",
          pendingPastRecurrences: 1,
          plannedOrder: null,
          scheduledFor: "2026-03-29T10:00:00.000Z",
        });

        await repository.clearPastRecurrences("google-recurrence:rec-1");
        const tasksAfterClear = await repository.listTasks({ includeCompleted: true });
        expect(tasksAfterClear[0].pendingPastRecurrences).toBe(0);
      });

      it("computes daily task stats from GTD events", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

        const repository = await factory();
        const today = "2026-04-08";
        const yesterday = addDays(today, -1);

        await repository.createTask({
          id: "task-start",
          title: "Action deja la",
          bucket: "next_action",
          createdAt: `${yesterday}T08:00:00`,
        });

        await repository.createTask({
          id: "task-move",
          title: "Inbox a clarifier",
          bucket: "inbox",
          createdAt: `${yesterday}T08:00:00`,
        });

        await repository.moveTask("task-move", "next_action", []);

        await repository.createTask({
          id: "task-scheduled",
          title: "Call planifie",
          bucket: "scheduled",
          scheduledFor: `${addDays(today, 1)}T15:30:00`,
          createdAt: `${today}T09:00:00`,
        });

        await repository.completeTask("task-start", `${today}T18:00:00`);

        await expect(repository.computeDailyTaskStats(today)).resolves.toMatchObject({
          tasksAtStart: 1,
          tasksAdded: 1,
          tasksCompleted: 1,
          tasksRemaining: 1,
        });

        await expect(repository.getDailyTaskBreakdown(today)).resolves.toEqual(
          expect.objectContaining({
            addedTasks: [expect.objectContaining({ id: "task-move" })],
            completedTasks: [expect.objectContaining({ id: "task-start" })],
          }),
        );

        await repository.completeTask("task-scheduled", `${today}T19:00:00`);

        await expect(repository.computeDailyTaskStats(today)).resolves.toMatchObject({
          tasksAtStart: 1,
          tasksAdded: 2,
          tasksCompleted: 2,
          tasksRemaining: 1,
        });

        await expect(repository.getDailyTaskBreakdown(today)).resolves.toEqual(
          expect.objectContaining({
            addedTasks: expect.arrayContaining([
              expect.objectContaining({ id: "task-move" }),
              expect.objectContaining({ id: "task-scheduled" }),
            ]),
            completedTasks: expect.arrayContaining([
              expect.objectContaining({ id: "task-start" }),
              expect.objectContaining({ id: "task-scheduled" }),
            ]),
          }),
        );
      });

      it("counts a due Scheduled task as added after auto-promotion into Next Actions", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));

        const repository = await factory();
        const today = "2026-04-08";

        await repository.createTask({
          id: "task-due-scheduled",
          title: "Call due today",
          bucket: "scheduled",
          scheduledFor: `${today}T09:00:00`,
          createdAt: `${addDays(today, -2)}T08:00:00`,
        });

        await expect(repository.computeDailyTaskStats(today)).resolves.toMatchObject({
          tasksAdded: 1,
          tasksCompleted: 0,
        });

        await expect(repository.getDailyTaskBreakdown(today)).resolves.toEqual(
          expect.objectContaining({
            addedTasks: [
              expect.objectContaining({ id: "task-due-scheduled", bucket: "next_action" }),
            ],
          }),
        );

        const events = await repository.listTaskEvents({ types: ["task_moved_to_next_action"] });
        expect(events).toEqual([
          expect.objectContaining({
            taskId: "task-due-scheduled",
            type: "task_moved_to_next_action",
          }),
        ]);
      });

      it("tracks project status duration from the last status change", async () => {
        const repository = await factory();

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
          updatedAt: "2026-03-01T10:00:00.000Z",
        });

        const afterNotesEdit = await repository.saveProject({
          ...createdProject,
          notes: "Note modifiee",
        });

        expect(afterNotesEdit.statusChangedAt).toBe(createdProject.statusChangedAt);

        const afterStatusChange = await repository.saveProject({
          ...afterNotesEdit,
          status: "on_hold",
        });

        expect(afterStatusChange.statusChangedAt).not.toBe(createdProject.statusChangedAt);
      });

      it("persists pomodoro sessions, free-form titles, task switches and daily stats", async () => {
        const repository = await factory();

        await repository.createTask({
          id: "task-focus",
          title: "Rediger le plan",
          bucket: "next_action",
        });

        const startedState = await repository.startPomodoro({
          taskId: "task-focus",
        });

        expect(startedState.activeSession).toMatchObject({
          kind: "focus",
          activeTaskId: "task-focus",
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

        const today = getTodayDate();
        const summaries = await repository.listPomodoroTaskSummaries(today, completeAt);
        const stats = await repository.computeDailyPomodoroStats(today);

        expect(summaries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              taskId: "task-focus",
              sessionCount: 1,
            }),
            expect.objectContaining({
              taskId: null,
              taskTitle: "Inbox zero",
              sessionCount: 1,
            }),
          ]),
        );
        expect(stats.completedFocusSessions).toBe(1);
      });

      it("pauses and resumes a pomodoro session while preserving remaining time and task context", async () => {
        const repository = await factory();

        await repository.createTask({
          id: "task-focus",
          title: "Rediger le plan",
          bucket: "next_action",
        });

        const startedState = await repository.startPomodoro({
          taskId: "task-focus",
        });
        const activeSession = startedState.activeSession;
        if (!activeSession) {
          throw new Error("Session Pomodoro manquante");
        }

        const pauseAt = new Date(
          new Date(activeSession.startedAt).getTime() + 5 * 60 * 1000,
        ).toISOString();
        await repository.pausePomodoroSession(activeSession.id, pauseAt);

        const pausedState = await repository.getPomodoroState();
        expect(pausedState.activeSession?.status).toBe("paused");
        expect(pausedState.activeSession?.pausedRemainingMs).toBe(20 * 60 * 1000);
        expect(pausedState.activeSession?.activeTaskId).toBe("task-focus");

        const resumeAt = new Date(new Date(pauseAt).getTime() + 12 * 60 * 1000).toISOString();
        await repository.resumePomodoroSession(activeSession.id, resumeAt);

        const resumedState = await repository.getPomodoroState();
        expect(resumedState.activeSession?.status).toBe("running");
        expect(resumedState.activeSession?.activeTaskId).toBe("task-focus");
        expect(resumedState.activeSession?.endsAt).toBe(
          new Date(new Date(resumeAt).getTime() + 20 * 60 * 1000).toISOString(),
        );
      });

      it("generates recurring tasks once per due day and exposes previews", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

        const repository = await factory();

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
          updatedAt: "2026-04-01T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-04-01");
        await repository.generateDueRecurringTasks("2026-04-01");

        const tasks = await repository.listTasks({ includeCompleted: true });
        const previews = await repository.listRecurringPreviewOccurrences(
          "2026-04-01",
          "2026-04-04",
        );

        expect(
          tasks.filter((task) => task.recurringTemplateId === "recurring-template:weekly-review"),
        ).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          isRecurringInstance: true,
          recurrenceDueDate: "2026-04-01",
        });
        expect(previews.map((preview) => preview.dueDate)).toEqual([
          "2026-04-02",
          "2026-04-03",
          "2026-04-04",
        ]);
      });

      it("increments missed recurring occurrences and lets a task edit apply to the whole series", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"));

        const repository = await factory();

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
          updatedAt: "2026-04-01T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-04-04");
        await repository.generateDueRecurringTasks("2026-05-02");

        let tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks[0]).toMatchObject({
          recurrenceDueDate: "2026-05-02",
          pendingPastRecurrences: 1,
          plannedOrder: null,
        });

        await repository.applyRecurringEditScope(tasks[0].id, "series", {
          title: "Planification mensuelle revue",
        });

        const templates = await repository.listRecurringTaskTemplates();
        tasks = await repository.listTasks({ includeCompleted: true });

        expect(templates[0].title).toBe("Planification mensuelle revue");
        expect(tasks[0].title).toBe("Planification mensuelle revue");
      });

      it("does not fast-forward a daily recurrence when a weekly summary includes future days", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-07T15:00:00.000Z"));

        const repository = await factory();
        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:matin",
          title: "Routine du matin",
          notes: "",
          targetBucket: "next_action",
          contextIds: [],
          projectId: null,
          ruleType: "daily",
          dailyInterval: 1,
          weeklyInterval: 1,
          weeklyDays: [1],
          monthlyMode: "day_of_month",
          dayOfMonth: 1,
          nthWeek: 1,
          weekday: 1,
          scheduledTime: null,
          startDate: "2026-09-07",
          status: "active",
          lastGeneratedForDate: null,
          pendingMissedOccurrences: 0,
          statusChangedAt: "2026-09-07T00:00:00.000Z",
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
        });

        await repository.computeWeeklyReviewSummary("2026-09-27");

        const templates = await repository.listRecurringTaskTemplates();
        expect(templates[0]?.lastGeneratedForDate).toBe("2026-09-07");
        let tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks[0]).toMatchObject({
          status: "active",
          bucket: "next_action",
          recurrenceDueDate: "2026-09-07",
        });

        await repository.completeTask(tasks[0].id, "2026-09-07T20:00:00.000Z");
        vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));
        await repository.generateDueRecurringTasks("2026-09-08");

        tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks.find((task) => task.status === "active")).toMatchObject({
          bucket: "next_action",
          recurrenceDueDate: "2026-09-08",
        });
      });

      it("resumes a daily recurrence whose watermark was already advanced past today", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-25T15:00:00.000Z"));

        const repository = await factory();
        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:matin",
          title: "Routine du matin",
          notes: "",
          targetBucket: "next_action",
          contextIds: [],
          projectId: null,
          ruleType: "daily",
          dailyInterval: 1,
          weeklyInterval: 1,
          weeklyDays: [1],
          monthlyMode: "day_of_month",
          dayOfMonth: 1,
          nthWeek: 1,
          weekday: 1,
          scheduledTime: null,
          startDate: "2026-04-03",
          status: "active",
          lastGeneratedForDate: "2026-10-03",
          pendingMissedOccurrences: 0,
          statusChangedAt: "2026-09-08T16:24:52.601Z",
          createdAt: "2026-04-03T00:00:00.000Z",
          updatedAt: "2026-09-08T16:24:52.601Z",
        });
        await repository.saveTask({
          id: "recurring-task:recurring-template:matin",
          title: "Routine du matin",
          notes: "",
          status: "completed",
          bucket: "next_action",
          contextIds: [],
          projectId: null,
          parentTaskId: null,
          scheduledFor: null,
          deadline: null,
          recurringTemplateId: "recurring-template:matin",
          recurrenceDueDate: "2026-10-03",
          isRecurringInstance: true,
          completedAt: "2026-09-08T16:24:52.561Z",
          recurrenceGroupId: null,
          pendingPastRecurrences: 0,
          plannedOrder: null,
          source: "manual",
          sourceExternalId: null,
          sourceUrl: null,
          createdAt: "2026-09-07T15:51:22.605Z",
          updatedAt: "2026-09-08T16:24:52.586Z",
        });

        await repository.generateDueRecurringTasks("2026-09-25");

        const tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks.find((task) => task.status === "active")).toMatchObject({
          bucket: "next_action",
          recurrenceDueDate: "2026-09-25",
          pendingPastRecurrences: 16,
        });
        const templates = await repository.listRecurringTaskTemplates();
        expect(templates[0]?.lastGeneratedForDate).toBe("2026-09-25");
      });

      it("rewinds an active future instance, reduces pending counters, and emits lifecycle events", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));

        const repository = await factory();
        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:matin",
          title: "Routine du matin",
          notes: "",
          targetBucket: "next_action",
          contextIds: [],
          projectId: null,
          ruleType: "daily",
          dailyInterval: 1,
          weeklyInterval: 1,
          weeklyDays: [1],
          monthlyMode: "day_of_month",
          dayOfMonth: 1,
          nthWeek: 1,
          weekday: 1,
          scheduledTime: null,
          startDate: "2026-08-01",
          status: "active",
          lastGeneratedForDate: "2026-09-27",
          pendingMissedOccurrences: 26,
          statusChangedAt: "2026-08-01T00:00:00.000Z",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
        });
        await repository.saveTask({
          id: "recurring-task:recurring-template:matin",
          title: "Routine du matin",
          notes: "",
          status: "active",
          bucket: "next_action",
          contextIds: [],
          projectId: null,
          parentTaskId: null,
          scheduledFor: null,
          deadline: null,
          recurringTemplateId: "recurring-template:matin",
          recurrenceDueDate: "2026-09-27",
          isRecurringInstance: true,
          completedAt: null,
          recurrenceGroupId: null,
          pendingPastRecurrences: 26,
          plannedOrder: null,
          source: "manual",
          sourceExternalId: null,
          sourceUrl: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-09-08");

        const tasks = await repository.listTasks({ includeCompleted: true });
        const active = tasks.find((task) => task.status === "active");
        expect(active).toMatchObject({
          recurrenceDueDate: "2026-09-08",
          pendingPastRecurrences: 7,
        });
        const templates = await repository.listRecurringTaskTemplates();
        expect(templates[0]).toMatchObject({
          lastGeneratedForDate: "2026-09-08",
          pendingMissedOccurrences: 7,
        });
        const events = await repository.listTaskEvents();
        expect(
          events.some(
            (event) =>
              event.taskId === active?.id &&
              event.type === "task_moved_to_next_action" &&
              event.eventDate === "2026-09-08",
          ),
        ).toBe(true);
        await expect(repository.computeDailyTaskStats("2026-09-08")).resolves.toMatchObject({
          tasksAdded: 1,
        });
      });

      it("cancels a prematurely generated instance before the template start date", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-07T15:00:00.000Z"));

        const repository = await factory();
        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:future",
          title: "Future start",
          notes: "",
          targetBucket: "next_action",
          contextIds: [],
          projectId: null,
          ruleType: "daily",
          dailyInterval: 1,
          weeklyInterval: 1,
          weeklyDays: [1],
          monthlyMode: "day_of_month",
          dayOfMonth: 1,
          nthWeek: 1,
          weekday: 1,
          scheduledTime: null,
          startDate: "2026-09-11",
          status: "active",
          lastGeneratedForDate: "2026-09-11",
          pendingMissedOccurrences: 0,
          statusChangedAt: "2026-09-07T00:00:00.000Z",
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
        });
        await repository.saveTask({
          id: "recurring-task:recurring-template:future",
          title: "Future start",
          notes: "",
          status: "active",
          bucket: "next_action",
          contextIds: [],
          projectId: null,
          parentTaskId: null,
          scheduledFor: null,
          deadline: null,
          recurringTemplateId: "recurring-template:future",
          recurrenceDueDate: "2026-09-11",
          isRecurringInstance: true,
          completedAt: null,
          recurrenceGroupId: null,
          pendingPastRecurrences: 0,
          plannedOrder: null,
          source: "manual",
          sourceExternalId: null,
          sourceUrl: null,
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-09-07");

        const tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks.find((task) => task.status === "active")).toBeUndefined();
        expect(tasks[0]).toMatchObject({ status: "cancelled" });
        const templates = await repository.listRecurringTaskTemplates();
        expect(templates[0]?.lastGeneratedForDate).toBeNull();
      });

      it("persists weekly reviews and computes weekly summaries from daily entries", async () => {
        const repository = await factory();

        const weekDates = [
          "2026-03-29",
          "2026-03-30",
          "2026-03-31",
          "2026-04-01",
          "2026-04-02",
          "2026-04-03",
          "2026-04-04",
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
            dimanche: "",
          },
          ritualChecklist: {
            bilan: true,
            budget: false,
            tempsEtPlan: false,
            collecte: false,
            calendrier: false,
            gtd: false,
            alignement: false,
            dimanche: true,
          },
          updatedAt: "2026-04-04T18:00:00.000Z",
        });

        await expect(repository.getWeeklyReview("2026-03-29")).resolves.toMatchObject({
          status: "closed",
          notes: expect.objectContaining({
            bilan: "Bonne semaine",
          }),
          ritualChecklist: expect.objectContaining({
            dimanche: true,
          }),
        });

        await expect(repository.computeWeeklyReviewSummary("2026-03-29")).resolves.toMatchObject({
          sleepAverage: 80,
          trcDaysRespected: 7,
          screenTimeTotalMinutes: 630,
          pomodorisTotal: 35,
          tasksAddedTotal: 28,
          tasksCompletedTotal: 21,
        });
      });

      it("persists monthly reviews and annual goals with linked snapshots", async () => {
        const repository = await factory();

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
            developpement: "",
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
            developpement: false,
          },
          updatedAt: "2026-05-02T18:00:00.000Z",
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
              blockers: "",
            },
          },
          measurementType: "numeric",
          status: "active",
          deadline: null,
          startingValue: null,
          direction: null,
          cadenceTarget: null,
          cadencePeriod: "week",
          principleKey: null,
          progressLog: {},
          milestones: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
          notes: expect.objectContaining({
            bilan: "Cap clair",
          }),
        });

        await expect(repository.computeMonthlyReviewSummary("2026-04")).resolves.toMatchObject({
          daysTracked: 3,
          sleepAverage: 81,
          pomodorisTotal: 15,
        });

        await expect(repository.computeAnnualGoalSnapshots(2026)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              goal: expect.objectContaining({
                title: "Sommeil annuel",
              }),
              sourceLabel: "Sommeil moyen hebdo",
            }),
          ]),
        );
      });

      it("round-trips progressLog and milestones on an annual goal", async () => {
        const repository = await factory();

        await repository.saveAnnualGoal({
          id: "goal-cumulative",
          title: "Lire 24 livres",
          dimension: "intellectuelle",
          description: "",
          targetValue: 24,
          unit: "livres",
          sourceId: null,
          manualCurrentValue: null,
          evaluations: {},
          measurementType: "cumulative",
          status: "active",
          deadline: null,
          startingValue: null,
          direction: null,
          cadenceTarget: null,
          cadencePeriod: "week",
          principleKey: null,
          progressLog: { "2026-01": 2, "2026-02": 3 },
          milestones: [
            { id: "milestone-1", title: "10 livres", completedAt: "2026-02-01", sortOrder: 0 },
            { id: "milestone-2", title: "24 livres", completedAt: null, sortOrder: 1 },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        const goals = await repository.listAnnualGoals();
        expect(goals[0].progressLog).toEqual({ "2026-01": 2, "2026-02": 3 });
        expect(goals[0].milestones).toEqual([
          { id: "milestone-1", title: "10 livres", completedAt: "2026-02-01", sortOrder: 0 },
          { id: "milestone-2", title: "24 livres", completedAt: null, sortOrder: 1 },
        ]);
      });

      it("persists weekly objectives and per-week manual results", async () => {
        const repository = await factory();

        const saved = await repository.saveWeeklyObjective({
          id: "",
          title: "Software Development",
          kind: "time",
          targetHours: 2,
          rescuetimeKind: "category",
          rescuetimeThing: "Software Development",
          sortOrder: 0,
          startsOnWeekStartDate: "2026-08-09",
          endsOnWeekStartDate: null,
          createdAt: "",
          updatedAt: "",
        });

        await repository.saveWeeklyObjectiveResult({
          weekStartDate: "2026-08-03",
          objectiveId: saved.id,
          achieved: false,
          updatedAt: "",
        });

        await expect(repository.listWeeklyObjectives()).resolves.toEqual([
          expect.objectContaining({
            id: saved.id,
            title: "Software Development",
            startsOnWeekStartDate: "2026-08-09",
          }),
        ]);

        await expect(repository.getWeeklyObjectiveResults("2026-08-03")).resolves.toEqual([
          expect.objectContaining({
            objectiveId: saved.id,
            achieved: false,
          }),
        ]);

        const manual = await repository.saveWeeklyObjective({
          id: "",
          title: "Budget review",
          kind: "manual",
          targetHours: null,
          rescuetimeKind: null,
          rescuetimeThing: null,
          sortOrder: 1,
          startsOnWeekStartDate: "2026-08-02",
          endsOnWeekStartDate: null,
          createdAt: "",
          updatedAt: "",
        });
        await repository.saveWeeklyObjectiveResult({
          weekStartDate: "2026-08-16",
          objectiveId: manual.id,
          achieved: true,
          updatedAt: "",
        });
        const afterDone = await repository.listWeeklyObjectives();
        expect(afterDone).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: saved.id, endsOnWeekStartDate: null }),
            expect.objectContaining({ id: manual.id, endsOnWeekStartDate: "2026-08-09" }),
          ]),
        );
        await repository.saveWeeklyObjectiveResult({
          weekStartDate: "2026-08-23",
          objectiveId: manual.id,
          achieved: true,
          updatedAt: "",
        });
        const afterStaleLaterWeek = await repository.listWeeklyObjectives();
        expect(afterStaleLaterWeek).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: manual.id, endsOnWeekStartDate: "2026-08-09" }),
          ]),
        );
        await repository.deleteWeeklyObjective(saved.id);
        await repository.deleteWeeklyObjective(manual.id);
        await expect(repository.listWeeklyObjectives()).resolves.toEqual([]);
        await expect(repository.getWeeklyObjectiveResults("2026-08-03")).resolves.toEqual([]);
      });

      it("persists two review_section_draft proposals atomically in one episode", async () => {
        const repository = await factory();
        const message = {
          id: "ai-message:episode",
          surface: "weekly_synthesis" as const,
          scopeKey: "2026-08-02",
          stance: null,
          kind: "weekly",
          inputHash: "hash",
          promptVersion: "weekly_synthesis.v1",
          model: "local",
          status: "skipped" as const,
          bodyJson: "{}",
          bodyText: "Local",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        };

        const saved = await repository.saveCoachPulseEpisode(message, [
          {
            id: "ai-proposal:draft-1",
            messageId: message.id,
            type: "review_section_draft",
            payloadJson: JSON.stringify({ sectionKey: "tempsEtPlan", text: "Plan" }),
            status: "pending",
            appliedEntityId: null,
            decidedAt: null,
            createdAt: "2026-08-29T08:00:00.000Z",
          },
          {
            id: "ai-proposal:draft-2",
            messageId: message.id,
            type: "review_section_draft",
            payloadJson: JSON.stringify({ sectionKey: "dimanche", text: "Dimanche" }),
            status: "pending",
            appliedEntityId: null,
            decidedAt: null,
            createdAt: "2026-08-29T08:00:00.000Z",
          },
        ]);

        expect(saved.proposals).toHaveLength(2);
        expect(saved.proposals.every((proposal) => proposal.type === "review_section_draft")).toBe(
          true,
        );
      });

      it("round-trips a pastor_verse message and keeps it out of listAiMessagesForDate", async () => {
        const repository = await factory();
        const message = {
          id: "ai-message:pastor",
          surface: "pastor_verse" as const,
          scopeKey: "pastor:2026-08-29",
          stance: null,
          kind: "daily",
          inputHash: "hash",
          promptVersion: "pastor_verse.v1",
          model: "local",
          status: "ok" as const,
          bodyJson: JSON.stringify({
            pick: "list",
            verseId: "php-4-6-7",
            reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
            principleKey: null,
            intent: "reinforcement",
            title: "Philippiens 4, 6-7",
            explanation: "Texte",
            practice: null,
          }),
          bodyText: "Philippiens 4, 6-7 — Titre",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        };

        const saved = await repository.saveCoachPulseEpisode(message, []);
        expect(saved.message.surface).toBe("pastor_verse");

        const latest = await repository.getLatestAiMessage(
          "pastor_verse",
          "pastor:2026-08-29",
          "ok",
        );
        expect(latest?.id).toBe("ai-message:pastor");

        // Regression: `listAiMessagesForDate` matches `scope_key = date OR LIKE 'date#%'`. A
        // `pastor:YYYY-MM-DD` scope key must never match, so the coach pulse engine never treats a
        // pastor row as one of its own slots for the day.
        const forDate = await repository.listAiMessagesForDate("2026-08-29");
        expect(forDate.find((item) => item.surface === "pastor_verse")).toBeUndefined();
      });

      describe("addPastorCustomVerse", () => {
        const candidate: CatalogVerse = {
          id: "custom-job-42-10",
          reference: { book: "JOB", chapter: 42, verseStart: 10, verseEnd: 10 },
          principleKeys: ["managedSolitude"],
          credoKeys: ["procheDeDieu"],
          note: "Apres l'epreuve, une restauration est possible.",
        };

        it("appends a new reference and returns added: true with the merged settings", async () => {
          const repository = await factory();
          await repository.initialize();

          const result = await repository.addPastorCustomVerse(candidate);

          expect(result.added).toBe(true);
          expect(result.settings.aiPastorCustomVerses).toEqual([candidate]);
          // The write is durable, not just returned — a fresh read sees the same merged settings.
          await expect(repository.getSettings()).resolves.toMatchObject({
            aiPastorCustomVerses: [candidate],
          });
        });

        it("is a no-op (added: false, settings unchanged) when the reference is already a custom verse", async () => {
          const repository = await factory();
          await repository.initialize();
          await repository.addPastorCustomVerse(candidate);

          const result = await repository.addPastorCustomVerse(candidate);

          expect(result.added).toBe(false);
          expect(result.settings.aiPastorCustomVerses).toEqual([candidate]);
          const settings = await repository.getSettings();
          expect(settings.aiPastorCustomVerses).toEqual([candidate]);
        });

        it("is a no-op (added: false, settings unchanged) when the reference already exists in the checked-in catalog", async () => {
          const repository = await factory();
          await repository.initialize();
          const checkedIn = loadVerseCatalog()[0];
          const duplicate: CatalogVerse = {
            id: "custom-duplicate",
            reference: checkedIn.reference,
            principleKeys: ["managedSolitude"],
            credoKeys: ["procheDeDieu"],
            note: "Une note differente pour la meme reference.",
          };

          const result = await repository.addPastorCustomVerse(duplicate);

          expect(result.added).toBe(false);
          expect(result.settings.aiPastorCustomVerses).toEqual([]);
          const settings = await repository.getSettings();
          expect(settings.aiPastorCustomVerses).toEqual([]);
        });

        it("preserves an unrelated settings field written between the caller's snapshot and the call", async () => {
          const repository = await factory();
          await repository.initialize();

          // Simulates the exact race this method exists to close: some other feature (pulse/backup)
          // reads settings, then — before it saves — this call reads-and-writes settings with a
          // freshly appended custom verse. The other feature's later `saveSettings` (built from its
          // now-stale snapshot) is a separate, still-open race (see docs/ai-settings-and-privacy.md's
          // "Settings save concurrency"); what `addPastorCustomVerse` itself must guarantee is that
          // its own write reflects the latest committed state, not a snapshot taken before some
          // other write already landed.
          const staleSnapshot = await repository.getSettings();
          await repository.saveSettings({
            ...staleSnapshot,
            lastBackupAt: "2026-09-13T08:00:00.000Z",
          });

          const result = await repository.addPastorCustomVerse(candidate);

          expect(result.settings.lastBackupAt).toBe("2026-09-13T08:00:00.000Z");
          expect(result.settings.aiPastorCustomVerses).toEqual([candidate]);
          const settings = await repository.getSettings();
          expect(settings.lastBackupAt).toBe("2026-09-13T08:00:00.000Z");
          expect(settings.aiPastorCustomVerses).toEqual([candidate]);
        });
      });

      it("getLatestAiMessage returns the newest matching scope even when many other rows exist", async () => {
        const repository = await factory();

        for (let index = 0; index < 25; index += 1) {
          await repository.saveAiMessage({
            id: `ai-message:other-${index}`,
            surface: "weekly_synthesis",
            scopeKey: "2026-07-05",
            stance: null,
            kind: "weekly",
            inputHash: `hash-other-${index}`,
            promptVersion: "weekly_synthesis.v1",
            model: "local",
            status: "ok",
            bodyJson: "{}",
            bodyText: "Other",
            deltaClass: null,
            notified: false,
            tokensPrompt: null,
            tokensCompletion: null,
            latencyMs: null,
            createdAt: `2026-08-29T09:00:${String(index).padStart(2, "0")}.000Z`,
          });
        }

        await repository.saveAiMessage({
          id: "ai-message:older-ok",
          surface: "weekly_synthesis",
          scopeKey: "2026-08-02",
          stance: null,
          kind: "weekly",
          inputHash: "hash-older",
          promptVersion: "weekly_synthesis.v1",
          model: "local",
          status: "ok",
          bodyJson: "{}",
          bodyText: "Older",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-08T10:00:00.000Z",
        });
        await repository.saveAiMessage({
          id: "ai-message:fallback",
          surface: "weekly_synthesis",
          scopeKey: "2026-08-02",
          stance: null,
          kind: "weekly",
          inputHash: "hash-fallback",
          promptVersion: "weekly_synthesis.v1",
          model: "local",
          status: "fallback",
          bodyJson: "{}",
          bodyText: "Fallback",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-08T12:00:00.000Z",
        });

        await expect(
          repository.getLatestAiMessage("weekly_synthesis", "2026-08-02"),
        ).resolves.toEqual(expect.objectContaining({ id: "ai-message:fallback" }));
        await expect(
          repository.getLatestAiMessage("weekly_synthesis", "2026-08-02", "ok"),
        ).resolves.toEqual(expect.objectContaining({ id: "ai-message:older-ok" }));
      });

      it("getLatestAiMessage breaks createdAt ties by id descending", async () => {
        const repository = await factory();
        const createdAt = "2026-08-08T12:00:00.000Z";

        await repository.saveAiMessage({
          id: "ai-message:z",
          surface: "weekly_synthesis",
          scopeKey: "2026-08-02",
          stance: null,
          kind: "weekly",
          inputHash: "hash-z",
          promptVersion: "weekly_synthesis.v1",
          model: "local",
          status: "ok",
          bodyJson: "{}",
          bodyText: "Z",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt,
        });
        await repository.saveAiMessage({
          id: "ai-message:a",
          surface: "weekly_synthesis",
          scopeKey: "2026-08-02",
          stance: null,
          kind: "weekly",
          inputHash: "hash-a",
          promptVersion: "weekly_synthesis.v1",
          model: "local",
          status: "ok",
          bodyJson: "{}",
          bodyText: "A",
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt,
        });

        await expect(
          repository.getLatestAiMessage("weekly_synthesis", "2026-08-02"),
        ).resolves.toEqual(expect.objectContaining({ id: "ai-message:z" }));
      });

      it("acceptAiWeeklyObjectiveProposal is idempotent", async () => {
        const repository = await factory();
        const proposal = {
          id: "ai-proposal:objective",
          messageId: "ai-message:weekly",
          type: "weekly_objective" as const,
          payloadJson: JSON.stringify({
            title: "Lire 2h",
            kind: "manual",
            targetHours: null,
            rescuetimeKind: null,
            rescuetimeThing: null,
          }),
          status: "pending" as const,
          appliedEntityId: null,
          decidedAt: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        };
        await repository.saveAiProposal(proposal);
        const objective = {
          id: "weekly-objective:objective",
          title: "Lire 2h",
          kind: "manual" as const,
          targetHours: null,
          rescuetimeKind: null,
          rescuetimeThing: null,
          sortOrder: 0,
          startsOnWeekStartDate: null,
          endsOnWeekStartDate: null,
          createdAt: "2026-08-29T08:00:00.000Z",
          updatedAt: "2026-08-29T08:00:00.000Z",
        };

        const first = await repository.acceptAiWeeklyObjectiveProposal(proposal, objective);
        const second = await repository.acceptAiWeeklyObjectiveProposal(proposal, objective);

        expect(first.objective.id).toBe(second.objective.id);
        expect(await repository.listWeeklyObjectives()).toHaveLength(1);
      });

      it("acceptAiMonthlyReviewSectionDraftProposal is idempotent", async () => {
        const repository = await factory();
        const proposal = {
          id: "ai-proposal:monthly-section",
          messageId: "ai-message:monthly",
          type: "review_section_draft" as const,
          payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Note mensuelle" }),
          status: "pending" as const,
          appliedEntityId: null,
          decidedAt: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        };
        await repository.saveAiProposal(proposal);
        const review = {
          monthKey: "2026-04",
          monthStartDate: "2026-04-01",
          monthEndDate: "2026-04-30",
          status: "draft" as const,
          notes: {
            bilan: "Note mensuelle",
            journaux: "",
            finances: "",
            temps: "",
            progressionObjectifs: "",
            missionObjectifs: "",
            nettoyageListes: "",
            calendrier: "",
            grosProjets: "",
            developpement: "",
          },
          ritualChecklist: {
            bilan: false,
            journaux: false,
            finances: false,
            temps: false,
            progressionObjectifs: false,
            missionObjectifs: false,
            nettoyageListes: false,
            calendrier: false,
            grosProjets: false,
            developpement: false,
          },
          updatedAt: "2026-08-29T08:00:00.000Z",
        };

        const first = await repository.acceptAiMonthlyReviewSectionDraftProposal(proposal, review);
        const second = await repository.acceptAiMonthlyReviewSectionDraftProposal(proposal, review);

        expect(first.review.monthKey).toBe(second.review.monthKey);
        expect(first.proposal.status).toBe("accepted");
        expect(second.proposal.status).toBe("accepted");
        await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
          notes: expect.objectContaining({ bilan: "Note mensuelle" }),
        });
      });

      it("acceptAiGtdActionProposal skips completed tasks", async () => {
        const repository = await factory();
        const timestamp = "2026-08-29T12:00:00.000Z";
        await repository.saveTask({
          id: "task:done",
          title: "Done",
          notes: "",
          status: "completed",
          bucket: "next_action",
          contextIds: [],
          projectId: null,
          parentTaskId: null,
          scheduledFor: null,
          deadline: null,
          recurringTemplateId: null,
          recurrenceDueDate: null,
          isRecurringInstance: false,
          completedAt: timestamp,
          recurrenceGroupId: null,
          pendingPastRecurrences: 0,
          plannedOrder: null,
          source: "manual",
          sourceExternalId: null,
          sourceUrl: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        const proposal = {
          id: "ai-proposal:gtd",
          messageId: "ai-message:gtd",
          type: "gtd_action" as const,
          payloadJson: JSON.stringify({ taskId: "task:done", action: "drop", reason: "Stale" }),
          status: "pending" as const,
          appliedEntityId: null,
          decidedAt: null,
          createdAt: timestamp,
        };
        await repository.saveAiProposal(proposal);

        const result = await repository.acceptAiGtdActionProposal(proposal, "2026-08-29");
        expect(result.taskId).toBeNull();
        expect(result.proposal.status).toBe("pending");
      });

      it("listDailyEntriesOnOrBefore returns history ending at the requested date", async () => {
        const repository = await factory();

        for (const date of ["2026-01-01", "2026-06-01", "2026-12-01"]) {
          await repository.saveDailyEntry(createEmptyDailyEntry(date));
        }

        const entries = await repository.listDailyEntriesOnOrBefore("2026-06-01", 10);
        expect(entries.map((entry) => entry.date)).toEqual(["2026-06-01", "2026-01-01"]);
      });

      it("listDailyEntriesInRange returns inclusive dates inside the window", async () => {
        const repository = await factory();

        for (const date of ["2026-03-31", "2026-04-01", "2026-04-30", "2026-05-01"]) {
          await repository.saveDailyEntry(createEmptyDailyEntry(date));
        }

        const entries = await repository.listDailyEntriesInRange("2026-04-01", "2026-04-30");
        expect(entries.map((entry) => entry.date)).toEqual(["2026-04-30", "2026-04-01"]);
      });

      it("listDailyEntriesInRange does not recompute daily task or pomodoro stats", async () => {
        const repository = await factory();

        for (const date of ["2026-04-01", "2026-04-02"]) {
          await repository.saveDailyEntry(createEmptyDailyEntry(date));
        }

        const taskSpy = vi.spyOn(repository, "computeDailyTaskStats");
        const pomodoroSpy = vi.spyOn(repository, "computeDailyPomodoroStats");

        await repository.listDailyEntriesInRange("2026-04-01", "2026-04-02");

        expect(taskSpy).not.toHaveBeenCalled();
        expect(pomodoroSpy).not.toHaveBeenCalled();
      });

      it("listWeeklyReviewsOverlapping includes a week that started the previous month", async () => {
        const repository = await factory();

        await repository.saveWeeklyReview(createEmptyWeeklyReview("2026-03-22"));
        await repository.saveWeeklyReview(createEmptyWeeklyReview("2026-03-29"));

        const reviews = await repository.listWeeklyReviewsOverlapping("2026-04-01", "2026-04-30");
        expect(reviews.map((review) => review.weekStartDate)).toEqual(["2026-03-29"]);
      });

      it("listMonthlyReviewsOverlapping includes months that touch the window", async () => {
        const repository = await factory();

        await repository.saveMonthlyReview(createEmptyMonthlyReview("2026-03"));
        await repository.saveMonthlyReview(createEmptyMonthlyReview("2026-04"));
        await repository.saveMonthlyReview(createEmptyMonthlyReview("2026-05"));

        const reviews = await repository.listMonthlyReviewsOverlapping("2026-04-01", "2026-04-30");
        expect(reviews.map((review) => review.monthKey)).toEqual(["2026-04"]);
      });

      // Parity regression (issue #106): `listTaskEvents` must return events in chronological
      // `eventAt` order in every implementation, not incidental insertion/table order.
      it("listTaskEvents returns events ordered by eventAt regardless of insertion order", async () => {
        const repository = await factory();

        const later = await repository.createTask({
          id: "task-later",
          title: "Plus tard",
          bucket: "next_action",
        });
        await repository.saveTask({ ...later, updatedAt: "2026-06-01T09:00:00.000Z" });

        const earlier = await repository.createTask({
          id: "task-earlier",
          title: "Plus tot",
          bucket: "next_action",
        });
        await repository.saveTask({ ...earlier, updatedAt: "2026-01-01T09:00:00.000Z" });

        const events = await repository.listTaskEvents({ types: ["task_created"] });
        const eventAts = events.map((event) => event.eventAt);
        expect(eventAts).toEqual([...eventAts].sort((a, b) => a.localeCompare(b)));
        expect(events.map((event) => event.taskId)).toEqual(["task-later", "task-earlier"]);
      });

      // Parity regression (issue #106): a new recurrence occurrence must pick up the template's
      // *current* contextIds/projectId, even when the previous occurrence had its contextIds or
      // projectId edited independently (an "occurrence"-scope edit, or any other direct save).
      // Title/notes are the one exception — those are deliberately carried over from the active
      // task so occurrence-level renames survive regeneration.
      it("generateDueRecurringTasks reapplies the template's current contextIds/projectId on the next occurrence", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));

        const repository = await factory();
        await repository.saveContext({
          id: "context:office",
          name: "Bureau",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
        await repository.saveContext({
          id: "context:home",
          name: "Maison",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:standup-context",
          title: "Standup",
          notes: "",
          targetBucket: "next_action",
          contextIds: ["context:office"],
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
          updatedAt: "2026-04-01T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-04-01");
        const [generated] = await repository.listTasks({ includeCompleted: true });
        expect(generated.contextIds).toEqual(["context:office"]);

        // Directly edit the active occurrence's contextIds and title, independent of the
        // template (equivalent to an `applyRecurringEditScope(..., "occurrence", ...)` edit).
        await repository.saveTask({
          ...generated,
          contextIds: ["context:home"],
          title: "Standup (renomme)",
        });

        // Advance to the next due day: a fresh occurrence is generated on the *same* task row.
        vi.setSystemTime(new Date("2026-04-02T12:00:00.000Z"));
        await repository.generateDueRecurringTasks("2026-04-02");

        const [regenerated] = await repository.listTasks({ includeCompleted: true });
        expect(regenerated.contextIds).toEqual(["context:office"]);
        expect(regenerated.title).toBe("Standup (renomme)");
      });
    });

    describe("planned tasks", () => {
      const makeProject = async (
        repository: AppRepository,
        id: string,
        status: "active" | "on_hold" = "active",
      ) =>
        repository.saveProject({
          id,
          title: `Projet ${id}`,
          status,
          statusChangedAt: "2026-01-01T00:00:00.000Z",
          notes: "",
          contextIds: [],
          source: "manual",
          sourceExternalId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

      it("rejects a projectless planned task on create", async () => {
        const repository = await factory();

        await expect(
          repository.createTask({ title: "Sans projet", bucket: "planned" }),
        ).rejects.toThrow();
      });

      it("rejects a planned task creation referencing a project that does not exist", async () => {
        const repository = await factory();

        await expect(
          repository.createTask({
            title: "Orpheline",
            bucket: "planned",
            projectId: "project:missing",
          }),
        ).rejects.toThrow();
      });

      it("rejects saving a task into Planned when its project does not exist", async () => {
        const repository = await factory();
        await makeProject(repository, "project:planned-save");

        const task = await repository.createTask({
          title: "A basculer",
          bucket: "next_action",
          projectId: "project:planned-save",
        });

        await expect(
          repository.saveTask({ ...task, bucket: "planned", projectId: "project:missing" }),
        ).rejects.toThrow();
      });

      it("rejects reassigning a Planned task to a project that does not exist", async () => {
        const repository = await factory();
        await makeProject(repository, "project:planned-reassign");
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:planned-reassign",
        });

        const planned = await repository.createTask({
          title: "A reassigner",
          bucket: "planned",
          projectId: "project:planned-reassign",
        });

        await expect(
          repository.saveTask({ ...planned, projectId: "project:missing" }),
        ).rejects.toThrow();
      });

      it("does not coerce a Planned task with scheduledFor into Scheduled on create", async () => {
        const repository = await factory();
        await makeProject(repository, "project:planned-create");
        // Keep an existing active next action so the new planned task is not itself
        // immediately auto-promoted, which would otherwise obscure the bucket assertion below.
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:planned-create",
        });

        const task = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:planned-create",
          scheduledFor: "2026-05-01T09:00:00.000Z",
        });

        expect(task.bucket).toBe("planned");
        expect(task.scheduledFor).toBe("2026-05-01T09:00:00.000Z");
        expect(task.plannedOrder).toBe(0);
      });

      it("appends new planned tasks in contiguous order and auto-promotes the first when eligible", async () => {
        const repository = await factory();
        await makeProject(repository, "project:queue");

        const first = await repository.createTask({
          title: "Un",
          bucket: "planned",
          projectId: "project:queue",
        });
        const second = await repository.createTask({
          title: "Deux",
          bucket: "planned",
          projectId: "project:queue",
        });

        // The project had zero active next actions, so the first planned task is auto-promoted
        // immediately after being durably inserted.
        const tasks = await repository.listTasks({
          projectId: "project:queue",
          includeCompleted: true,
        });
        const promoted = tasks.find((task) => task.id === first.id)!;
        const remaining = tasks.find((task) => task.id === second.id)!;
        expect(promoted.bucket).toBe("next_action");
        expect(promoted.plannedOrder).toBeNull();
        expect(remaining.bucket).toBe("planned");
        expect(remaining.plannedOrder).toBe(0);
      });

      it("does not auto-promote for an inactive project", async () => {
        const repository = await factory();
        await makeProject(repository, "project:paused", "on_hold");

        const task = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:paused",
        });

        expect(task.bucket).toBe("planned");
      });

      it("promotePlannedTask explicitly promotes without touching sibling order semantics", async () => {
        const repository = await factory();
        await makeProject(repository, "project:manual");
        await repository.createTask({
          title: "Existante",
          bucket: "next_action",
          projectId: "project:manual",
        });
        const planned = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:manual",
        });

        // A next action already exists, so creation itself must not have auto-promoted it.
        expect(planned.bucket).toBe("planned");

        const promoted = await repository.promotePlannedTask(planned.id);
        expect(promoted.bucket).toBe("next_action");
        expect(promoted.scheduledFor).toBeNull();
        expect(promoted.plannedOrder).toBeNull();
      });

      it("rejects promoting a task from an inactive project", async () => {
        const repository = await factory();
        await makeProject(repository, "project:onhold", "on_hold");
        const planned = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:onhold",
        });

        await expect(repository.promotePlannedTask(planned.id)).rejects.toThrow();
      });

      it("movePlannedTask swaps adjacent siblings and is a no-op at boundaries", async () => {
        const repository = await factory();
        await makeProject(repository, "project:order");
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:order",
        });
        const a = await repository.createTask({
          title: "A",
          bucket: "planned",
          projectId: "project:order",
        });
        const b = await repository.createTask({
          title: "B",
          bucket: "planned",
          projectId: "project:order",
        });

        const swapped = await repository.movePlannedTask(b.id, "up");
        expect(swapped.find((task) => task.id === a.id)?.plannedOrder).toBe(1);
        expect(swapped.find((task) => task.id === b.id)?.plannedOrder).toBe(0);

        const boundary = await repository.movePlannedTask(b.id, "up");
        expect(boundary).toHaveLength(1);
      });

      it("rejects a cross-project move as a no-op-safe error", async () => {
        const repository = await factory();
        await makeProject(repository, "project:x");
        const task = await repository.createTask({
          title: "Solo",
          bucket: "next_action",
          projectId: "project:x",
        });

        await expect(repository.movePlannedTask(task.id, "up")).rejects.toThrow();
      });

      it("moving a planned task to another project appends at destination and compacts the source", async () => {
        const repository = await factory();
        await makeProject(repository, "project:src");
        await makeProject(repository, "project:dst");
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:src",
        });
        await repository.createTask({
          title: "Bloqueur2",
          bucket: "next_action",
          projectId: "project:dst",
        });
        const a = await repository.createTask({
          title: "A",
          bucket: "planned",
          projectId: "project:src",
        });
        const b = await repository.createTask({
          title: "B",
          bucket: "planned",
          projectId: "project:src",
        });

        await repository.saveTask({ ...a, projectId: "project:dst" });

        const tasks = await repository.listTasks({ includeCompleted: true });
        const movedA = tasks.find((task) => task.id === a.id)!;
        const compactedB = tasks.find((task) => task.id === b.id)!;
        expect(movedA.projectId).toBe("project:dst");
        expect(movedA.plannedOrder).toBe(0);
        expect(compactedB.plannedOrder).toBe(0);
      });

      it("completing the only next action auto-promotes the earliest planned task", async () => {
        const repository = await factory();
        await makeProject(repository, "project:complete");
        const active = await repository.createTask({
          title: "Active",
          bucket: "next_action",
          projectId: "project:complete",
        });
        const planned = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:complete",
        });

        await repository.completeTask(active.id);

        const tasks = await repository.listTasks({
          projectId: "project:complete",
          includeCompleted: true,
        });
        expect(tasks.find((task) => task.id === planned.id)?.bucket).toBe("next_action");
      });

      it("scheduleTask on an active Planned task preserves bucket while setting or clearing the date", async () => {
        const repository = await factory();
        await makeProject(repository, "project:sched");
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:sched",
        });
        const planned = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:sched",
        });

        const withDate = await repository.scheduleTask(planned.id, "2026-06-01T09:00:00.000Z");
        expect(withDate.bucket).toBe("planned");
        expect(withDate.scheduledFor).toBe("2026-06-01T09:00:00.000Z");

        const cleared = await repository.scheduleTask(planned.id, null);
        expect(cleared.bucket).toBe("planned");
        expect(cleared.scheduledFor).toBeNull();
      });

      it("acceptAiGtdActionProposal remains idempotent and reconciles the project atomically", async () => {
        const repository = await factory();
        await makeProject(repository, "project:ai");
        const active = await repository.createTask({
          title: "Active",
          bucket: "next_action",
          projectId: "project:ai",
          id: "task:ai-active",
        });
        await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:ai",
          id: "task:ai-planned",
        });

        const proposal = {
          id: "ai-proposal:drop",
          messageId: "ai-message:drop",
          type: "gtd_action" as const,
          payloadJson: JSON.stringify({ taskId: active.id, action: "drop", reason: "Obsolete" }),
          status: "pending" as const,
          appliedEntityId: null,
          decidedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
        };
        await repository.saveAiProposal(proposal);

        const first = await repository.acceptAiGtdActionProposal(proposal, "2026-06-01");
        expect(first.taskId).toBe(active.id);
        expect(first.proposal.status).toBe("accepted");

        const afterDrop = await repository.listTasks({
          projectId: "project:ai",
          includeCompleted: true,
        });
        expect(afterDrop.find((task) => task.id === "task:ai-planned")?.bucket).toBe("next_action");

        const second = await repository.acceptAiGtdActionProposal(proposal, "2026-06-01");
        expect(second.proposal.status).toBe("accepted");
        expect(second.taskId).toBe(active.id);

        // A repeat call must not promote yet another planned task.
        const afterSecond = await repository.listTasks({
          projectId: "project:ai",
          includeCompleted: true,
        });
        const activeNextActionCount = afterSecond.filter(
          (task) => task.status === "active" && task.bucket === "next_action",
        ).length;
        expect(activeNextActionCount).toBe(1);
      });
    });

    describe("scheduled date promotion", () => {
      const makeProject = async (repository: AppRepository, id: string) =>
        repository.saveProject({
          id,
          title: `Projet ${id}`,
          status: "active",
          statusChangedAt: "2026-01-01T00:00:00.000Z",
          notes: "",
          contextIds: [],
          source: "manual",
          sourceExternalId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });

      it("promotes due and overdue scheduled tasks, clears scheduledFor, and is idempotent", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-12T18:00:00.000Z"));

        const repository = await factory();
        const due = await repository.createTask({
          title: "Due today",
          bucket: "scheduled",
          scheduledFor: "2026-01-12T15:00:00",
        });
        const overdue = await repository.createTask({
          title: "Overdue",
          bucket: "scheduled",
          scheduledFor: "2026-01-05T09:00:00",
        });
        const future = await repository.createTask({
          title: "Tomorrow",
          bucket: "scheduled",
          scheduledFor: "2026-01-13T09:00:00",
        });

        const firstCount = await repository.promoteDueScheduledTasks("2026-01-12");
        expect(firstCount).toBe(2);
        const secondCount = await repository.promoteDueScheduledTasks("2026-01-12");
        expect(secondCount).toBe(0);

        const tasks = await repository.listTasks({ includeCompleted: true });
        expect(tasks.find((task) => task.id === due.id)).toMatchObject({
          bucket: "next_action",
          scheduledFor: null,
        });
        expect(tasks.find((task) => task.id === overdue.id)).toMatchObject({
          bucket: "next_action",
          scheduledFor: null,
        });
        expect(tasks.find((task) => task.id === future.id)).toMatchObject({
          bucket: "scheduled",
          scheduledFor: "2026-01-13T09:00:00",
        });

        const breakdown = await repository.getDailyTaskBreakdown("2026-01-12");
        expect(breakdown.addedTasks.map((task) => task.id)).toEqual(
          expect.arrayContaining([due.id, overdue.id]),
        );
      });

      it("does not promote a planned task whose reused date has arrived", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-12T18:00:00.000Z"));

        const repository = await factory();
        await makeProject(repository, "project:planned-date");
        await repository.createTask({
          title: "Bloqueur",
          bucket: "next_action",
          projectId: "project:planned-date",
        });
        const planned = await repository.createTask({
          title: "Planifiee",
          bucket: "planned",
          projectId: "project:planned-date",
          scheduledFor: "2026-01-12T15:00:00",
        });

        expect(await repository.promoteDueScheduledTasks("2026-01-12")).toBe(0);
        const stored = await repository.listTasks({ includeCompleted: true });
        expect(stored.find((task) => task.id === planned.id)).toMatchObject({
          bucket: "planned",
          scheduledFor: "2026-01-12T15:00:00",
        });
      });

      it("promotes a just-generated due scheduled recurrence when run after generation", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-12T18:00:00.000Z"));

        const repository = await factory();
        await repository.saveRecurringTaskTemplate({
          id: "recurring-template:standup",
          title: "Standup",
          notes: "",
          targetBucket: "scheduled",
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
          scheduledTime: "09:00",
          startDate: "2026-01-12",
          status: "active",
          lastGeneratedForDate: null,
          pendingMissedOccurrences: 0,
          statusChangedAt: "2026-01-12T00:00:00.000Z",
          createdAt: "2026-01-12T00:00:00.000Z",
          updatedAt: "2026-01-12T00:00:00.000Z",
        });

        await repository.generateDueRecurringTasks("2026-01-12");
        expect(await repository.promoteDueScheduledTasks("2026-01-12")).toBe(1);
        const after = await repository.listTasks({ includeCompleted: true });
        expect(after[0]).toMatchObject({
          bucket: "next_action",
          scheduledFor: null,
          isRecurringInstance: true,
          recurrenceDueDate: "2026-01-12",
        });
      });

      it("does not promote a future scheduled task when computing stats for that future date", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-12T18:00:00.000Z"));

        const repository = await factory();
        await repository.createTask({
          title: "Future",
          bucket: "scheduled",
          scheduledFor: "2026-01-20T09:00:00",
        });

        await repository.computeDailyTaskStats("2026-01-20");

        expect(await repository.promoteDueScheduledTasks("2026-01-20")).toBe(1);
      });
    });

    describe("RescueTime snapshot cache", () => {
      const entry = (overrides: Partial<RescueTimeSnapshotCacheEntry> = {}) => ({
        weekStartDate: "2026-08-02",
        kind: "goals" as const,
        credentialFingerprint: "fp-a",
        payloadJson: JSON.stringify({ items: [] }),
        fetchedAt: "2026-08-05T10:00:00.000Z",
        ...overrides,
      });

      it("returns null on a miss and round-trips a saved entry", async () => {
        const repository = await factory();
        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toBeNull();

        await repository.saveRescueTimeSnapshotCache(entry());

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toEqual(entry());
      });

      it("normalizes the week start on write and read", async () => {
        const repository = await factory();
        await repository.saveRescueTimeSnapshotCache(entry({ weekStartDate: "2026-08-05" }));

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-04", "goals", "fp-a"),
        ).resolves.toMatchObject({ weekStartDate: "2026-08-02" });
      });

      it("upserts on the same key", async () => {
        const repository = await factory();
        await repository.saveRescueTimeSnapshotCache(entry({ payloadJson: '{"pulse":1}' }));
        await repository.saveRescueTimeSnapshotCache(
          entry({ payloadJson: '{"pulse":2}', fetchedAt: "2026-08-06T10:00:00.000Z" }),
        );

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toMatchObject({
          payloadJson: '{"pulse":2}',
          fetchedAt: "2026-08-06T10:00:00.000Z",
        });
      });

      it("isolates entries per fingerprint and kind", async () => {
        const repository = await factory();
        await repository.saveRescueTimeSnapshotCache(entry({ payloadJson: "A" }));
        await repository.saveRescueTimeSnapshotCache(
          entry({ credentialFingerprint: "fp-b", payloadJson: "B" }),
        );

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toMatchObject({ payloadJson: "A" });
        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-b"),
        ).resolves.toMatchObject({ payloadJson: "B" });
        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "pulse", "fp-a"),
        ).resolves.toBeNull();
      });

      it("prune keeps only the given fingerprint", async () => {
        const repository = await factory();
        await repository.saveRescueTimeSnapshotCache(entry());
        await repository.saveRescueTimeSnapshotCache(entry({ credentialFingerprint: "fp-b" }));

        await repository.pruneRescueTimeSnapshotCache("fp-b");

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toBeNull();
        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-b"),
        ).resolves.not.toBeNull();
      });

      it("prune with null clears everything", async () => {
        const repository = await factory();
        await repository.saveRescueTimeSnapshotCache(entry());
        await repository.saveRescueTimeSnapshotCache(entry({ credentialFingerprint: "fp-b" }));

        await repository.pruneRescueTimeSnapshotCache(null);

        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-a"),
        ).resolves.toBeNull();
        await expect(
          repository.getRescueTimeSnapshotCache("2026-08-02", "goals", "fp-b"),
        ).resolves.toBeNull();
      });

      describe("mergeRescueTimeObjectiveSecondsCache", () => {
        const readMerged = async (repository: AppRepository, fingerprint = "fp-a") => {
          const cached = await repository.getRescueTimeSnapshotCache(
            "2026-08-02",
            "objective_seconds",
            fingerprint,
          );
          return cached ? JSON.parse(cached.payloadJson) : null;
        };

        it("keeps disjoint ids from two overlapping merges", async () => {
          const repository = await factory();
          await Promise.all([
            repository.mergeRescueTimeObjectiveSecondsCache({
              weekStartDate: "2026-08-02",
              credentialFingerprint: "fp-a",
              values: { one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" } },
              fetchedAt: "2026-08-03T10:00:00.000Z",
            }),
            repository.mergeRescueTimeObjectiveSecondsCache({
              weekStartDate: "2026-08-02",
              credentialFingerprint: "fp-a",
              values: { two: { seconds: 20, fetchedAt: "2026-08-03T10:00:01.000Z" } },
              fetchedAt: "2026-08-03T10:00:01.000Z",
            }),
          ]);

          await expect(readMerged(repository)).resolves.toEqual({
            one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" },
            two: { seconds: 20, fetchedAt: "2026-08-03T10:00:01.000Z" },
          });
        });

        it("lets the call queued later win for the same id", async () => {
          const repository = await factory();
          await Promise.all([
            repository.mergeRescueTimeObjectiveSecondsCache({
              weekStartDate: "2026-08-02",
              credentialFingerprint: "fp-a",
              values: { one: { seconds: 1, fetchedAt: "2026-08-03T10:00:00.000Z" } },
              fetchedAt: "2026-08-03T10:00:00.000Z",
            }),
            repository.mergeRescueTimeObjectiveSecondsCache({
              weekStartDate: "2026-08-02",
              credentialFingerprint: "fp-a",
              values: { one: { seconds: 2, fetchedAt: "2026-08-03T11:00:00.000Z" } },
              fetchedAt: "2026-08-03T11:00:00.000Z",
            }),
          ]);

          await expect(readMerged(repository)).resolves.toEqual({
            one: { seconds: 2, fetchedAt: "2026-08-03T11:00:00.000Z" },
          });
        });

        it("keeps the original fetchedAt of retained ids", async () => {
          const repository = await factory();
          await repository.mergeRescueTimeObjectiveSecondsCache({
            weekStartDate: "2026-08-02",
            credentialFingerprint: "fp-a",
            values: { one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" } },
            fetchedAt: "2026-08-03T10:00:00.000Z",
          });
          await repository.mergeRescueTimeObjectiveSecondsCache({
            weekStartDate: "2026-08-02",
            credentialFingerprint: "fp-a",
            values: { two: { seconds: 20, fetchedAt: "2026-08-05T10:00:00.000Z" } },
            fetchedAt: "2026-08-05T10:00:00.000Z",
          });

          const merged = await readMerged(repository);
          expect(merged.one.fetchedAt).toBe("2026-08-03T10:00:00.000Z");
          expect(merged.two.fetchedAt).toBe("2026-08-05T10:00:00.000Z");
          await expect(
            repository.getRescueTimeSnapshotCache("2026-08-02", "objective_seconds", "fp-a"),
          ).resolves.toMatchObject({ fetchedAt: "2026-08-05T10:00:00.000Z" });
        });

        it("replaces a corrupt existing payload instead of throwing", async () => {
          const repository = await factory();
          await repository.saveRescueTimeSnapshotCache(
            entry({ kind: "objective_seconds", payloadJson: "{not json" }),
          );

          await repository.mergeRescueTimeObjectiveSecondsCache({
            weekStartDate: "2026-08-02",
            credentialFingerprint: "fp-a",
            values: { one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" } },
            fetchedAt: "2026-08-03T10:00:00.000Z",
          });

          await expect(readMerged(repository)).resolves.toEqual({
            one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" },
          });
        });

        it("does not mix fingerprints", async () => {
          const repository = await factory();
          await repository.mergeRescueTimeObjectiveSecondsCache({
            weekStartDate: "2026-08-02",
            credentialFingerprint: "fp-a",
            values: { one: { seconds: 10, fetchedAt: "2026-08-03T10:00:00.000Z" } },
            fetchedAt: "2026-08-03T10:00:00.000Z",
          });

          await expect(readMerged(repository, "fp-b")).resolves.toBeNull();
        });
      });
    });

    describe("mid-week decisions", () => {
      const snapshot = (asOfDate = "2026-08-05"): MidWeekLaggingSnapshot => ({
        version: 1,
        asOfDate,
        completedDays: 3,
        signals: [
          {
            key: "metric:pomodoris",
            category: "metric",
            label: "Pomodoris",
            direction: "more",
            status: "lagging",
            actual: 8,
            expected: 24,
            weekTarget: 56,
            unit: "sessions",
            daysApplicable: 3,
            daysWithData: 3,
            hasFullCoverage: true,
          },
        ],
      });

      it("returns null on a miss", async () => {
        const repository = await factory();
        await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toBeNull();
      });

      it("round-trips with and without a snapshot, normalizing a Wednesday to its Sunday", async () => {
        const repository = await factory();
        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-05",
          decisions: "Couper le téléphone",
          decidedOnDate: "2026-08-05",
          updatedAt: "2026-08-05T10:00:00.000Z",
        });
        await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toEqual({
          weekStartDate: "2026-08-02",
          decisions: "Couper le téléphone",
          decidedOnDate: "2026-08-05",
          laggingSnapshot: null,
          updatedAt: "2026-08-05T10:00:00.000Z",
        });

        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-09",
          decisions: "Avec snapshot",
          decidedOnDate: "2026-08-12",
          updatedAt: "2026-08-12T10:00:00.000Z",
          laggingSnapshot: snapshot("2026-08-12"),
        });
        await expect(repository.getMidWeekDecisions("2026-08-11")).resolves.toMatchObject({
          weekStartDate: "2026-08-09",
          laggingSnapshot: snapshot("2026-08-12"),
        });
      });

      it("replaces text, dates, snapshot and updatedAt on an upsert with a snapshot", async () => {
        const repository = await factory();
        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-02",
          decisions: "A",
          decidedOnDate: "2026-08-05",
          updatedAt: "2026-08-05T10:00:00.000Z",
          laggingSnapshot: snapshot("2026-08-05"),
        });
        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-02",
          decisions: "B",
          decidedOnDate: "2026-08-06",
          updatedAt: "2026-08-06T10:00:00.000Z",
          laggingSnapshot: snapshot("2026-08-06"),
        });
        await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toEqual({
          weekStartDate: "2026-08-02",
          decisions: "B",
          decidedOnDate: "2026-08-06",
          laggingSnapshot: snapshot("2026-08-06"),
          updatedAt: "2026-08-06T10:00:00.000Z",
        });
      });

      it("keeps the stored snapshot on an upsert without one", async () => {
        const repository = await factory();
        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-02",
          decisions: "A",
          decidedOnDate: "2026-08-05",
          updatedAt: "2026-08-05T10:00:00.000Z",
          laggingSnapshot: snapshot(),
        });
        await repository.saveMidWeekDecisions({
          weekStartDate: "2026-08-02",
          decisions: "B",
          decidedOnDate: "2026-08-07",
          updatedAt: "2026-08-07T10:00:00.000Z",
        });
        await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toEqual({
          weekStartDate: "2026-08-02",
          decisions: "B",
          decidedOnDate: "2026-08-07",
          laggingSnapshot: snapshot(),
          updatedAt: "2026-08-07T10:00:00.000Z",
        });
      });
    });

    describe("finance", () => {
      const person = (overrides: Partial<FinancePerson> = {}): FinancePerson => ({
        id: "",
        displayName: "Alex",
        color: null,
        archived: false,
        createdAt: "",
        updatedAt: "",
        ...overrides,
      });

      const account = (overrides: Partial<FinanceAccount> = {}): FinanceAccount => ({
        id: "",
        name: "Compte chèques",
        institution: null,
        type: "checking",
        currency: "CAD",
        ownerPersonId: null,
        ownership: "individual",
        onBudget: true,
        closed: false,
        openingBalanceMinor: 0,
        currentBalanceMinor: null,
        balanceAsOf: null,
        externalKey: null,
        notes: null,
        sortOrder: 0,
        createdAt: "",
        updatedAt: "",
        ...overrides,
      });

      const buildFinanceTransaction = (
        overrides: Partial<FinanceTransaction> = {},
      ): FinanceTransaction => ({
        id: "",
        accountId: "account-1",
        postedDate: "2026-04-01",
        amountMinor: -1234,
        currency: "CAD",
        descriptionRaw: "IGA MONTREAL",
        descriptionOriginal: null,
        merchantKey: "IGA MONTREAL",
        merchantDisplay: null,
        categoryId: "fincat:non-categorise",
        categorySource: "default",
        categoryConfidence: null,
        categorizedAt: null,
        personId: null,
        notes: null,
        labelsJson: null,
        pending: false,
        isTransfer: false,
        transferGroupId: null,
        excludedFromBudget: false,
        excludedFromReports: false,
        hasSplits: false,
        importBatchId: null,
        dedupeHash: `dedupe-${overrides.id ?? Math.random()}`,
        sourceRowJson: null,
        createdAt: "",
        updatedAt: "",
        ...overrides,
      });

      const importRow = (overrides: Partial<FinanceImportRow> = {}): FinanceImportRow => ({
        accountId: "account-1",
        postedDate: "2026-04-01",
        amountMinor: -1234,
        currency: "CAD",
        descriptionRaw: "IGA MONTREAL",
        descriptionOriginal: null,
        merchantKey: "IGA MONTREAL",
        categoryHint: null,
        personId: null,
        notes: null,
        labelsJson: null,
        sourceRowJson: null,
        ...overrides,
      });

      it("creates a person and an account", async () => {
        const repository = await factory();
        const savedPerson = await repository.saveFinancePerson(person());
        const savedAccount = await repository.saveFinanceAccount(
          account({ ownerPersonId: savedPerson.id }),
        );

        await expect(repository.listFinancePeople()).resolves.toEqual([
          expect.objectContaining({ id: savedPerson.id, displayName: "Alex" }),
        ]);
        await expect(repository.listFinanceAccounts()).resolves.toEqual([
          expect.objectContaining({ id: savedAccount.id, ownerPersonId: savedPerson.id }),
        ]);
      });

      it("excludes closed accounts by default and includes them when asked", async () => {
        const repository = await factory();
        const saved = await repository.saveFinanceAccount(account());
        await repository.closeFinanceAccount(saved.id);

        await expect(repository.listFinanceAccounts()).resolves.toEqual([]);
        await expect(repository.listFinanceAccounts({ includeClosed: true })).resolves.toEqual([
          expect.objectContaining({ id: saved.id, closed: true }),
        ]);
      });

      it("lists the three system categories without seeding", async () => {
        const repository = await factory();
        const categories = await repository.listFinanceCategories();
        expect(categories.map((category) => category.id)).toEqual(
          expect.arrayContaining(["fincat:non-categorise", "fincat:transfert", "fincat:split"]),
        );
      });

      it("seeds the default category taxonomy idempotently", async () => {
        const repository = await factory();
        const firstPass = await repository.seedFinanceDefaultCategories();
        const secondPass = await repository.seedFinanceDefaultCategories();

        expect(firstPass).toBeGreaterThan(0);
        expect(secondPass).toBe(0);
        await expect(repository.listFinanceCategories()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "fincat:alimentation" }),
            expect.objectContaining({ id: "fincat:alimentation.epicerie" }),
          ]),
        );
      });

      it("archives a category and reassigns its transactions", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        await repository.seedFinanceDefaultCategories();
        const txn = await repository.saveFinanceTransaction(
          buildFinanceTransaction({ categoryId: "fincat:alimentation.epicerie" }),
        );

        const reassigned = await repository.archiveFinanceCategory(
          "fincat:alimentation.epicerie",
          "fincat:non-categorise",
        );

        expect(reassigned).toBe(1);
        await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
          categoryId: "fincat:non-categorise",
        });
        const categories = await repository.listFinanceCategories(true);
        expect(
          categories.find((category) => category.id === "fincat:alimentation.epicerie")?.archived,
        ).toBe(true);
      });

      it("saves and deletes a rule", async () => {
        const repository = await factory();
        const saved = await repository.saveFinanceRule({
          id: "",
          name: "Loyer",
          priority: 0,
          enabled: true,
          matcher: { descriptionContains: "LOYER" },
          actions: { categoryId: "fincat:logement.loyer-hypotheque" },
          createdAt: "",
          updatedAt: "",
          lastAppliedAt: null,
          appliedCount: 0,
        });

        await expect(repository.listFinanceRules()).resolves.toEqual([
          expect.objectContaining({ id: saved.id, name: "Loyer" }),
        ]);

        await repository.deleteFinanceRule(saved.id);
        await expect(repository.listFinanceRules()).resolves.toEqual([]);
      });

      it("round-trips merchant memory and forgets an entry", async () => {
        const repository = await factory();
        const entry = {
          merchantKey: "IGA MONTREAL",
          accountId: "account-1",
          sign: -1 as const,
          categoryId: "fincat:alimentation.epicerie",
          hitCount: 1,
          correctionCount: 0,
          confidence: 0.6,
          source: "user_correction" as const,
          lastAppliedAt: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        };
        await repository.upsertFinanceMerchantMemory(entry);

        await expect(
          repository.listFinanceMerchantMemory({ merchantKey: "IGA MONTREAL" }),
        ).resolves.toEqual([entry]);

        await repository.forgetFinanceMerchantMemory("IGA MONTREAL", "account-1", -1);
        await expect(
          repository.listFinanceMerchantMemory({ merchantKey: "IGA MONTREAL" }),
        ).resolves.toEqual([]);
      });

      it("saves a transaction, lists/counts it by filter, and fetches it by id", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        const txn = await repository.saveFinanceTransaction(
          buildFinanceTransaction({ postedDate: "2026-04-05" }),
        );

        await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
          id: txn.id,
        });
        await expect(
          repository.listFinanceTransactions({ dateFrom: "2026-04-01", dateTo: "2026-04-30" }),
        ).resolves.toEqual([expect.objectContaining({ id: txn.id })]);
        await expect(
          repository.countFinanceTransactions({ dateFrom: "2026-04-01", dateTo: "2026-04-30" }),
        ).resolves.toBe(1);
        await expect(
          repository.listFinanceTransactions({ dateFrom: "2026-05-01" }),
        ).resolves.toEqual([]);
      });

      it("setFinanceTransactionCategory sets category_source to user and learns merchant memory", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        const txn = await repository.saveFinanceTransaction(buildFinanceTransaction());

        const result = await repository.setFinanceTransactionCategory({
          transactionId: txn.id,
          categoryId: "fincat:alimentation.epicerie",
          scope: "this",
        });

        expect(result.updated).toBe(1);
        expect(result.memory).toMatchObject({
          merchantKey: txn.merchantKey,
          accountId: "account-1",
          categoryId: "fincat:alimentation.epicerie",
          hitCount: 1,
        });
        await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
          categoryId: "fincat:alimentation.epicerie",
          categorySource: "user",
        });
      });

      it("setFinanceTransactionCategory with all_matching recategorizes other non-user rows for the same merchant, never a user-set one", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        const first = await repository.saveFinanceTransaction(
          buildFinanceTransaction({ id: "txn-1", merchantKey: "NETFLIX" }),
        );
        const second = await repository.saveFinanceTransaction(
          buildFinanceTransaction({ id: "txn-2", merchantKey: "NETFLIX" }),
        );
        const userSet = await repository.saveFinanceTransaction(
          buildFinanceTransaction({
            id: "txn-3",
            merchantKey: "NETFLIX",
            categoryId: "fincat:logement.entretien",
            categorySource: "user",
          }),
        );

        const result = await repository.setFinanceTransactionCategory({
          transactionId: first.id,
          categoryId: "fincat:loisirs.abonnements",
          scope: "all_matching",
        });

        expect(result.updated).toBe(2);
        await expect(repository.getFinanceTransaction(second.id)).resolves.toMatchObject({
          categoryId: "fincat:loisirs.abonnements",
        });
        await expect(repository.getFinanceTransaction(userSet.id)).resolves.toMatchObject({
          categoryId: "fincat:logement.entretien",
          categorySource: "user",
        });
      });

      it("bulk-updates transactions and splits one with a sum invariant", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        const a = await repository.saveFinanceTransaction(buildFinanceTransaction({ id: "txn-a" }));
        const b = await repository.saveFinanceTransaction(buildFinanceTransaction({ id: "txn-b" }));

        const updated = await repository.bulkUpdateFinanceTransactions([a.id, b.id], {
          excludedFromReports: true,
        });
        expect(updated).toBe(2);
        await expect(repository.getFinanceTransaction(a.id)).resolves.toMatchObject({
          excludedFromReports: true,
        });

        const withSplits = await repository.saveFinanceTransactionSplits(a.id, [
          {
            id: "",
            transactionId: a.id,
            amountMinor: -700,
            categoryId: "fincat:alimentation.epicerie",
            notes: null,
            sortOrder: 0,
            createdAt: "",
          },
          {
            id: "",
            transactionId: a.id,
            amountMinor: -534,
            categoryId: "fincat:transport.essence",
            notes: null,
            sortOrder: 1,
            createdAt: "",
          },
        ]);
        expect(withSplits.hasSplits).toBe(true);
        expect(withSplits.categoryId).toBe("fincat:split");

        const splits = await repository.listFinanceTransactionSplits(a.id);
        expect(splits).toHaveLength(2);
        expect(splits.reduce((sum, split) => sum + split.amountMinor, 0)).toBe(a.amountMinor);
      });

      it("imports transactions, dedupes a verbatim re-import, and detects a transfer across accounts", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-checking", onBudget: true }));
        await repository.saveFinanceAccount(
          account({ id: "account-savings", name: "Épargne", onBudget: true }),
        );

        const rows = [
          importRow({
            accountId: "account-checking",
            amountMinor: -5000,
            descriptionRaw: "VIREMENT EPARGNE",
          }),
          importRow({
            accountId: "account-savings",
            amountMinor: 5000,
            descriptionRaw: "VIREMENT EPARGNE",
            merchantKey: "VIREMENT EPARGNE",
          }),
        ];

        const summary = await repository.importFinanceTransactions({
          accountId: "account-checking",
          profileId: null,
          fileName: "export.csv",
          fileHash: "hash-1",
          rows,
        });

        expect(summary.imported).toBe(2);
        expect(summary.duplicates).toBe(0);
        expect(summary.transfersDetected).toBe(1);

        const transactions = await repository.listFinanceTransactions({});
        expect(transactions.every((txn) => txn.isTransfer)).toBe(true);
        expect(transactions.every((txn) => txn.categoryId === "fincat:transfert")).toBe(true);

        const reimportSummary = await repository.importFinanceTransactions({
          accountId: "account-checking",
          profileId: null,
          fileName: "export.csv",
          fileHash: "hash-1",
          rows,
        });

        expect(reimportSummary.imported).toBe(0);
        expect(reimportSummary.duplicates).toBe(2);
        await expect(repository.countFinanceTransactions({})).resolves.toBe(2);
      });

      it("never relabels a pre-existing user-categorized row that contains a transfer keyword", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-checking" }));

        const userRow = await repository.saveFinanceTransaction(
          buildFinanceTransaction({
            id: "txn-user-mortgage",
            accountId: "account-checking",
            amountMinor: -150000,
            descriptionRaw: "VIREMENT HYPOTHEQUE",
            merchantKey: "VIREMENT HYPOTHEQUE",
            categoryId: "fincat:logement.loyer-hypotheque",
            categorySource: "user",
          }),
        );

        await repository.importFinanceTransactions({
          accountId: "account-checking",
          profileId: null,
          fileName: "unrelated.csv",
          fileHash: "hash-unrelated",
          rows: [
            importRow({
              accountId: "account-checking",
              amountMinor: -999,
              descriptionRaw: "EPICERIE METRO",
              merchantKey: "EPICERIE METRO",
            }),
          ],
        });

        await expect(repository.getFinanceTransaction(userRow.id)).resolves.toMatchObject({
          categoryId: "fincat:logement.loyer-hypotheque",
          categorySource: "user",
          isTransfer: false,
        });
      });

      it("never pairs a pre-existing user-categorized row as the mirror-amount leg of an imported transfer", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-checking" }));
        await repository.saveFinanceAccount(account({ id: "account-savings", name: "Épargne" }));

        const userRow = await repository.saveFinanceTransaction(
          buildFinanceTransaction({
            id: "txn-user-savings",
            accountId: "account-savings",
            amountMinor: 5000,
            descriptionRaw: "COTISATION EPARGNE",
            merchantKey: "COTISATION EPARGNE",
            categoryId: "fincat:revenu.autre",
            categorySource: "user",
          }),
        );

        await repository.importFinanceTransactions({
          accountId: "account-checking",
          profileId: null,
          fileName: "export.csv",
          fileHash: "hash-mirror",
          rows: [
            importRow({
              accountId: "account-checking",
              amountMinor: -5000,
              descriptionRaw: "COTISATION EPARGNE",
              merchantKey: "COTISATION EPARGNE",
            }),
          ],
        });

        // The user row can never be the mirror-amount leg of this transfer: it is excluded
        // from the candidate set entirely, so the imported leg is left unpaired rather than
        // matched to it.
        await expect(repository.getFinanceTransaction(userRow.id)).resolves.toMatchObject({
          categoryId: "fincat:revenu.autre",
          categorySource: "user",
          isTransfer: false,
          transferGroupId: null,
        });
        const [imported] = await repository.listFinanceTransactions({
          accountIds: ["account-checking"],
        });
        expect(imported.isTransfer).toBe(false);
        expect(imported.transferGroupId).toBeNull();
      });

      it("includes a manually entered row (null importBatchId) in near-duplicate review", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-checking" }));

        await repository.saveFinanceTransaction(
          buildFinanceTransaction({
            id: "txn-manual",
            accountId: "account-checking",
            postedDate: "2026-04-01",
            amountMinor: -4321,
            descriptionRaw: "RESTAURANT LE BISTRO",
            merchantKey: "RESTAURANT LE BISTRO",
            importBatchId: null,
          }),
        );

        const summary = await repository.importFinanceTransactions({
          accountId: "account-checking",
          profileId: null,
          fileName: "near-dup.csv",
          fileHash: "hash-near-dup",
          rows: [
            importRow({
              accountId: "account-checking",
              postedDate: "2026-04-02",
              amountMinor: -4321,
              descriptionRaw: "RESTAURANT LE BISTRO MONTREAL",
              merchantKey: "RESTAURANT LE BISTRO MONTREAL",
            }),
          ],
        });

        expect(summary.nearDuplicates).toEqual([
          expect.objectContaining({ existingTransactionId: "txn-manual" }),
        ]);
      });

      it("undoFinanceImportBatch removes only the batch's non-user-categorized rows and reports the rest", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));

        const summary = await repository.importFinanceTransactions({
          accountId: "account-1",
          profileId: null,
          fileName: "export.csv",
          fileHash: "hash-undo",
          rows: [
            importRow({ accountId: "account-1", descriptionRaw: "IGA", merchantKey: "IGA" }),
            importRow({
              accountId: "account-1",
              descriptionRaw: "ESSO",
              merchantKey: "ESSO",
              amountMinor: -4200,
            }),
          ],
        });

        const [first] = await repository.listFinanceTransactions({});
        await repository.setFinanceTransactionCategory({
          transactionId: first.id,
          categoryId: "fincat:alimentation.epicerie",
          scope: "this",
        });

        const result = await repository.undoFinanceImportBatch(summary.batchId);

        expect(result.deleted).toBe(1);
        expect(result.refusedUserCategorized).toBe(1);
        await expect(repository.countFinanceTransactions({})).resolves.toBe(1);
      });

      it("saves and finds an import profile by signature", async () => {
        const repository = await factory();
        const saved = await repository.saveFinanceImportProfile({
          id: "",
          name: "Mon profil",
          signature: "sig-123",
          columnMap: { date: 0, description: 1, amount: 2 },
          dateFormat: "YYYY-MM-DD",
          amountMode: "single_signed",
          signConvention: null,
          defaultAccountId: null,
          createdAt: "",
          updatedAt: "",
          lastUsedAt: null,
        });

        await expect(repository.listFinanceImportProfiles()).resolves.toEqual([
          expect.objectContaining({ id: saved.id }),
        ]);
        await expect(repository.findFinanceImportProfileBySignature("sig-123")).resolves.toEqual(
          expect.objectContaining({ id: saved.id }),
        );
        await expect(repository.findFinanceImportProfileBySignature("missing")).resolves.toBeNull();
      });

      it("saves category suggestions and decideFinanceCategorySuggestion applies and records the decision", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-1" }));
        const txn = await repository.saveFinanceTransaction(buildFinanceTransaction());

        const [saved] = await repository.saveFinanceCategorySuggestions([
          {
            id: "",
            transactionId: txn.id,
            merchantKey: txn.merchantKey,
            suggestedCategoryId: "fincat:alimentation.epicerie",
            confidence: 0.6,
            origin: "seed",
            rationale: null,
            model: null,
            promptVersion: null,
            status: "pending",
            decidedAt: null,
            createdAt: "",
          },
        ]);

        await expect(repository.listFinanceCategorySuggestions("pending")).resolves.toEqual([
          expect.objectContaining({ id: saved.id }),
        ]);

        const decided = await repository.decideFinanceCategorySuggestion(saved.id, {
          status: "accepted",
        });

        expect(decided.status).toBe("accepted");
        await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
          categoryId: "fincat:alimentation.epicerie",
          categorySource: "user",
        });
      });

      it("imports 5 000 rows in one call with no reentrancy error", async () => {
        const repository = await factory();
        await repository.saveFinanceAccount(account({ id: "account-bulk" }));

        const rows: FinanceImportRow[] = Array.from({ length: 5_000 }, (_, index) => {
          const day = String((index % 27) + 1).padStart(2, "0");
          return importRow({
            accountId: "account-bulk",
            postedDate: `2026-01-${day}`,
            amountMinor: -(100 + (index % 500)),
            descriptionRaw: `MERCHANT ${index % 50}`,
            merchantKey: `MERCHANT ${index % 50}`,
          });
        });

        const summary = await repository.importFinanceTransactions({
          accountId: "account-bulk",
          profileId: null,
          fileName: "bulk.csv",
          fileHash: "hash-bulk",
          rows,
        });

        expect(summary.imported).toBe(5_000);
        await expect(repository.countFinanceTransactions({})).resolves.toBe(5_000);
      });
    });
  });
};
