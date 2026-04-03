import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  cloneEntry,
  defaultAppSettings
} from "../../domain/daily-entry";
import type {
  AppSettings,
  DailyEntry,
  GtdImportSummary,
  PomodoroSegment,
  PomodoroSession,
  Project,
  RecurringTaskTemplate,
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
import {
  buildPomodoroSessionDetails,
  buildPomodoroState,
  buildPomodoroTaskSummaries,
  computeDailyPomodoroStats,
  createPomodoroSegment,
  createPomodoroSession,
  getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset
} from "../pomodoro/engine";
import {
  applySeriesChangesToTemplate,
  buildRecurringPreviewOccurrences,
  buildTaskFromRecurringTemplate,
  cloneRecurringTemplate,
  createRecurringTemplate,
  filterRecurringTemplates,
  listDueDatesBetween,
  syncTemplateStatusChange
} from "../recurring/engine";
import { cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
import { buildBackupFileName } from "../backup";
import { formatUnknownError, logDebug } from "../debug";
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
import type { AppRepository, BackupResult, PomodoroStartOptions, StorageInfo } from "./repository";
import { getTodayDate } from "../date";

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
  deadline: string | null;
  recurring_template_id: string | null;
  recurrence_due_date: string | null;
  is_recurring_instance: number;
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

interface RecurringTemplateRow {
  id: string;
  title: string;
  notes: string;
  target_bucket: "next_action" | "scheduled";
  context_ids_json: string;
  project_id: string | null;
  rule_type: "daily" | "weekly" | "monthly";
  daily_interval: number;
  weekly_interval: number;
  weekly_days_json: string;
  monthly_mode: "day_of_month" | "nth_weekday";
  day_of_month: number | null;
  nth_week: number | null;
  weekday: number | null;
  scheduled_time: string | null;
  start_date: string;
  status: "active" | "paused" | "cancelled";
  last_generated_for_date: string | null;
  pending_missed_occurrences: number;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}

interface PomodoroSessionRow {
  id: string;
  kind: PomodoroSession["kind"];
  status: PomodoroSession["status"];
  started_at: string;
  ends_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cycle_index: number;
  date: string;
}

interface PomodoroSegmentRow {
  id: string;
  session_id: string;
  task_id: string | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
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
  },
  {
    id: 10,
    name: "create_pomodoro_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS pomodoro_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT,
        cycle_index INTEGER NOT NULL,
        date TEXT NOT NULL
      );
    `
  },
  {
    id: 11,
    name: "create_pomodoro_segments",
    sql: `
      CREATE TABLE IF NOT EXISTS pomodoro_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
    `
  },
  {
    id: 12,
    name: "create_recurring_task_templates",
    sql: `
      CREATE TABLE IF NOT EXISTS recurring_task_templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL,
        target_bucket TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        project_id TEXT,
        rule_type TEXT NOT NULL,
        daily_interval INTEGER NOT NULL,
        weekly_interval INTEGER NOT NULL,
        weekly_days_json TEXT NOT NULL,
        monthly_mode TEXT NOT NULL,
        day_of_month INTEGER,
        nth_week INTEGER,
        weekday INTEGER,
        scheduled_time TEXT,
        start_date TEXT NOT NULL,
        status TEXT NOT NULL,
        last_generated_for_date TEXT,
        pending_missed_occurrences INTEGER NOT NULL DEFAULT 0,
        status_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: 13,
    name: "add_recurring_fields_to_gtd_tasks",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN recurring_template_id TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN recurrence_due_date TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN is_recurring_instance INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    id: 14,
    name: "add_title_to_pomodoro_segments",
    sql: `
      ALTER TABLE pomodoro_segments ADD COLUMN title TEXT;
    `
  },
  {
    id: 15,
    name: "add_deadline_to_gtd_tasks",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN deadline TEXT;
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

    return mergeAppSettingsWithDefaults(JSON.parse(rows[0].value) as Partial<AppSettings>, defaultAppSettings());
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const db = await this.getDb();
    const normalized = mergeAppSettingsWithDefaults(settings, defaultAppSettings());
    await db.execute(
      `INSERT INTO app_settings (id, value)
       VALUES (1, $1)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(normalized)]
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
          deadline, recurring_template_id, recurrence_due_date, is_recurring_instance, completed_at, recurrence_group_id,
          pending_past_recurrences, source, source_external_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
          task.deadline,
          task.recurringTemplateId,
          task.recurrenceDueDate,
          task.isRecurringInstance ? 1 : 0,
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

  async saveContext(context: TaskContext): Promise<TaskContext> {
    const db = await this.getDb();
    const timestamp = nowIso();
    const nextName = context.name.trim();

    if (!nextName) {
      throw new Error("Le nom du contexte est requis.");
    }

    const duplicateRows = await db.select<{ id: string }[]>(
      "SELECT id FROM gtd_contexts WHERE LOWER(name) = LOWER($1) AND id != $2 LIMIT 1",
      [nextName, context.id]
    );

    if (duplicateRows.length > 0) {
      throw new Error(`Le contexte "${nextName}" existe deja.`);
    }

    const previousRows = await db.select<ContextRow[]>(
      "SELECT id, name, created_at, updated_at FROM gtd_contexts WHERE id = $1 LIMIT 1",
      [context.id]
    );

    const previous = previousRows[0];
    const nextContext: TaskContext = {
      id: context.id,
      name: nextName,
      createdAt: previous?.created_at ?? context.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    await db.execute(
      `INSERT INTO gtd_contexts (id, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
      [nextContext.id, nextContext.name, nextContext.createdAt, nextContext.updatedAt]
    );

    return nextContext;
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
    await this.generateDueRecurringTasks(getTodayDate());
    const tasks = await this.getAllTasks();
    return filterTasks(tasks, filters);
  }

  async listRecurringTaskTemplates(filters = {}) {
    const templates = await this.getAllRecurringTemplates();
    return filterRecurringTemplates(templates, filters);
  }

  async saveRecurringTaskTemplate(template: RecurringTaskTemplate): Promise<RecurringTaskTemplate> {
    const timestamp = nowIso();
    const previous = template.id ? await this.getRecurringTemplateById(template.id) : null;
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

    await this.persistRecurringTemplate(nextTemplate);
    const activeTask = await this.findActiveRecurringTask(nextTemplate.id);
    if (activeTask) {
      await this.persistTask(this.syncActiveTaskWithTemplate(activeTask, nextTemplate));
    }
    return cloneRecurringTemplate(nextTemplate);
  }

  async pauseRecurringTaskTemplate(id: string) {
    const template = await this.requireRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "paused");
    await this.persistRecurringTemplate(nextTemplate);
    return cloneRecurringTemplate(nextTemplate);
  }

  async resumeRecurringTaskTemplate(id: string) {
    const template = await this.requireRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "active");
    await this.persistRecurringTemplate(nextTemplate);
    return cloneRecurringTemplate(nextTemplate);
  }

  async cancelRecurringTaskTemplate(id: string) {
    const template = await this.requireRecurringTemplate(id);
    const nextTemplate = syncTemplateStatusChange(template, "cancelled");
    await this.persistRecurringTemplate(nextTemplate);
    const activeTask = await this.findActiveRecurringTask(id);
    if (activeTask) {
      await this.persistTask({
        ...cloneTask(activeTask),
        status: "cancelled",
        updatedAt: nowIso()
      });
    }
    return cloneRecurringTemplate(nextTemplate);
  }

  async generateDueRecurringTasks(date: string): Promise<number> {
    const templates = await this.getAllRecurringTemplates();
    let changedCount = 0;

    for (const template of templates) {
      if (template.status !== "active") {
        continue;
      }

      const activeTask = await this.findActiveRecurringTask(template.id);
      const startDate = this.findProcessingStartDate(template, activeTask);
      const dueDates = this.listDueDatesBetween(template, startDate, date);

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
            contextIds: [...template.contextIds],
            projectId: template.projectId,
            title: activeTask.title,
            notes: activeTask.notes,
            scheduledFor:
              template.targetBucket === "scheduled"
                ? buildTaskFromRecurringTemplate(template, latestDueDate, pendingPastRecurrences).scheduledFor
                : null,
            recurrenceDueDate: latestDueDate,
            pendingPastRecurrences,
            updatedAt: timestamp
          }
        : buildTaskFromRecurringTemplate(template, latestDueDate, Math.max(0, dueDates.length - 1));

      await this.persistTask(nextTask);
      await this.persistEvents(buildLifecycleEvents(activeTask ? cloneTask(activeTask) : null, nextTask));
      await this.persistRecurringTemplate({
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
    const [templates, tasks] = await Promise.all([this.getAllRecurringTemplates(), this.getAllTasks()]);
    return buildRecurringPreviewOccurrences(templates, tasks, rangeStart, rangeEnd);
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
    const task = await this.requireTask(taskId);
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

    const template = await this.requireRecurringTemplate(task.recurringTemplateId);
    const nextTemplate = applySeriesChangesToTemplate(template, changes);
    await this.saveRecurringTaskTemplate(nextTemplate);
    return this.saveTask(this.syncActiveTaskWithTemplate(task, nextTemplate));
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
    const nextTask = await this.saveTask({
      ...current,
      status: "completed",
      completedAt
    });
    if (current.recurringTemplateId) {
      const template = await this.requireRecurringTemplate(current.recurringTemplateId);
      const nextLastGeneratedForDate =
        current.recurrenceDueDate && (!template.lastGeneratedForDate || current.recurrenceDueDate > template.lastGeneratedForDate)
          ? current.recurrenceDueDate
          : template.lastGeneratedForDate;
      await this.persistRecurringTemplate({
        ...cloneRecurringTemplate(template),
        lastGeneratedForDate: nextLastGeneratedForDate,
        pendingMissedOccurrences: 0,
        updatedAt: nowIso()
      });
    }
    return nextTask;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const current = await this.requireTask(taskId);
    const nextTask = await this.saveTask({
      ...current,
      status: "cancelled",
      completedAt: null
    });
    if (current.recurringTemplateId) {
      const template = await this.requireRecurringTemplate(current.recurringTemplateId);
      await this.persistRecurringTemplate({
        ...cloneRecurringTemplate(template),
        pendingMissedOccurrences: 0,
        updatedAt: nowIso()
      });
    }
    return nextTask;
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = await this.requireTask(taskId);
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
    const taskSnapshot = await this.getAllTasks();

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

  async computeDailyTaskStats(date: string) {
    await this.generateDueRecurringTasks(date);
    if (new Date(`${date}T12:00:00`).getDay() === 0) {
      await this.applyWeeklyCarryover(date);
    }

    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    return buildDailyTaskStats(tasks, events, date);
  }

  async getDailyTaskBreakdown(date: string) {
    await this.generateDueRecurringTasks(date);
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

  async getPomodoroState() {
    const [sessions, segments] = await Promise.all([this.getAllPomodoroSessions(), this.getAllPomodoroSegments()]);
    return buildPomodoroState(sessions, segments);
  }

  async startPomodoro(options: PomodoroStartOptions = {}) {
    await this.completeExpiredPomodoroSessions();
    const state = await this.getPomodoroState();

    if (state.activeSession) {
      return state;
    }

    const startedAt = nowIso();
    const kind = options.kind ?? state.nextSessionKind;
    const cycleIndex = kind === "focus" ? state.nextFocusCycleIndex : Math.max(1, state.completedFocusCountInCycle || 1);
    const session = createPomodoroSession(kind, startedAt, cycleIndex);

    await this.persistPomodoroSession(session);

    if (kind === "focus") {
      const normalizedTitle = options.taskId ? null : (options.title ?? "").trim() || null;
      await this.persistPomodoroSegment(
        createPomodoroSegment(session.id, startedAt, options.taskId ?? null, normalizedTitle)
      );
    }

    return this.getPomodoroState();
  }

  async stopPomodoroSession(sessionId: string, status: "completed" | "cancelled", at = nowIso()) {
    const session = await this.getPomodoroSessionById(sessionId);

    if (!session) {
      throw new Error(`Session Pomodoro ${sessionId} introuvable`);
    }

    if (session.status !== "running") {
      return this.getPomodoroState();
    }

    const closedAt =
      status === "completed" && new Date(at).getTime() >= new Date(session.endsAt).getTime() ? session.endsAt : at;

    await this.persistPomodoroSession({
      ...session,
      status,
      completedAt: status === "completed" ? closedAt : null,
      cancelledAt: status === "cancelled" ? closedAt : null
    });

    const openSegments = await this.getOpenPomodoroSegments(sessionId);
    for (const segment of openSegments) {
      await this.persistPomodoroSegment({
        ...segment,
        endedAt: closedAt
      });
    }

    return this.getPomodoroState();
  }

  async completeExpiredPomodoroSessions(now = nowIso()) {
    let sessions = await this.getAllPomodoroSessions();
    const expiredRunningSessions = sessions.filter(
      (session) => session.status === "running" && new Date(session.endsAt).getTime() <= new Date(now).getTime()
    );

    for (const session of expiredRunningSessions) {
      await this.stopPomodoroSession(session.id, "completed", session.endsAt);
    }

    sessions = await this.getAllPomodoroSessions();
    for (const sessionId of getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset(sessions, now)) {
      await this.stopPomodoroSession(sessionId, "completed", now);
    }

    return this.getPomodoroState();
  }

  async switchPomodoroTask(sessionId: string, taskId: string | null, title: string | null = null, changedAt = nowIso()) {
    const session = await this.getPomodoroSessionById(sessionId);

    if (!session) {
      throw new Error(`Session Pomodoro ${sessionId} introuvable`);
    }

    if (session.status !== "running" || session.kind !== "focus") {
      return this.getPomodoroState();
    }

    const openSegments = await this.getOpenPomodoroSegments(sessionId);
    const openSegment = openSegments[0] ?? null;
    const normalizedTitle = taskId ? null : (title ?? "").trim() || null;

    if (openSegment?.taskId === taskId && (openSegment.title ?? null) === normalizedTitle) {
      return this.getPomodoroState();
    }

    if (openSegment) {
      await this.persistPomodoroSegment({
        ...openSegment,
        endedAt: changedAt
      });
    }

    await this.persistPomodoroSegment(createPomodoroSegment(sessionId, changedAt, taskId, normalizedTitle));
    return this.getPomodoroState();
  }

  async listPomodoroSessions(date: string) {
    const [sessions, segments] = await Promise.all([this.getAllPomodoroSessions(), this.getAllPomodoroSegments()]);
    return buildPomodoroSessionDetails(
      sessions.filter((session) => session.date === date),
      segments
    );
  }

  async listPomodoroTaskSummaries(date: string, now = nowIso()) {
    const [sessions, segments, tasks] = await Promise.all([
      this.getAllPomodoroSessions(),
      this.getAllPomodoroSegments(),
      this.getAllTasks()
    ]);

    return buildPomodoroTaskSummaries(sessions, segments, tasks, date, now);
  }

  async computeDailyPomodoroStats(date: string) {
    await this.completeExpiredPomodoroSessions();
    const sessions = await this.getAllPomodoroSessions();
    return computeDailyPomodoroStats(sessions, date);
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
      deadline: row.deadline,
      recurringTemplateId: row.recurring_template_id,
      recurrenceDueDate: row.recurrence_due_date,
      isRecurringInstance: Boolean(row.is_recurring_instance),
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

  private deserializePomodoroSession(row: PomodoroSessionRow): PomodoroSession {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      startedAt: row.started_at,
      endsAt: row.ends_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      cycleIndex: Number(row.cycle_index),
      date: row.date
    };
  }

  private deserializePomodoroSegment(row: PomodoroSegmentRow): PomodoroSegment {
    return {
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      title: row.title,
      startedAt: row.started_at,
      endedAt: row.ended_at
    };
  }

  private deserializeRecurringTemplate(row: RecurringTemplateRow): RecurringTaskTemplate {
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      targetBucket: row.target_bucket,
      contextIds: JSON.parse(row.context_ids_json),
      projectId: row.project_id,
      ruleType: row.rule_type,
      dailyInterval: Number(row.daily_interval),
      weeklyInterval: Number(row.weekly_interval),
      weeklyDays: JSON.parse(row.weekly_days_json),
      monthlyMode: row.monthly_mode,
      dayOfMonth: row.day_of_month === null ? null : Number(row.day_of_month),
      nthWeek: row.nth_week === null ? null : Number(row.nth_week),
      weekday: row.weekday === null ? null : Number(row.weekday),
      scheduledTime: row.scheduled_time,
      startDate: row.start_date,
      status: row.status,
      lastGeneratedForDate: row.last_generated_for_date,
      pendingMissedOccurrences: Number(row.pending_missed_occurrences ?? 0),
      statusChangedAt: row.status_changed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private async decorateEntry(entry: DailyEntry): Promise<DailyEntry> {
    const [taskStats, pomodoroStats] = await Promise.all([
      this.computeDailyTaskStats(entry.date),
      this.computeDailyPomodoroStats(entry.date)
    ]);
    return applyDailyPomodoroStats(applyDailyTaskStats(cloneEntry(entry), taskStats), pomodoroStats);
  }

  private async getAllTasks(): Promise<Task[]> {
    const db = await this.getDb();
    const rows = await db.select<TaskRow[]>(
      `SELECT
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id,
        scheduled_for, deadline, recurring_template_id, recurrence_due_date, is_recurring_instance,
        completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
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

  private async getAllPomodoroSessions(): Promise<PomodoroSession[]> {
    const db = await this.getDb();
    const rows = await db.select<PomodoroSessionRow[]>(
      `SELECT
        id, kind, status, started_at, ends_at, completed_at, cancelled_at, cycle_index, date
      FROM pomodoro_sessions`
    );
    return rows.map((row) => this.deserializePomodoroSession(row));
  }

  private async getAllPomodoroSegments(): Promise<PomodoroSegment[]> {
    const db = await this.getDb();
    const rows = await db.select<PomodoroSegmentRow[]>(
      `SELECT
        id, session_id, task_id, title, started_at, ended_at
      FROM pomodoro_segments`
    );
    return rows.map((row) => this.deserializePomodoroSegment(row));
  }

  private async getAllRecurringTemplates(): Promise<RecurringTaskTemplate[]> {
    const db = await this.getDb();
    const rows = await db.select<RecurringTemplateRow[]>(
      `SELECT
        id, title, notes, target_bucket, context_ids_json, project_id, rule_type, daily_interval, weekly_interval,
        weekly_days_json, monthly_mode, day_of_month, nth_week, weekday, scheduled_time, start_date, status,
        last_generated_for_date, pending_missed_occurrences, status_changed_at, created_at, updated_at
      FROM recurring_task_templates`
    );

    return rows.map((row) => this.deserializeRecurringTemplate(row));
  }

  private async getTaskById(taskId: string): Promise<Task | null> {
    const db = await this.getDb();
    const rows = await db.select<TaskRow[]>(
      `SELECT
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id,
        scheduled_for, deadline, recurring_template_id, recurrence_due_date, is_recurring_instance,
        completed_at, recurrence_group_id, pending_past_recurrences, source, source_external_id, created_at, updated_at
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

  private async getRecurringTemplateById(templateId: string): Promise<RecurringTaskTemplate | null> {
    const db = await this.getDb();
    const rows = await db.select<RecurringTemplateRow[]>(
      `SELECT
        id, title, notes, target_bucket, context_ids_json, project_id, rule_type, daily_interval, weekly_interval,
        weekly_days_json, monthly_mode, day_of_month, nth_week, weekday, scheduled_time, start_date, status,
        last_generated_for_date, pending_missed_occurrences, status_changed_at, created_at, updated_at
      FROM recurring_task_templates
      WHERE id = $1`,
      [templateId]
    );

    return rows[0] ? this.deserializeRecurringTemplate(rows[0]) : null;
  }

  private async getPomodoroSessionById(sessionId: string): Promise<PomodoroSession | null> {
    const db = await this.getDb();
    const rows = await db.select<PomodoroSessionRow[]>(
      `SELECT
        id, kind, status, started_at, ends_at, completed_at, cancelled_at, cycle_index, date
      FROM pomodoro_sessions
      WHERE id = $1`,
      [sessionId]
    );

    return rows[0] ? this.deserializePomodoroSession(rows[0]) : null;
  }

  private async getOpenPomodoroSegments(sessionId: string): Promise<PomodoroSegment[]> {
    const db = await this.getDb();
    const rows = await db.select<PomodoroSegmentRow[]>(
      `SELECT
        id, session_id, task_id, title, started_at, ended_at
      FROM pomodoro_segments
      WHERE session_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC`,
      [sessionId]
    );

    return rows.map((row) => this.deserializePomodoroSegment(row));
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} introuvable`);
    }

    return task;
  }

  private async requireRecurringTemplate(templateId: string): Promise<RecurringTaskTemplate> {
    const template = await this.getRecurringTemplateById(templateId);
    if (!template) {
      throw new Error(`Template recurrent ${templateId} introuvable`);
    }

    return template;
  }

  private async findActiveRecurringTask(templateId: string): Promise<Task | null> {
    const tasks = await this.getAllTasks();
    return (
      tasks.find(
        (candidate) =>
          candidate.recurringTemplateId === templateId &&
          candidate.isRecurringInstance &&
          candidate.status === "active"
      ) ?? null
    );
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

    const sorted = [...candidates].sort();
    return sorted.length > 0 ? sorted[sorted.length - 1] : template.startDate;
  }

  private listDueDatesBetween(template: RecurringTaskTemplate, rangeStart: string, rangeEnd: string): string[] {
    return listDueDatesBetween(template, rangeStart, rangeEnd);
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

  private async persistTask(task: Task): Promise<void> {
    const db = await this.getDb();
    await this.ensureContextsExist(task.contextIds);
    await db.execute(
      `INSERT INTO gtd_tasks (
        id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id, scheduled_for,
        deadline, recurring_template_id, recurrence_due_date, is_recurring_instance, completed_at, recurrence_group_id,
        pending_past_recurrences, source, source_external_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        notes = excluded.notes,
        status = excluded.status,
        bucket = excluded.bucket,
        context_ids_json = excluded.context_ids_json,
        project_id = excluded.project_id,
        parent_task_id = excluded.parent_task_id,
        scheduled_for = excluded.scheduled_for,
        deadline = excluded.deadline,
        recurring_template_id = excluded.recurring_template_id,
        recurrence_due_date = excluded.recurrence_due_date,
        is_recurring_instance = excluded.is_recurring_instance,
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
        task.deadline,
        task.recurringTemplateId,
        task.recurrenceDueDate,
        task.isRecurringInstance ? 1 : 0,
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

  private async persistRecurringTemplate(template: RecurringTaskTemplate): Promise<void> {
    const db = await this.getDb();
    await this.ensureContextsExist(template.contextIds);
    await db.execute(
      `INSERT INTO recurring_task_templates (
        id, title, notes, target_bucket, context_ids_json, project_id, rule_type, daily_interval, weekly_interval,
        weekly_days_json, monthly_mode, day_of_month, nth_week, weekday, scheduled_time, start_date, status,
        last_generated_for_date, pending_missed_occurrences, status_changed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        notes = excluded.notes,
        target_bucket = excluded.target_bucket,
        context_ids_json = excluded.context_ids_json,
        project_id = excluded.project_id,
        rule_type = excluded.rule_type,
        daily_interval = excluded.daily_interval,
        weekly_interval = excluded.weekly_interval,
        weekly_days_json = excluded.weekly_days_json,
        monthly_mode = excluded.monthly_mode,
        day_of_month = excluded.day_of_month,
        nth_week = excluded.nth_week,
        weekday = excluded.weekday,
        scheduled_time = excluded.scheduled_time,
        start_date = excluded.start_date,
        status = excluded.status,
        last_generated_for_date = excluded.last_generated_for_date,
        pending_missed_occurrences = excluded.pending_missed_occurrences,
        status_changed_at = excluded.status_changed_at,
        updated_at = excluded.updated_at`,
      [
        template.id,
        template.title,
        template.notes,
        template.targetBucket,
        JSON.stringify(template.contextIds),
        template.projectId,
        template.ruleType,
        template.dailyInterval,
        template.weeklyInterval,
        JSON.stringify(template.weeklyDays),
        template.monthlyMode,
        template.dayOfMonth,
        template.nthWeek,
        template.weekday,
        template.scheduledTime,
        template.startDate,
        template.status,
        template.lastGeneratedForDate,
        template.pendingMissedOccurrences,
        template.statusChangedAt,
        template.createdAt,
        template.updatedAt
      ]
    );
  }

  private async persistPomodoroSession(session: PomodoroSession): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO pomodoro_sessions (
        id, kind, status, started_at, ends_at, completed_at, cancelled_at, cycle_index, date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        started_at = excluded.started_at,
        ends_at = excluded.ends_at,
        completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at,
        cycle_index = excluded.cycle_index,
        date = excluded.date`,
      [
        session.id,
        session.kind,
        session.status,
        session.startedAt,
        session.endsAt,
        session.completedAt,
        session.cancelledAt,
        session.cycleIndex,
        session.date
      ]
    );
  }

  private async persistPomodoroSegment(segment: PomodoroSegment): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO pomodoro_segments (
        id, session_id, task_id, title, started_at, ended_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        title = excluded.title,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at`,
      [segment.id, segment.sessionId, segment.taskId, segment.title, segment.startedAt, segment.endedAt]
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
