import { applyDailyTaskStats, cloneEntry, createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import type {
  AppSettings,
  CreateTaskInput,
  DailyEntry,
  DailyTaskStats,
  GtdImportSummary,
  Project,
  ProjectFilters,
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
import { buildContextId, cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "./repository";

export class MemoryRepository implements AppRepository {
  private entries = new Map<string, DailyEntry>();
  private settings: AppSettings = defaultAppSettings();
  private tasks = new Map<string, Task>();
  private projects = new Map<string, Project>();
  private contexts = new Map<string, TaskContext>();
  private events = new Map<string, TaskEvent>();

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
    return { ...this.settings };
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    this.settings = { ...settings };
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
    return filterTasks([...this.tasks.values()], filters);
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
    return this.saveTask({
      ...current,
      status: "completed",
      completedAt
    });
  }

  async cancelTask(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      status: "cancelled",
      completedAt: null
    });
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      pendingPastRecurrences: 0
    });
  }

  async computeDailyTaskStats(date: string): Promise<DailyTaskStats> {
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    return buildDailyTaskStats([...this.tasks.values()], [...this.events.values()], date);
  }

  async getDailyTaskBreakdown(date: string) {
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
    const stats = await this.computeDailyTaskStats(entry.date);
    return applyDailyTaskStats(cloneEntry(entry), stats);
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
