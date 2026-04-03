import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  cloneEntry,
  createEmptyDailyEntry,
  defaultAppSettings
} from "../../domain/daily-entry";
import { getTodayDate } from "../date";
import type {
  AppSettings,
  CreateTaskInput,
  DailyEntry,
  DailyTaskStats,
  GtdImportSummary,
  PomodoroSegment,
  PomodoroSession,
  PomodoroState,
  Project,
  ProjectFilters,
  RecurringTaskTemplate,
  RecurringTemplateFilters,
  Task,
  TaskContext,
  TaskEvent,
  TaskFilters
} from "../../domain/types";
import {
  buildDailyTaskBreakdown,
  buildCarryoverEvents,
  buildDailyTaskStats,
  buildLifecycleEvents,
  cloneContexts,
  cloneProjects,
  cloneTasks,
  createTaskFromInput,
  filterProjects,
  filterTasks
} from "../gtd/engine";
import { buildGoogleTasksImport } from "../gtd/google-tasks-import";
import {
  buildPomodoroSessionDetails,
  buildPomodoroState,
  buildPomodoroTaskSummaries,
  computeDailyPomodoroStats,
  createPomodoroSegment,
  createPomodoroSession
} from "../pomodoro/engine";
import {
  applySeriesChangesToTemplate,
  buildRecurringPreviewOccurrences,
  buildTaskFromRecurringTemplate,
  cloneRecurringTemplate,
  createRecurringTemplate,
  filterRecurringTemplates,
  findNextRecurringDate,
  listDueDatesBetween,
  syncTemplateStatusChange
} from "../recurring/engine";
import { buildContextId, cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
import {
  buildRelationshipDrawTaskTitle,
  findActiveRelationshipDrawTask,
  getRelationshipDrawActivities,
  getRelationshipDrawProcessedDate,
  getRelationshipDrawSourceExternalId,
  mergeAppSettingsWithDefaults,
  pickRelationshipDrawActivity,
  relationshipDrawDefinitions,
  relationshipPersonalContextId
} from "../relationship-draws";
import type { AppRepository, PomodoroStartOptions } from "./repository";

export class MemoryRepository implements AppRepository {
  private entries = new Map<string, DailyEntry>();
  private settings: AppSettings = defaultAppSettings();
  private tasks = new Map<string, Task>();
  private projects = new Map<string, Project>();
  private contexts = new Map<string, TaskContext>();
  private events = new Map<string, TaskEvent>();
  private pomodoroSessions = new Map<string, PomodoroSession>();
  private pomodoroSegments = new Map<string, PomodoroSegment>();
  private recurringTemplates = new Map<string, RecurringTaskTemplate>();

  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  async getDailyEntry(date: string): Promise<DailyEntry | null> {
    const existing = this.entries.get(date);
    return existing ? this.decorateEntry(existing) : null;
  }

  async saveDailyEntry(entry: DailyEntry): Promise<void> {
    this.entries.set(entry.date, await this.decorateEntry(entry));
  }

  async listDailyEntries(limit = 30): Promise<DailyEntry[]> {
    const sorted = [...this.entries.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);

    return Promise.all(sorted.map((entry) => this.decorateEntry(entry)));
  }

  async getSettings(): Promise<AppSettings> {
    return mergeAppSettingsWithDefaults(this.settings, defaultAppSettings());
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    this.settings = mergeAppSettingsWithDefaults(settings, defaultAppSettings());
  }

  async getStorageInfo() {
    return null;
  }

  async createBackup(): Promise<never> {
    throw new Error("Les backups SQLite ne sont disponibles qu'en mode desktop.");
  }

  async importGoogleTasksExport(rawJson: unknown): Promise<GtdImportSummary> {
    const payload = buildGoogleTasksImport(rawJson);

    for (const context of payload.contexts) {
      this.contexts.set(context.id, { ...context });
    }

    for (const project of payload.projects) {
      this.projects.set(project.id, cloneProject(project));
    }

    for (const task of payload.tasks) {
      this.tasks.set(task.id, cloneTask(task));
    }

    return payload.summary;
  }

  async getGtdOverview(): Promise<{ taskCount: number; projectCount: number; contextCount: number }> {
    return {
      taskCount: this.tasks.size,
      projectCount: this.projects.size,
      contextCount: this.contexts.size
    };
  }

  async moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number> {
    let movedCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "active" || !task.contextIds.includes(contextId) || task.bucket === bucket) {
        continue;
      }

      this.tasks.set(taskId, {
        ...cloneTask(task),
        bucket,
        updatedAt: nowIso()
      });
      movedCount += 1;
    }

    return movedCount;
  }

  async moveTasksWithScheduledDatesToBucket(bucket: Task["bucket"]): Promise<number> {
    let movedCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "active" || !task.scheduledFor || task.bucket === bucket) {
        continue;
      }

      this.tasks.set(taskId, {
        ...cloneTask(task),
        bucket,
        updatedAt: nowIso()
      });
      movedCount += 1;
    }

    return movedCount;
  }

  async collapseGoogleRecurringTasks(rawJson: unknown): Promise<number> {
    const payload = buildGoogleTasksImport(rawJson);
    let changedCount = 0;

    for (const context of payload.contexts) {
      this.contexts.set(context.id, { ...context });
    }

    for (const desiredTask of payload.tasks.filter((task) => task.recurrenceGroupId)) {
      const sourceIds = new Set(payload.recurringSourceTaskIds[desiredTask.id] ?? []);
      const existingMatches = [...this.tasks.values()].filter(
        (task) =>
          task.source === "google_import" &&
          (task.id === desiredTask.id ||
            task.recurrenceGroupId === desiredTask.recurrenceGroupId ||
            (task.sourceExternalId ? sourceIds.has(task.sourceExternalId) : false))
      );

      const previousPrimary = existingMatches.find((task) => task.id === desiredTask.id) ?? existingMatches[0] ?? null;
      const nextTask: Task = {
        ...cloneTask(desiredTask),
        notes: previousPrimary?.notes?.trim() ? previousPrimary.notes : desiredTask.notes,
        projectId: previousPrimary?.projectId ?? desiredTask.projectId,
        updatedAt: nowIso()
      };

      this.tasks.set(nextTask.id, cloneTask(nextTask));
      changedCount += 1;

      for (const duplicate of existingMatches) {
        if (duplicate.id === nextTask.id) {
          continue;
        }

        this.tasks.delete(duplicate.id);
      }
    }

    return changedCount;
  }

  async listContexts(): Promise<TaskContext[]> {
    return cloneContexts([...this.contexts.values()].sort((left, right) => left.name.localeCompare(right.name)));
  }

  async saveContext(context: TaskContext): Promise<TaskContext> {
    const timestamp = nowIso();
    const nextName = context.name.trim();

    if (!nextName) {
      throw new Error("Le nom du contexte est requis.");
    }

    const duplicate = [...this.contexts.values()].find(
      (candidate) => candidate.id !== context.id && candidate.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase()
    );

    if (duplicate) {
      throw new Error(`Le contexte "${nextName}" existe deja.`);
    }

    const previous = this.contexts.get(context.id);
    const nextContext: TaskContext = {
      id: context.id,
      name: nextName,
      createdAt: previous?.createdAt ?? context.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    this.contexts.set(nextContext.id, nextContext);
    return cloneContexts([nextContext])[0];
  }

  async listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
    return filterProjects([...this.projects.values()], filters);
  }

  async saveProject(project: Project): Promise<Project> {
    const timestamp = nowIso();
    const previous = project.id ? this.projects.get(project.id) ?? null : null;
    const nextProject: Project = {
      ...cloneProject(project),
      id: project.id || createEntityId("project"),
      title: project.title.trim(),
      notes: project.notes.trim(),
      statusChangedAt:
        previous && previous.status !== project.status
          ? timestamp
          : project.statusChangedAt || previous?.statusChangedAt || project.createdAt || timestamp,
      updatedAt: timestamp,
      createdAt: project.createdAt || timestamp
    };

    this.ensureContextsByIds(nextProject.contextIds);
    this.projects.set(nextProject.id, cloneProject(nextProject));
    return cloneProject(nextProject);
  }

  async listTasks(filters: TaskFilters = {}): Promise<Task[]> {
    await this.generateDueRecurringTasks(getTodayDate());
    return filterTasks([...this.tasks.values()], filters);
  }

  async listRecurringTaskTemplates(filters: RecurringTemplateFilters = {}) {
    return filterRecurringTemplates(
      [...this.recurringTemplates.values()].map((template) => cloneRecurringTemplate(template)),
      filters
    );
  }

  async saveRecurringTaskTemplate(template: RecurringTaskTemplate): Promise<RecurringTaskTemplate> {
    const timestamp = nowIso();
    const previous = template.id ? this.recurringTemplates.get(template.id) ?? null : null;
    const nextTemplate = createRecurringTemplate({
      ...cloneRecurringTemplate(template),
      id: template.id || createEntityId("recurring-template"),
      title: template.title,
      startDate: template.startDate,
      createdAt: previous?.createdAt ?? template.createdAt ?? timestamp,
      statusChangedAt:
        previous && previous.status !== template.status
          ? timestamp
          : template.statusChangedAt || previous?.statusChangedAt || timestamp,
      updatedAt: timestamp
    });

    this.ensureContextsByIds(nextTemplate.contextIds);
    this.recurringTemplates.set(nextTemplate.id, cloneRecurringTemplate(nextTemplate));

    const activeTask = this.findActiveRecurringTask(nextTemplate.id);
    if (activeTask) {
      const syncedTask = this.syncActiveTaskWithTemplate(activeTask, nextTemplate);
      this.tasks.set(syncedTask.id, cloneTask(syncedTask));
    }

    return cloneRecurringTemplate(nextTemplate);
  }

  async pauseRecurringTaskTemplate(id: string) {
    const template = this.getExistingRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "paused");
    this.recurringTemplates.set(id, cloneRecurringTemplate(nextTemplate));
    return cloneRecurringTemplate(nextTemplate);
  }

  async resumeRecurringTaskTemplate(id: string) {
    const template = this.getExistingRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "active");
    this.recurringTemplates.set(id, cloneRecurringTemplate(nextTemplate));
    return cloneRecurringTemplate(nextTemplate);
  }

  async cancelRecurringTaskTemplate(id: string) {
    const template = this.getExistingRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "cancelled");
    this.recurringTemplates.set(id, cloneRecurringTemplate(nextTemplate));
    const activeTask = this.findActiveRecurringTask(id);
    if (activeTask) {
      this.tasks.set(activeTask.id, {
        ...cloneTask(activeTask),
        status: "cancelled",
        updatedAt: nowIso()
      });
    }
    return cloneRecurringTemplate(nextTemplate);
  }

  async generateDueRecurringTasks(date: string): Promise<number> {
    let changedCount = 0;

    for (const template of this.recurringTemplates.values()) {
      if (template.status !== "active") {
        continue;
      }

      const activeTask = this.findActiveRecurringTask(template.id);
      const startDate = this.findProcessingStartDate(template, activeTask);
      const dueDates = listDueDatesBetween(template, startDate, date);

      if (dueDates.length === 0) {
        continue;
      }

      const latestDueDate = dueDates[dueDates.length - 1];
      const nextPending = (activeTask?.pendingPastRecurrences ?? 0) + dueDates.length - 1 + (activeTask ? 1 : 0);
      const previousPending = activeTask?.pendingPastRecurrences ?? 0;
      const pendingPastRecurrences = Math.max(previousPending, nextPending);
      const timestamp = nowIso();

      const nextTask = activeTask
        ? {
            ...cloneTask(activeTask),
            bucket: template.targetBucket,
            scheduledFor:
              template.targetBucket === "scheduled"
                ? buildTaskFromRecurringTemplate(template, latestDueDate, pendingPastRecurrences).scheduledFor
                : null,
            recurrenceDueDate: latestDueDate,
            pendingPastRecurrences,
            updatedAt: timestamp
          }
        : buildTaskFromRecurringTemplate(template, latestDueDate, Math.max(0, dueDates.length - 1));

      this.ensureContextsByIds(template.contextIds);
      this.tasks.set(nextTask.id, cloneTask(nextTask));
      this.persistEvents(buildLifecycleEvents(activeTask ? cloneTask(activeTask) : null, nextTask));

      this.recurringTemplates.set(template.id, {
        ...cloneRecurringTemplate(template),
        lastGeneratedForDate: latestDueDate,
        pendingMissedOccurrences: nextTask.pendingPastRecurrences,
        updatedAt: timestamp
      });

      changedCount += 1;
    }

    return changedCount;
  }

  async listRecurringPreviewOccurrences(rangeStart: string, rangeEnd: string) {
    return buildRecurringPreviewOccurrences(
      [...this.recurringTemplates.values()],
      [...this.tasks.values()],
      rangeStart,
      rangeEnd
    );
  }

  async applyRecurringEditScope(taskId: string, scope: "occurrence" | "series", changes: {
    title?: string;
    notes?: string;
    bucket?: "next_action" | "scheduled";
    contextIds?: string[];
    projectId?: string | null;
    scheduledFor?: string | null;
    deadline?: string | null;
  }) {
    const task = this.getExistingTask(taskId);
    if (!task.recurringTemplateId) {
      return this.saveTask({
        ...task,
        ...changes
      });
    }

    if (scope === "occurrence") {
      return this.saveTask({
        ...task,
        title: changes.title ?? task.title,
        notes: changes.notes ?? task.notes,
        bucket: changes.bucket ?? task.bucket,
        contextIds: changes.contextIds ?? task.contextIds,
        projectId: changes.projectId === undefined ? task.projectId : changes.projectId,
        scheduledFor: changes.scheduledFor === undefined ? task.scheduledFor : changes.scheduledFor,
        deadline: changes.deadline === undefined ? task.deadline : changes.deadline
      });
    }

    const template = this.getExistingRecurringTemplate(task.recurringTemplateId);
    const nextTemplate = applySeriesChangesToTemplate(template, changes);
    await this.saveRecurringTaskTemplate(nextTemplate);
    const nextTask = this.syncActiveTaskWithTemplate(this.getExistingTask(taskId), nextTemplate);
    return this.saveTask(nextTask);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const nextTask = createTaskFromInput(input);
    this.ensureContextsByIds(nextTask.contextIds);
    this.tasks.set(nextTask.id, cloneTask(nextTask));
    this.persistEvents(buildLifecycleEvents(null, nextTask));
    return cloneTask(nextTask);
  }

  async saveTask(task: Task): Promise<Task> {
    const previous = this.tasks.get(task.id) ?? null;
    const nextTask: Task = {
      ...cloneTask(task),
      title: task.title.trim(),
      notes: task.notes.trim(),
      updatedAt: nowIso()
    };

    this.ensureContextsByIds(nextTask.contextIds);
    this.tasks.set(nextTask.id, cloneTask(nextTask));
    this.persistEvents(buildLifecycleEvents(previous ? cloneTask(previous) : null, nextTask));
    return cloneTask(nextTask);
  }

  async moveTask(taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      bucket,
      contextIds: [...contextIds],
      projectId: projectId ?? current.projectId
    });
  }

  async scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      bucket: scheduledFor ? "scheduled" : current.bucket === "scheduled" ? "next_action" : current.bucket,
      scheduledFor
    });
  }

  async completeTask(taskId: string, completedAt = nowIso()): Promise<Task> {
    const current = this.getExistingTask(taskId);
    const nextTask = await this.saveTask({
      ...current,
      status: "completed",
      completedAt
    });
    if (current.recurringTemplateId) {
      const template = this.getExistingRecurringTemplate(current.recurringTemplateId);
      this.recurringTemplates.set(current.recurringTemplateId, {
        ...cloneRecurringTemplate(template),
        pendingMissedOccurrences: 0,
        updatedAt: nowIso()
      });
    }
    return nextTask;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    const nextTask = await this.saveTask({
      ...current,
      status: "cancelled",
      completedAt: null
    });
    if (current.recurringTemplateId) {
      const template = this.getExistingRecurringTemplate(current.recurringTemplateId);
      this.recurringTemplates.set(current.recurringTemplateId, {
        ...cloneRecurringTemplate(template),
        pendingMissedOccurrences: 0,
        updatedAt: nowIso()
      });
    }
    return nextTask;
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      pendingPastRecurrences: 0
    });
  }

  async generateDailyRelationshipTasks(date: string): Promise<number> {
    const settings = await this.getSettings();

    if (!settings.relationshipDrawsEnabled) {
      return 0;
    }

    let nextSettings = settings;
    let createdCount = 0;
    const taskSnapshot = [...this.tasks.values()];

    for (const definition of relationshipDrawDefinitions) {
      if (getRelationshipDrawProcessedDate(nextSettings, definition) === date) {
        continue;
      }

      if (findActiveRelationshipDrawTask(taskSnapshot, definition.category)) {
        nextSettings = {
          ...nextSettings,
          [definition.processedDateKey]: date
        };
        continue;
      }

      const activity = pickRelationshipDrawActivity(getRelationshipDrawActivities(nextSettings, definition));
      if (!activity) {
        continue;
      }

      const createdTask = await this.createTask({
        title: buildRelationshipDrawTaskTitle(definition, activity),
        notes: definition.notes,
        bucket: "next_action",
        contextIds: [relationshipPersonalContextId],
        source: "manual",
        sourceExternalId: getRelationshipDrawSourceExternalId(definition.category, date),
        createdAt: `${date}T00:00:00.000Z`,
        updatedAt: `${date}T00:00:00.000Z`
      });

      taskSnapshot.push(createdTask);
      nextSettings = {
        ...nextSettings,
        [definition.processedDateKey]: date
      };
      createdCount += 1;
    }

    await this.saveSettings(nextSettings);
    return createdCount;
  }

  async computeDailyTaskStats(date: string): Promise<DailyTaskStats> {
    await this.generateDueRecurringTasks(date);
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    return buildDailyTaskStats([...this.tasks.values()], [...this.events.values()], date);
  }

  async getDailyTaskBreakdown(date: string) {
    await this.generateDueRecurringTasks(date);
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    return buildDailyTaskBreakdown([...this.tasks.values()], [...this.events.values()], date);
  }

  async applyWeeklyCarryover(weekStartDate: string): Promise<number> {
    const nextEvents = buildCarryoverEvents([...this.tasks.values()], [...this.events.values()], weekStartDate);
    this.persistEvents(nextEvents);
    return nextEvents.length;
  }

  async getPomodoroState(): Promise<PomodoroState> {
    return buildPomodoroState([...this.pomodoroSessions.values()], [...this.pomodoroSegments.values()]);
  }

  async startPomodoro(options: PomodoroStartOptions = {}): Promise<PomodoroState> {
    await this.completeExpiredPomodoroSessions();
    const state = await this.getPomodoroState();

    if (state.activeSession) {
      return state;
    }

    const startedAt = nowIso();
    const kind = options.kind ?? state.nextSessionKind;
    const cycleIndex = kind === "focus" ? state.nextFocusCycleIndex : Math.max(1, state.completedFocusCountInCycle || 1);
    const session = createPomodoroSession(kind, startedAt, cycleIndex);
    this.pomodoroSessions.set(session.id, session);

    if (kind === "focus") {
      const normalizedTitle = options.taskId ? null : (options.title ?? "").trim() || null;
      const segment = createPomodoroSegment(session.id, startedAt, options.taskId ?? null, normalizedTitle);
      this.pomodoroSegments.set(segment.id, segment);
    }

    return this.getPomodoroState();
  }

  async stopPomodoroSession(
    sessionId: string,
    status: "completed" | "cancelled",
    at = nowIso()
  ): Promise<PomodoroState> {
    const session = this.pomodoroSessions.get(sessionId);

    if (!session) {
      throw new Error(`Session Pomodoro ${sessionId} introuvable`);
    }

    if (session.status !== "running") {
      return this.getPomodoroState();
    }

    const closedAt = status === "completed" ? (new Date(at).getTime() >= new Date(session.endsAt).getTime() ? session.endsAt : at) : at;

    this.pomodoroSessions.set(sessionId, {
      ...session,
      status,
      completedAt: status === "completed" ? closedAt : null,
      cancelledAt: status === "cancelled" ? closedAt : null
    });

    for (const [segmentId, segment] of this.pomodoroSegments.entries()) {
      if (segment.sessionId !== sessionId || segment.endedAt !== null) {
        continue;
      }

      this.pomodoroSegments.set(segmentId, {
        ...segment,
        endedAt: closedAt
      });
    }

    return this.getPomodoroState();
  }

  async completeExpiredPomodoroSessions(now = nowIso()): Promise<PomodoroState> {
    const expiredRunningSessions = [...this.pomodoroSessions.values()].filter(
      (session) => session.status === "running" && new Date(session.endsAt).getTime() <= new Date(now).getTime()
    );

    for (const session of expiredRunningSessions) {
      await this.stopPomodoroSession(session.id, "completed", session.endsAt);
    }

    return this.getPomodoroState();
  }

  async switchPomodoroTask(
    sessionId: string,
    taskId: string | null,
    title: string | null = null,
    changedAt = nowIso()
  ): Promise<PomodoroState> {
    const session = this.pomodoroSessions.get(sessionId);

    if (!session) {
      throw new Error(`Session Pomodoro ${sessionId} introuvable`);
    }

    if (session.status !== "running" || session.kind !== "focus") {
      return this.getPomodoroState();
    }

    const openSegment = [...this.pomodoroSegments.values()].find(
      (segment) => segment.sessionId === sessionId && segment.endedAt === null
    );

    const normalizedTitle = taskId ? null : (title ?? "").trim() || null;

    if (openSegment?.taskId === taskId && (openSegment.title ?? null) === normalizedTitle) {
      return this.getPomodoroState();
    }

    if (openSegment) {
      this.pomodoroSegments.set(openSegment.id, {
        ...openSegment,
        endedAt: changedAt
      });
    }

    const nextSegment = createPomodoroSegment(sessionId, changedAt, taskId, normalizedTitle);
    this.pomodoroSegments.set(nextSegment.id, nextSegment);
    return this.getPomodoroState();
  }

  async listPomodoroSessions(date: string) {
    return buildPomodoroSessionDetails(
      [...this.pomodoroSessions.values()].filter((session) => session.date === date),
      [...this.pomodoroSegments.values()]
    );
  }

  async listPomodoroTaskSummaries(date: string, now = nowIso()) {
    return buildPomodoroTaskSummaries(
      [...this.pomodoroSessions.values()],
      [...this.pomodoroSegments.values()],
      [...this.tasks.values()],
      date,
      now
    );
  }

  async computeDailyPomodoroStats(date: string) {
    await this.completeExpiredPomodoroSessions();
    return computeDailyPomodoroStats([...this.pomodoroSessions.values()], date);
  }

  private getExistingRecurringTemplate(templateId: string): RecurringTaskTemplate {
    const template = this.recurringTemplates.get(templateId);
    if (!template) {
      throw new Error(`Template recurrent ${templateId} introuvable`);
    }

    return cloneRecurringTemplate(template);
  }

  private findActiveRecurringTask(templateId: string): Task | null {
    const task = [...this.tasks.values()].find(
      (candidate) =>
        candidate.recurringTemplateId === templateId &&
        candidate.isRecurringInstance &&
        candidate.status === "active"
    );

    return task ? cloneTask(task) : null;
  }

  private findProcessingStartDate(template: RecurringTaskTemplate, activeTask: Task | null): string {
    const candidates = [template.startDate];

    if (template.lastGeneratedForDate) {
      const next = new Date(`${template.lastGeneratedForDate}T12:00:00`);
      next.setDate(next.getDate() + 1);
      candidates.push(next.toISOString().slice(0, 10));
    }

    if (activeTask?.recurrenceDueDate) {
      const next = new Date(`${activeTask.recurrenceDueDate}T12:00:00`);
      next.setDate(next.getDate() + 1);
      candidates.push(next.toISOString().slice(0, 10));
    }

    return candidates.sort().at(-1) ?? template.startDate;
  }

  private syncActiveTaskWithTemplate(task: Task, template: RecurringTaskTemplate): Task {
    return {
      ...cloneTask(task),
      title: template.title,
      notes: template.notes,
      bucket: template.targetBucket,
      contextIds: [...template.contextIds],
      projectId: template.projectId,
      scheduledFor:
        template.targetBucket === "scheduled" && task.recurrenceDueDate
          ? buildTaskFromRecurringTemplate(template, task.recurrenceDueDate, task.pendingPastRecurrences).scheduledFor
          : null,
      updatedAt: nowIso()
    };
  }

  seed(entries: DailyEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.date, entry);
    }
  }

  ensureEntry(date: string): DailyEntry {
    const current = this.entries.get(date) ?? createEmptyDailyEntry(date);
    this.entries.set(date, current);
    return current;
  }

  private async decorateEntry(entry: DailyEntry): Promise<DailyEntry> {
    const [taskStats, pomodoroStats] = await Promise.all([
      this.computeDailyTaskStats(entry.date),
      this.computeDailyPomodoroStats(entry.date)
    ]);
    return applyDailyPomodoroStats(applyDailyTaskStats(cloneEntry(entry), taskStats), pomodoroStats);
  }

  private getExistingTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} introuvable`);
    }

    return cloneTask(task);
  }

  private persistEvents(events: TaskEvent[]): void {
    for (const event of events) {
      if (event.dedupeKey) {
        const existing = [...this.events.values()].find((candidate) => candidate.dedupeKey === event.dedupeKey);
        if (existing) {
          continue;
        }
      }

      this.events.set(event.id, {
        ...event,
        metadata: { ...event.metadata }
      });
    }
  }

  private ensureContextsByIds(contextIds: string[]): void {
    for (const contextId of contextIds) {
      if (this.contexts.has(contextId)) {
        continue;
      }

      const name = contextId.startsWith("context:") ? contextId.slice("context:".length).replace(/-/g, " ") : contextId;
      const timestamp = nowIso();
      this.contexts.set(contextId, {
        id: contextId,
        name,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  ensureContext(name: string): TaskContext {
    const id = buildContextId(name);
    const existing = this.contexts.get(id);
    if (existing) {
      return existing;
    }

    const context: TaskContext = {
      id,
      name,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.contexts.set(id, context);
    return context;
  }
}
