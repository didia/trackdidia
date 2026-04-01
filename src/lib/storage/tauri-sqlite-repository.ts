import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { applyDailyTaskStats, cloneEntry, defaultAppSettings } from "../../domain/daily-entry";
import type {
  AppSettings,
  DailyEntry,
  GtdImportSummary,
  Project,
  Task,
  TaskContext,
  TaskEvent
} from "../../domain/types";
import {
  buildDailyTaskBreakdown,
  buildCarryoverEvents,
  buildDailyTaskStats,
  buildLifecycleEvents,
  createTaskFromInput,
  filterProjects,
  filterTasks
} from "../gtd/engine";
import { buildGoogleTasksImport } from "../gtd/google-tasks-import";
import { cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
import { buildBackupFileName } from "../backup";
import { formatUnknownError, logDebug } from "../debug";
import type { AppRepository, BackupResult, StorageInfo } from "./repository";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

interface DailyEntryRow {
  date: string;
  status: DailyEntry["status"];
  metrics_json: string;
  principles_json: string;
  morning_intention: string | null;
  night_reflection: string | null;
  tomorrow_focus: string | null;
  updated_at: string;
}

interface SettingsRow {
  value: string;
}

interface ContextRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  title: string;
  status: Project["status"];
  status_changed_at: string | null;
  notes: string;
  context_ids_json: string;
  source: Project["source"];
  source_external_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  notes: string;
  status: Task["status"];
  bucket: Task["bucket"];
  context_ids_json: string;
  project_id: string | null;
  parent_task_id: string | null;
  scheduled_for: string | null;
  completed_at: string | null;
  recurrence_group_id: string | null;
  pending_past_recurrences: number;
  source: Task["source"];
  source_external_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskEventRow {
  id: string;
  task_id: string;
  type: TaskEvent["type"];
  event_date: string;
  event_at: string;
  created_at: string;
  dedupe_key: string | null;
  metadata_json: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: "create_schema_migrations",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
    `
  },
  {
    id: 2,
    name: "create_daily_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS daily_entries (
        date TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        principles_json TEXT NOT NULL,
        morning_intention TEXT,
        night_reflection TEXT,
        tomorrow_focus TEXT,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 3,
    name: "create_app_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `
  },
  {
    id: 4,
    name: "create_gtd_contexts",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 5,
    name: "create_gtd_projects",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        source TEXT NOT NULL,
        source_external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 6,
    name: "create_gtd_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL,
        status TEXT NOT NULL,
        bucket TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        project_id TEXT,
        parent_task_id TEXT,
        scheduled_for TEXT,
        completed_at TEXT,
        source TEXT NOT NULL,
        source_external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 7,
    name: "create_gtd_task_events",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        metadata_json TEXT NOT NULL
      );
    `
  },
  {
    id: 8,
    name: "add_gtd_task_recurrence_fields",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN recurrence_group_id TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN pending_past_recurrences INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    id: 9,
    name: "add_gtd_project_status_changed_at",
    sql: `
      ALTER TABLE gtd_projects ADD COLUMN status_changed_at TEXT;
      UPDATE gtd_projects
      SET status_changed_at = COALESCE(updated_at, created_at)
      WHERE status_changed_at IS NULL;
    `
  }
];

export class TauriSqliteRepository implements AppRepository {
  private dbPromise: Promise<Database> | null = null;

  constructor(private readonly connectionString = "sqlite:trackdidia.db") {}

  async initialize(): Promise<void> {
    logDebug("info", "storage.sqlite", "Initialisation SQLite", this.connectionString);

    try {
      const db = await this.getDb();
      await db.execute(migrations[0].sql);

      const applied = await db.select<{ id: number }[]>("SELECT id FROM schema_migrations");
      const appliedIds = new Set(applied.map((item) => item.id));

      for (const migration of migrations.slice(1)) {
        if (!appliedIds.has(migration.id)) {
          logDebug("info", "storage.sqlite", `Execution migration ${migration.id}`, migration.name);
          await db.execute(migration.sql);
          await db.execute(
            "INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)",
            [migration.id, migration.name, new Date().toISOString()]
          );
        }
      }

      const existingSettings = await db.select<SettingsRow[]>("SELECT value FROM app_settings WHERE id = 1");
      if (existingSettings.length === 0) {
        await db.execute("INSERT OR IGNORE INTO app_settings (id, value) VALUES (1, $1)", [
          JSON.stringify(defaultAppSettings())
        ]);
      }

      logDebug("info", "storage.sqlite", "SQLite pret");
    } catch (error) {
      logDebug("error", "storage.sqlite", "Echec initialisation SQLite", error);
      throw new Error(`SQLite init failed: ${formatUnknownError(error)}`);
    }
  }

  async getDailyEntry(date: string): Promise<DailyEntry | null> {
    const db = await this.getDb();
    const rows = await db.select<DailyEntryRow[]>(
      `SELECT
        date,
        status,
        metrics_json,
        principles_json,
        morning_intention,
        night_reflection,
        tomorrow_focus,
        updated_at
      FROM daily_entries
      WHERE date = $1`,
      [date]
    );

    return rows[0] ? this.decorateEntry(this.deserializeEntry(rows[0])) : null;
  }

  async saveDailyEntry(entry: DailyEntry): Promise<void> {
    const db = await this.getDb();
    const decoratedEntry = await this.decorateEntry(entry);

    await db.execute(
      `INSERT INTO daily_entries (
        date,
        status,
        metrics_json,
        principles_json,
        morning_intention,
        night_reflection,
        tomorrow_focus,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT(date) DO UPDATE SET
        status = excluded.status,
        metrics_json = excluded.metrics_json,
        principles_json = excluded.principles_json,
        morning_intention = excluded.morning_intention,
        night_reflection = excluded.night_reflection,
        tomorrow_focus = excluded.tomorrow_focus,
        updated_at = excluded.updated_at`,
      [
        decoratedEntry.date,
        decoratedEntry.status,
        JSON.stringify(decoratedEntry.metrics),
        JSON.stringify(decoratedEntry.principleChecks),
        decoratedEntry.morningIntention,
        decoratedEntry.nightReflection,
        decoratedEntry.tomorrowFocus,
        decoratedEntry.updatedAt
      ]
    );
  }

  async listDailyEntries(limit = 30): Promise<DailyEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<DailyEntryRow[]>(
      `SELECT
        date,
        status,
        metrics_json,
        principles_json,
        morning_intention,
        night_reflection,
        tomorrow_focus,
        updated_at
      FROM daily_entries
      ORDER BY date DESC
      LIMIT $1`,
      [limit]
    );

    return Promise.all(rows.map((row) => this.decorateEntry(this.deserializeEntry(row))));
  }

  async getSettings(): Promise<AppSettings> {
    const db = await this.getDb();
    const rows = await db.select<SettingsRow[]>("SELECT value FROM app_settings WHERE id = 1");

    if (rows.length === 0) {
      return defaultAppSettings();
    }

    return JSON.parse(rows[0].value) as AppSettings;
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO app_settings (id, value)
       VALUES (1, $1)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(settings)]
    );
  }

  async getStorageInfo(): Promise<StorageInfo> {
    return invoke<StorageInfo>("resolve_storage_paths");
  }

  async createBackup(kind: "manual" | "auto" = "manual"): Promise<BackupResult> {
    const db = await this.getDb();
    const storageInfo = await this.getStorageInfo();
    const createdAt = new Date().toISOString();
    const backupPath = `${storageInfo.backupDir}/${buildBackupFileName(createdAt, kind)}`;
    const escapedPath = backupPath.replace(/'/g, "''");

    logDebug("info", "storage.backup", "Creation d'un backup SQLite", {
      kind,
      backupPath
    });

    await db.execute(`VACUUM INTO '${escapedPath}'`);

    return {
      backupPath,
      createdAt
    };
  }

  async importGoogleTasksExport(rawJson: unknown): Promise<GtdImportSummary> {
    const payload = buildGoogleTasksImport(rawJson);
    const db = await this.getDb();

    for (const context of payload.contexts) {
      await db.execute(
        `INSERT INTO gtd_contexts (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [context.id, context.name, context.createdAt, context.updatedAt]
      );
    }

    for (const project of payload.projects) {
      await db.execute(
        `INSERT INTO gtd_projects (
          id, title, status, status_changed_at, notes, context_ids_json, source, source_external_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(id) DO NOTHING`,
        [
          project.id,
          project.title,
          project.status,
          project.statusChangedAt,
          project.notes,
          JSON.stringify(project.contextIds),
          project.source,
          project.sourceExternalId,
          project.createdAt,
          project.updatedAt
        ]
      );
    }

    for (const task of payload.tasks) {
      await db.execute(
        `INSERT INTO gtd_tasks (
          id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id, scheduled_for,
          completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT(id) DO NOTHING`,
        [
          task.id,
          task.title,
          task.notes,
          task.status,
          task.bucket,
          JSON.stringify(task.contextIds),
          task.projectId,
          task.parentTaskId,
          task.scheduledFor,
          task.completedAt,
          task.recurrenceGroupId,
          task.pendingPastRecurrences,
          task.source,
          task.sourceExternalId,
          task.createdAt,
          task.updatedAt
        ]
      );
    }

    return payload.summary;
  }

  async getGtdOverview(): Promise<{ taskCount: number; projectCount: number; contextCount: number }> {
    const db = await this.getDb();
    const [taskRows, projectRows, contextRows] = await Promise.all([
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_tasks"),
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_projects"),
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_contexts")
    ]);

    return {
      taskCount: Number(taskRows[0]?.count ?? 0),
      projectCount: Number(projectRows[0]?.count ?? 0),
      contextCount: Number(contextRows[0]?.count ?? 0)
    };
  }

  async moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number> {
    const tasks = await this.getAllTasks();
    const matchingTasks = tasks.filter(
      (task) => task.status === "active" && task.contextIds.includes(contextId) && task.bucket !== bucket
    );

    for (const task of matchingTasks) {
      await this.persistTask({
        ...task,
        bucket,
        updatedAt: nowIso()
      });
    }

    return matchingTasks.length;
  }

  async moveTasksWithScheduledDatesToBucket(bucket: Task["bucket"]): Promise<number> {
    const tasks = await this.getAllTasks();
    const matchingTasks = tasks.filter(
      (task) => task.status === "active" && Boolean(task.scheduledFor) && task.bucket !== bucket
    );

    for (const task of matchingTasks) {
      await this.persistTask({
        ...task,
        bucket,
        updatedAt: nowIso()
      });
    }

    return matchingTasks.length;
  }

  async collapseGoogleRecurringTasks(rawJson: unknown): Promise<number> {
    const payload = buildGoogleTasksImport(rawJson);
    const tasks = await this.getAllTasks();
    let changedCount = 0;

    for (const context of payload.contexts) {
      await this.ensureContextsExist([context.id]);
    }

    for (const desiredTask of payload.tasks.filter((task) => task.recurrenceGroupId)) {
      const sourceIds = new Set(payload.recurringSourceTaskIds[desiredTask.id] ?? []);
      const existingMatches = tasks.filter(
        (task) =>
          task.source === "google_import" &&
          (task.id === desiredTask.id ||
            task.recurrenceGroupId === desiredTask.recurrenceGroupId ||
            (task.sourceExternalId ? sourceIds.has(task.sourceExternalId) : false))
      );

      const previousPrimary = existingMatches.find((task) => task.id === desiredTask.id) ?? existingMatches[0] ?? null;
      await this.persistTask({
        ...cloneTask(desiredTask),
        notes: previousPrimary?.notes?.trim() ? previousPrimary.notes : desiredTask.notes,
        projectId: previousPrimary?.projectId ?? desiredTask.projectId,
        updatedAt: nowIso()
      });
      changedCount += 1;

      const duplicateIds = existingMatches
        .filter((task) => task.id !== desiredTask.id)
        .map((task) => task.id);

      await this.deleteTasksByIds(duplicateIds);
    }

    return changedCount;
  }

  async listContexts(): Promise<TaskContext[]> {
    const db = await this.getDb();
    const rows = await db.select<ContextRow[]>(
      "SELECT id, name, created_at, updated_at FROM gtd_contexts ORDER BY name ASC"
    );
    return rows.map((row) => this.deserializeContext(row));
  }

  async listProjects(filters = {}): Promise<Project[]> {
    const db = await this.getDb();
    const rows = await db.select<ProjectRow[]>(
      `SELECT
        id, title, status, status_changed_at, notes, context_ids_json, source, source_external_id, created_at, updated_at
      FROM gtd_projects`
    );
    return filterProjects(rows.map((row) => this.deserializeProject(row)), filters);
  }

  async saveProject(project: Project): Promise<Project> {
    const db = await this.getDb();
    const timestamp = nowIso();
    const previous = project.id ? await this.getProjectById(project.id) : null;
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

    await this.ensureContextsExist(nextProject.contextIds);
    await db.execute(
      `INSERT INTO gtd_projects (
        id, title, status, status_changed_at, notes, context_ids_json, source, source_external_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        status_changed_at = excluded.status_changed_at,
        notes = excluded.notes,
        context_ids_json = excluded.context_ids_json,
        source = excluded.source,
        source_external_id = excluded.source_external_id,
        updated_at = excluded.updated_at`,
      [
        nextProject.id,
        nextProject.title,
        nextProject.status,
        nextProject.statusChangedAt,
        nextProject.notes,
        JSON.stringify(nextProject.contextIds),
        nextProject.source,
        nextProject.sourceExternalId,
        nextProject.createdAt,
        nextProject.updatedAt
      ]
    );

    return nextProject;
  }

  async listTasks(filters = {}): Promise<Task[]> {
    const tasks = await this.getAllTasks();
    return filterTasks(tasks, filters);
  }

  async createTask(input: Parameters<AppRepository["createTask"]>[0]): Promise<Task> {
    const nextTask = createTaskFromInput(input);
    await this.persistTask(nextTask);
    await this.persistEvents(buildLifecycleEvents(null, nextTask));
    return cloneTask(nextTask);
  }

  async saveTask(task: Task): Promise<Task> {
    const previous = await this.getTaskById(task.id);
    const nextTask: Task = {
      ...cloneTask(task),
      title: task.title.trim(),
      notes: task.notes.trim(),
      updatedAt: nowIso()
    };

    await this.persistTask(nextTask);
    await this.persistEvents(buildLifecycleEvents(previous, nextTask));
    return cloneTask(nextTask);
  }

  async moveTask(taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      bucket,
      contextIds: [...contextIds],
      projectId: projectId ?? current.projectId
    });
  }

  async scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      bucket: scheduledFor ? "scheduled" : current.bucket === "scheduled" ? "next_action" : current.bucket,
      scheduledFor
    });
  }

  async completeTask(taskId: string, completedAt = nowIso()): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      status: "completed",
      completedAt
    });
  }

  async cancelTask(taskId: string): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      status: "cancelled",
      completedAt: null
    });
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      pendingPastRecurrences: 0
    });
  }

  async computeDailyTaskStats(date: string) {
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    return buildDailyTaskStats(tasks, events, date);
  }

  async getDailyTaskBreakdown(date: string) {
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    return buildDailyTaskBreakdown(tasks, events, date);
  }

  async applyWeeklyCarryover(weekStartDate: string): Promise<number> {
    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    const nextEvents = buildCarryoverEvents(tasks, events, weekStartDate);
    await this.persistEvents(nextEvents);
    return nextEvents.length;
  }

  private async getDb(): Promise<Database> {
    if (!this.dbPromise) {
      logDebug("info", "storage.sqlite", "Ouverture connexion SQLite", this.connectionString);
      this.dbPromise = Database.load(this.connectionString);
    }

    return this.dbPromise;
  }

  private deserializeEntry(row: DailyEntryRow): DailyEntry {
    return {
      date: row.date,
      status: row.status,
      metrics: JSON.parse(row.metrics_json),
      principleChecks: JSON.parse(row.principles_json),
      morningIntention: row.morning_intention ?? "",
      nightReflection: row.night_reflection ?? "",
      tomorrowFocus: row.tomorrow_focus ?? "",
      updatedAt: row.updated_at
    };
  }

  private deserializeContext(row: ContextRow): TaskContext {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private deserializeProject(row: ProjectRow): Project {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      statusChangedAt: row.status_changed_at ?? row.updated_at ?? row.created_at,
      notes: row.notes,
      contextIds: JSON.parse(row.context_ids_json),
      source: row.source,
      sourceExternalId: row.source_external_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private deserializeTask(row: TaskRow): Task {
      return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      bucket: row.bucket,
      contextIds: JSON.parse(row.context_ids_json),
      projectId: row.project_id,
      parentTaskId: row.parent_task_id,
      scheduledFor: row.scheduled_for,
      completedAt: row.completed_at,
      recurrenceGroupId: row.recurrence_group_id,
      pendingPastRecurrences: Number(row.pending_past_recurrences ?? 0),
      source: row.source,
      sourceExternalId: row.source_external_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private deserializeEvent(row: TaskEventRow): TaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      eventDate: row.event_date,
      eventAt: row.event_at,
      createdAt: row.created_at,
      dedupeKey: row.dedupe_key,
      metadata: JSON.parse(row.metadata_json)
    };
  }

  private async decorateEntry(entry: DailyEntry): Promise<DailyEntry> {
    const stats = await this.computeDailyTaskStats(entry.date);
    return applyDailyTaskStats(cloneEntry(entry), stats);
  }

  private async getAllTasks(): Promise<Task[]> {
    const db = await this.getDb();
    const rows = await db.select<TaskRow[]>(
      `SELECT
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id,
        scheduled_for, completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
      FROM gtd_tasks`
    );
    return rows.map((row) => this.deserializeTask(row));
  }

  private async getAllEvents(): Promise<TaskEvent[]> {
    const db = await this.getDb();
    const rows = await db.select<TaskEventRow[]>(
      `SELECT
        id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json
      FROM gtd_task_events`
    );
    return rows.map((row) => this.deserializeEvent(row));
  }

  private async getTaskById(taskId: string): Promise<Task | null> {
    const db = await this.getDb();
    const rows = await db.select<TaskRow[]>(
      `SELECT
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id,
        scheduled_for, completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
      FROM gtd_tasks
      WHERE id = $1`,
      [taskId]
    );

    return rows[0] ? this.deserializeTask(rows[0]) : null;
  }

  private async getProjectById(projectId: string): Promise<Project | null> {
    const db = await this.getDb();
    const rows = await db.select<ProjectRow[]>(
      `SELECT
        id, title, status, status_changed_at, notes, context_ids_json, source, source_external_id, created_at, updated_at
      FROM gtd_projects
      WHERE id = $1`,
      [projectId]
    );

    return rows[0] ? this.deserializeProject(rows[0]) : null;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} introuvable`);
    }

    return task;
  }

  private async persistTask(task: Task): Promise<void> {
    const db = await this.getDb();
    await this.ensureContextsExist(task.contextIds);
    await db.execute(
      `INSERT INTO gtd_tasks (
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id, scheduled_for,
        completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        notes = excluded.notes,
        status = excluded.status,
        bucket = excluded.bucket,
        context_ids_json = excluded.context_ids_json,
        project_id = excluded.project_id,
        parent_task_id = excluded.parent_task_id,
        scheduled_for = excluded.scheduled_for,
        completed_at = excluded.completed_at,
        recurrence_group_id = excluded.recurrence_group_id,
        pending_past_recurrences = excluded.pending_past_recurrences,
        source = excluded.source,
        source_external_id = excluded.source_external_id,
        updated_at = excluded.updated_at`,
      [
        task.id,
        task.title,
        task.notes,
        task.status,
        task.bucket,
        JSON.stringify(task.contextIds),
        task.projectId,
        task.parentTaskId,
        task.scheduledFor,
        task.completedAt,
        task.recurrenceGroupId,
        task.pendingPastRecurrences,
        task.source,
        task.sourceExternalId,
        task.createdAt,
        task.updatedAt
      ]
    );
  }

  private async deleteTasksByIds(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }

    const db = await this.getDb();
    for (const taskId of taskIds) {
      await db.execute("DELETE FROM gtd_tasks WHERE id = $1", [taskId]);
    }
  }

  private async persistEvents(events: TaskEvent[]): Promise<void> {
    const db = await this.getDb();

    for (const event of events) {
      if (event.dedupeKey) {
        await db.execute(
          `INSERT INTO gtd_task_events (
            id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(dedupe_key) DO NOTHING`,
          [
            event.id,
            event.taskId,
            event.type,
            event.eventDate,
            event.eventAt,
            event.createdAt,
            event.dedupeKey,
            JSON.stringify(event.metadata)
          ]
        );
        continue;
      }

      await db.execute(
        `INSERT OR IGNORE INTO gtd_task_events (
          id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.id,
          event.taskId,
          event.type,
          event.eventDate,
          event.eventAt,
          event.createdAt,
          event.dedupeKey,
          JSON.stringify(event.metadata)
        ]
      );
    }
  }

  private async ensureContextsExist(contextIds: string[]): Promise<void> {
    const db = await this.getDb();

    for (const contextId of contextIds) {
      const name = contextId.startsWith("context:") ? contextId.slice("context:".length).replace(/-/g, " ") : contextId;
      const timestamp = nowIso();
      await db.execute(
        `INSERT INTO gtd_contexts (id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [contextId, name, timestamp, timestamp]
      );
    }
  }
}
