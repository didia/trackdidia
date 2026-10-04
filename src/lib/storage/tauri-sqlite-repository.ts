import * as midWeekDecisionsRows from "./sqlite/rows/midWeekDecisions";
import * as rescueTimeCacheRows from "./sqlite/rows/rescueTimeCache";
import * as dailyEntriesRows from "./sqlite/rows/dailyEntries";
import * as weeklyReviewsRows from "./sqlite/rows/weeklyReviews";
import * as monthlyReviewsRows from "./sqlite/rows/monthlyReviews";
import * as annualGoalsRows from "./sqlite/rows/annualGoals";
import * as weeklyObjectivesRows from "./sqlite/rows/weeklyObjectives";
import * as weeklyObjectiveResultsRows from "./sqlite/rows/weeklyObjectiveResults";
import * as contextsRows from "./sqlite/rows/contexts";
import * as projectsRows from "./sqlite/rows/projects";
import * as tasksRows from "./sqlite/rows/tasks";
import * as taskEventsRows from "./sqlite/rows/taskEvents";
import * as recurringTemplatesRows from "./sqlite/rows/recurringTemplates";
import * as pomodoroSessionsRows from "./sqlite/rows/pomodoroSessions";
import * as pomodoroSegmentsRows from "./sqlite/rows/pomodoroSegments";
import * as aiMessagesRows from "./sqlite/rows/aiMessages";
import * as aiProposalsRows from "./sqlite/rows/aiProposals";
import * as aiMemoriesRows from "./sqlite/rows/aiMemories";
import {
  defaultAppSettings,
  normalizeAppSettings,
  type SettingsUpdater,
} from "../../domain/settings";
import {
  taskForAcceptEffect,
  type AcceptEffect,
  type AiProposalAcceptResult,
} from "../ai/proposals/accept-effect";
import { runSqliteTransaction, transactionDb, type TxContext } from "./transaction";
import { runMigrations } from "./migrations";
import { invoke } from "@tauri-apps/api/core";
import {
  buildAnnualGoalSnapshots,
  cloneAnnualGoal,
  updateAnnualGoalEvaluation,
  createEmptyAnnualGoal,
} from "../../domain/annual-goals";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  cloneEntry,
  createEmptyDailyEntry,
} from "../../domain/daily-entry";
import {
  buildMonthlyReviewSummary,
  cloneMonthlyReview,
  getMonthKey,
  listWeekStartsForMonth,
} from "../../domain/monthly-review";
import type {
  AiMemory,
  AiMemoryFilters,
  AiMessage,
  AiProposal,
  AiSurface,
  AiUsageTotals,
  AnnualGoal,
  AnnualGoalSnapshot,
  AppSettings,
  CatalogVerse,
  DailyEntry,
  GtdImportSummary,
  MidWeekDecisions,
  MidWeekDecisionsSaveInput,
  MonthlyReview,
  PomodoroSegment,
  PomodoroSession,
  Project,
  RecurringEditScope,
  RecurringTaskChanges,
  RecurringTaskTemplate,
  RescueTimeSnapshotCacheEntry,
  RescueTimeSnapshotCacheKind,
  Task,
  TaskContext,
  TaskEvent,
  TaskEventFilters,
  WeeklyObjective,
  WeeklyObjectiveResult,
  WeeklyReview,
} from "../../domain/types";
import { mergeObjectiveSecondsPayload } from "../../domain/rescuetime-goals";
import {
  cloneWeeklyObjective,
  createEmptyWeeklyObjective,
  objectiveAfterManualAchievement,
} from "../../domain/weekly-objectives";
import {
  buildWeekDates,
  buildWeeklyReviewSummary,
  cloneWeeklyReview,
  listWeekDates,
  relocateDimancheNotesToNextWeek,
} from "../../domain/weekly-review";
import { t } from "../../i18n";
import { monthKeyToLocalRange } from "../ai/analytics/month-range";
import { buildBackupFileName, isBackupDestinationConfigured, resolveBackupDir } from "../backup";
import { getTodayDate, isSunday } from "../date";
import { formatUnknownError, logDebug } from "../debug";
import {
  buildCarryoverEvents,
  buildDailyTaskBreakdown,
  buildDailyTaskStats,
  buildLifecycleEvents,
  createTaskFromInput,
  filterProjects,
  filterTasks,
} from "../gtd/engine";
import { buildGoogleTasksImport } from "../gtd/google-tasks-import";
import { addCustomVerse } from "../pastor/custom-verse";
import {
  adjustPlannedFieldsForSave,
  reconcileProjectPlannedTasks,
  swapPlannedOrder,
} from "../gtd/planned";
import { promoteDueScheduledTasks as selectDueScheduledPromotions } from "../gtd/scheduled";
import { cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
import { addDays, toLocalDateString } from "../date";
import {
  buildPomodoroSessionDetails,
  buildPomodoroState,
  buildPomodoroTaskSummaries,
  computeDailyPomodoroStats,
  getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset,
  pauseSession,
  requirePomodoroSession,
  resumeSession,
  startSession,
  stopSession,
  switchSessionTask,
} from "../pomodoro/engine";
import {
  applySeriesChangesToTemplate,
  buildRecurringPreviewOccurrences,
  buildTaskFromRecurringTemplate,
  cloneRecurringTemplate,
  createRecurringTemplate,
  filterRecurringTemplates,
  listDueDatesBetween,
  prepareRecurringGeneration,
  recurrenceGenerationHorizon,
  recurringInstanceWasRewound,
  syncTemplateStatusChange,
} from "../recurring/engine";
import { buildDailyRelationshipDrawPlan } from "../relationship-draws";
import { DbSerialQueue } from "./db-serial-queue";
import { EmailTriageSqliteStore } from "./email-triage-sqlite-store";
import { FinanceSqliteStore } from "./finance-sqlite-store";
import type { Database as SqliteDatabase } from "./sqlite-db";
import type {
  AppRepository,
  BackupResult,
  NativeStoragePaths,
  PomodoroStartOptions,
  StorageInfo,
} from "./repository";

/** Thin wrapper around the Rust `db_connect` / `db_execute` / `db_select` commands. */
class Database implements SqliteDatabase {
  private constructor(readonly _path: string) {}

  static async load(path: string): Promise<Database> {
    await invoke<void>("db_connect", { db: path });
    return new Database(path);
  }

  async execute(
    query: string,
    bindValues: unknown[] = [],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }> {
    const [rowsAffected, lastInsertId] = await invoke<[number, number]>("db_execute", {
      query,
      values: bindValues,
    });
    return { rowsAffected, lastInsertId };
  }

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { query, values: bindValues });
  }
}

interface SettingsRow {
  value: string;
}

export class TauriSqliteRepository implements AppRepository {
  private dbPromise: Promise<SqliteDatabase> | null = null;
  private financeStore: FinanceSqliteStore | null = null;
  private readonly writeQueue = new DbSerialQueue();
  readonly emailTriage = new EmailTriageSqliteStore(
    () => this.getDb(),
    {
      getTaskByExternalId: (externalId) => this.getTaskByExternalId(externalId),
      createTask: (input) => this.createTask(input),
      saveTask: (task) => this.saveTask(task),
      persistEvents: (events) => this.persistEvents(events),
      handlesLifecycleEvents: true,
    },
    (work) => this.writeTransaction(work),
    (tx) => ({
      getTaskByExternalId: (externalId) => this.getTaskByExternalId(externalId),
      createTask: (input) => this.createTaskInternal(tx, input),
      saveTask: (task) => this.saveTaskInternal(tx, task),
      persistEvents: (events) => this.persistEvents(events),
      handlesLifecycleEvents: true,
    }),
  );

  /**
   * `openDb` defaults to the real Tauri-backed `Database.load`; tests inject an in-memory
   * adapter instead (see `repository.contract.ts` and `tauri-sqlite-repository.test.ts`).
   * Production behavior is unchanged: only the default argument is new.
   */
  constructor(
    private readonly connectionString = "sqlite:trackdidia.db",
    private readonly openDb: (path: string) => Promise<SqliteDatabase> = Database.load,
  ) {}

  private getFinanceStore(): FinanceSqliteStore {
    if (!this.financeStore) {
      this.financeStore = new FinanceSqliteStore(() => this.getDb());
    }
    return this.financeStore;
  }

  private async getTaskByExternalId(externalId: string): Promise<Task | null> {
    const db = await this.getDb();
    const rows = await db.select<tasksRows.TaskRow[]>(
      `SELECT ${tasksRows.COLUMNS} FROM gtd_tasks WHERE source_external_id = $1`,
      [externalId],
    );
    return rows[0] ? tasksRows.fromRow(rows[0]) : null;
  }

  private writeExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeQueue.run(operation);
  }

  private writeTransaction<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      return runSqliteTransaction(db, work, (rollbackError) => {
        logDebug("error", "storage.sqlite", "Echec ROLLBACK (ignore)", rollbackError);
      });
    });
  }

  async initialize(): Promise<void> {
    logDebug("info", "storage.sqlite", "Initialisation SQLite", this.connectionString);

    try {
      const db = await this.getDb();

      const journalModeRows =
        await db.select<{ journal_mode: string }[]>("PRAGMA journal_mode=WAL");
      logDebug(
        "info",
        "storage.sqlite",
        "Mode journal SQLite",
        journalModeRows[0]?.journal_mode ?? "inconnu",
      );
      await db.execute("PRAGMA busy_timeout = 5000");

      await runMigrations(db, (migration) => {
        logDebug("info", "storage.sqlite", `Execution migration ${migration.id}`, migration.name);
      });

      const existingSettings = await db.select<SettingsRow[]>(
        "SELECT value FROM app_settings WHERE id = 1",
      );
      if (existingSettings.length === 0) {
        await db.execute("INSERT OR IGNORE INTO app_settings (id, value) VALUES (1, $1)", [
          JSON.stringify(defaultAppSettings()),
        ]);
      }

      logDebug("info", "storage.sqlite", "SQLite pret");
      await this.relocateDimancheNotesOnce();
    } catch (error) {
      logDebug("error", "storage.sqlite", "Echec initialisation SQLite", error);
      throw new Error(`SQLite init failed: ${formatUnknownError(error)}`);
    }
  }

  private async relocateDimancheNotesOnce(): Promise<void> {
    await this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);

      const settings = await this.getSettings();
      if (settings.dimancheNotesRelocatedAt) {
        return;
      }

      const rows = await db.select<weeklyReviewsRows.WeeklyReviewRow[]>(
        `SELECT ${weeklyReviewsRows.COLUMNS} FROM weekly_reviews`,
      );
      const changed = relocateDimancheNotesToNextWeek(
        rows.map((row) => weeklyReviewsRows.fromRow(row)),
      );

      for (const review of changed) {
        await this.saveWeeklyReviewInternal(tx, review);
      }
      await this.writeSettingsRow(db, {
        ...settings,
        dimancheNotesRelocatedAt: new Date().toISOString(),
      });
    });
  }

  async getDailyEntry(date: string): Promise<DailyEntry | null> {
    const db = await this.getDb();
    const rows = await db.select<dailyEntriesRows.DailyEntryRow[]>(
      `SELECT ${dailyEntriesRows.COLUMNS} FROM daily_entries
      WHERE date = $1`,
      [date],
    );

    return rows[0] ? this.decorateEntry(dailyEntriesRows.fromRow(rows[0])) : null;
  }

  async saveDailyEntry(entry: DailyEntry): Promise<void> {
    const decoratedEntry = await this.decorateEntry(entry);
    return this.writeTransaction((tx) => this.saveDailyEntryInternal(tx, decoratedEntry));
  }
  private async saveDailyEntryInternal(tx: TxContext, entry: DailyEntry): Promise<void> {
    const db = transactionDb(tx);

    await db.execute(
      `INSERT INTO daily_entries (${dailyEntriesRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT(date) DO UPDATE SET
        status = excluded.status,
        metrics_json = excluded.metrics_json,
        principles_json = excluded.principles_json,
        morning_intention = excluded.morning_intention,
        night_reflection = excluded.night_reflection,
        tomorrow_focus = excluded.tomorrow_focus,
        updated_at = excluded.updated_at`,
      dailyEntriesRows.toParams(entry),
    );
  }

  async listDailyEntries(limit = 30): Promise<DailyEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<dailyEntriesRows.DailyEntryRow[]>(
      `SELECT ${dailyEntriesRows.COLUMNS} FROM daily_entries
      ORDER BY date DESC
      LIMIT $1`,
      [limit],
    );

    return Promise.all(rows.map((row) => this.decorateEntry(dailyEntriesRows.fromRow(row))));
  }

  async listDailyEntriesOnOrBefore(endDate: string, limit = 180): Promise<DailyEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<dailyEntriesRows.DailyEntryRow[]>(
      `SELECT ${dailyEntriesRows.COLUMNS} FROM daily_entries
      WHERE date <= $1
      ORDER BY date DESC
      LIMIT $2`,
      [endDate, limit],
    );

    return Promise.all(rows.map((row) => this.decorateEntry(dailyEntriesRows.fromRow(row))));
  }

  async listDailyEntriesInRange(startDate: string, endDate: string): Promise<DailyEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<dailyEntriesRows.DailyEntryRow[]>(
      `SELECT ${dailyEntriesRows.COLUMNS} FROM daily_entries
      WHERE date >= $1 AND date <= $2
      ORDER BY date DESC`,
      [startDate, endDate],
    );

    // Journal only reads note text. Skip decorateEntry so a wide range cannot
    // fan out into per-day GTD/Pomodoro writes and full-table scans.
    return rows.map((row) => dailyEntriesRows.fromRow(row));
  }

  async getWeeklyReview(weekStartDate: string): Promise<WeeklyReview | null> {
    const db = await this.getDb();
    const normalized = buildWeekDates(weekStartDate);
    const rows = await db.select<weeklyReviewsRows.WeeklyReviewRow[]>(
      `SELECT ${weeklyReviewsRows.COLUMNS} FROM weekly_reviews
      WHERE week_start_date = $1`,
      [normalized],
    );

    return rows[0] ? weeklyReviewsRows.fromRow(rows[0]) : null;
  }

  async saveWeeklyReview(review: WeeklyReview): Promise<void> {
    return this.writeTransaction(async (tx) => {
      return this.saveWeeklyReviewInternal(tx, review);
    });
  }

  /**
   * Transaction-scoped weekly review upsert. Callers must already hold an open writer slot
   * (via `writeTransaction`) and must not re-enter the writer from here.
   */
  private async saveWeeklyReviewInternal(tx: TxContext, review: WeeklyReview): Promise<void> {
    const db = transactionDb(tx);

    const normalized = buildWeekDates(review.weekStartDate);
    const nextReview = {
      ...cloneWeeklyReview(review),
      weekStartDate: normalized,
      weekEndDate: addDays(normalized, 6),
    };

    await db.execute(
      `INSERT INTO weekly_reviews (${weeklyReviewsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT(week_start_date) DO UPDATE SET
      week_end_date = excluded.week_end_date,
      status = excluded.status,
      notes_json = excluded.notes_json,
      ritual_checklist_json = excluded.ritual_checklist_json,
      updated_at = excluded.updated_at`,
      weeklyReviewsRows.toParams(nextReview),
    );
  }

  async listWeeklyReviews(limit = 12): Promise<WeeklyReview[]> {
    const db = await this.getDb();
    const rows = await db.select<weeklyReviewsRows.WeeklyReviewRow[]>(
      `SELECT ${weeklyReviewsRows.COLUMNS} FROM weekly_reviews
      ORDER BY week_start_date DESC
      LIMIT $1`,
      [limit],
    );

    return rows.map((row) => weeklyReviewsRows.fromRow(row));
  }

  async listWeeklyReviewsOverlapping(startDate: string, endDate: string): Promise<WeeklyReview[]> {
    const db = await this.getDb();
    const rows = await db.select<weeklyReviewsRows.WeeklyReviewRow[]>(
      `SELECT ${weeklyReviewsRows.COLUMNS} FROM weekly_reviews
      WHERE week_start_date <= $2 AND week_end_date >= $1
      ORDER BY week_start_date DESC`,
      [startDate, endDate],
    );

    return rows.map((row) => weeklyReviewsRows.fromRow(row));
  }

  async getMonthlyReview(monthKey: string): Promise<MonthlyReview | null> {
    const db = await this.getDb();
    const normalized = getMonthKey(`${monthKey}-01`);
    const rows = await db.select<monthlyReviewsRows.MonthlyReviewRow[]>(
      `SELECT ${monthlyReviewsRows.COLUMNS} FROM monthly_reviews
      WHERE month_key = $1`,
      [normalized],
    );

    return rows[0] ? monthlyReviewsRows.fromRow(rows[0]) : null;
  }

  async saveMonthlyReview(review: MonthlyReview): Promise<void> {
    return this.writeTransaction(async (tx) => {
      return this.saveMonthlyReviewInternal(tx, review);
    });
  }

  /**
   * Transaction-scoped monthly review upsert. Callers must already hold an open writer slot
   * (via `writeTransaction`) and must not re-enter the writer from here.
   */
  private async saveMonthlyReviewInternal(tx: TxContext, review: MonthlyReview): Promise<void> {
    const db = transactionDb(tx);

    const normalized = getMonthKey(`${review.monthKey}-01`);
    const nextReview = {
      ...cloneMonthlyReview(review),
      monthKey: normalized,
    };

    await db.execute(
      `INSERT INTO monthly_reviews (${monthlyReviewsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(month_key) DO UPDATE SET
      month_start_date = excluded.month_start_date,
      month_end_date = excluded.month_end_date,
      status = excluded.status,
      notes_json = excluded.notes_json,
      ritual_checklist_json = excluded.ritual_checklist_json,
      updated_at = excluded.updated_at`,
      monthlyReviewsRows.toParams(nextReview),
    );
  }

  async listMonthlyReviews(limit = 12): Promise<MonthlyReview[]> {
    const db = await this.getDb();
    const rows = await db.select<monthlyReviewsRows.MonthlyReviewRow[]>(
      `SELECT ${monthlyReviewsRows.COLUMNS} FROM monthly_reviews
      ORDER BY month_key DESC
      LIMIT $1`,
      [limit],
    );

    return rows.map((row) => monthlyReviewsRows.fromRow(row));
  }

  async listMonthlyReviewsOverlapping(
    startDate: string,
    endDate: string,
  ): Promise<MonthlyReview[]> {
    const db = await this.getDb();
    const rows = await db.select<monthlyReviewsRows.MonthlyReviewRow[]>(
      `SELECT ${monthlyReviewsRows.COLUMNS} FROM monthly_reviews
      WHERE month_start_date <= $2 AND month_end_date >= $1
      ORDER BY month_key DESC`,
      [startDate, endDate],
    );

    return rows.map((row) => monthlyReviewsRows.fromRow(row));
  }

  async computeMonthlyReviewSummary(monthKey: string) {
    const normalized = getMonthKey(`${monthKey}-01`);
    const entries = (
      await Promise.all(
        (
          await this.listDailyEntries(5000)
        )
          .filter((entry) => getMonthKey(entry.date) === normalized)
          .map((entry) => this.decorateEntry(entry)),
      )
    ).sort((left, right) => left.date.localeCompare(right.date));
    const weekStarts = listWeekStartsForMonth(normalized);
    const weeklySummaries = await Promise.all(
      weekStarts.map((weekStartDate) => this.computeWeeklyReviewSummary(weekStartDate)),
    );
    const weeklyReviews = (
      await Promise.all(weekStarts.map((weekStartDate) => this.getWeeklyReview(weekStartDate)))
    ).filter((review): review is WeeklyReview => Boolean(review));

    return buildMonthlyReviewSummary(normalized, entries, weeklyReviews, weeklySummaries);
  }

  async listAnnualGoals(): Promise<AnnualGoal[]> {
    const db = await this.getDb();
    const rows = await db.select<annualGoalsRows.AnnualGoalRow[]>(
      `SELECT ${annualGoalsRows.COLUMNS} FROM annual_goals
      ORDER BY title ASC`,
    );

    return rows.map((row) => annualGoalsRows.fromRow(row));
  }

  async saveAnnualGoal(goal: AnnualGoal): Promise<AnnualGoal> {
    return this.writeTransaction((tx) => this.saveAnnualGoalInternal(tx, goal));
  }
  private async saveAnnualGoalInternal(tx: TxContext, goal: AnnualGoal): Promise<AnnualGoal> {
    const db = transactionDb(tx);
    const timestamp = nowIso();
    const nextGoal = createEmptyAnnualGoal({
      ...cloneAnnualGoal(goal),
      id: goal.id || createEntityId("annual-goal"),
      title: goal.title.trim(),
      description: goal.description.trim(),
      unit: goal.unit.trim(),
      createdAt: goal.createdAt || timestamp,
      updatedAt: timestamp,
    });

    await db.execute(
      `INSERT INTO annual_goals (${annualGoalsRows.COLUMNS}) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        dimension = excluded.dimension,
        description = excluded.description,
        target_value = excluded.target_value,
        unit = excluded.unit,
        source_id = excluded.source_id,
        manual_current_value = excluded.manual_current_value,
        evaluations_json = excluded.evaluations_json,
        measurement_type = excluded.measurement_type,
        status = excluded.status,
        deadline = excluded.deadline,
        starting_value = excluded.starting_value,
        direction = excluded.direction,
        cadence_target = excluded.cadence_target,
        cadence_period = excluded.cadence_period,
        principle_key = excluded.principle_key,
        progress_log_json = excluded.progress_log_json,
        milestones_json = excluded.milestones_json,
        updated_at = excluded.updated_at`,
      annualGoalsRows.toParams(nextGoal),
    );

    return cloneAnnualGoal(nextGoal);
  }

  async deleteAnnualGoal(goalId: string): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await db.execute("DELETE FROM annual_goals WHERE id = $1", [goalId]);
    });
  }

  async computeAnnualGoalSnapshots(
    year: number,
    asOfDate: string = getTodayDate(),
  ): Promise<AnnualGoalSnapshot[]> {
    const goals = await this.listAnnualGoals();
    const entries = (await this.listDailyEntries(5000)).filter((entry) =>
      entry.date.startsWith(`${year}-`),
    );
    const weekStarts = [...new Set(entries.map((entry) => buildWeekDates(entry.date)))].sort();
    const weeklySummaries = await Promise.all(
      weekStarts.map((weekStartDate) => this.computeWeeklyReviewSummary(weekStartDate)),
    );
    return buildAnnualGoalSnapshots(goals, year, entries, weeklySummaries, asOfDate);
  }

  async computeWeeklyReviewSummary(weekStartDate: string) {
    const normalized = buildWeekDates(weekStartDate);
    const entries = await Promise.all(
      listWeekDates(normalized).map(async (date) => {
        const existing = await this.getDailyEntry(date);
        return existing ?? this.decorateEntry(createEmptyDailyEntry(date));
      }),
    );

    return buildWeeklyReviewSummary(normalized, entries);
  }

  async listWeeklyObjectives(): Promise<WeeklyObjective[]> {
    const db = await this.getDb();
    const rows = await db.select<weeklyObjectivesRows.WeeklyObjectiveRow[]>(
      `SELECT ${weeklyObjectivesRows.COLUMNS}
      FROM weekly_objectives
      ORDER BY sort_order ASC, title ASC`,
    );

    return rows.map((row) => weeklyObjectivesRows.fromRow(row));
  }

  async saveWeeklyObjective(objective: WeeklyObjective): Promise<WeeklyObjective> {
    return this.writeTransaction(async (tx) => {
      return this.saveWeeklyObjectiveInternal(tx, objective);
    });
  }

  /**
   * Transaction-scoped weekly objective upsert. Callers must already hold an open writer slot
   * (via `writeTransaction`) and must not re-enter the writer from here.
   */
  private async saveWeeklyObjectiveInternal(
    tx: TxContext,
    objective: WeeklyObjective,
  ): Promise<WeeklyObjective> {
    const db = transactionDb(tx);

    const timestamp = nowIso();
    const nextObjective = createEmptyWeeklyObjective({
      ...cloneWeeklyObjective(objective),
      id: objective.id || createEntityId("weekly-objective"),
      title: objective.title.trim(),
      createdAt: objective.createdAt || timestamp,
      updatedAt: timestamp,
    });

    await db.execute(
      `INSERT INTO weekly_objectives (${weeklyObjectivesRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      kind = excluded.kind,
      target_hours = excluded.target_hours,
      rescuetime_kind = excluded.rescuetime_kind,
      rescuetime_thing = excluded.rescuetime_thing,
      sort_order = excluded.sort_order,
      starts_on_week_start_date = excluded.starts_on_week_start_date,
      ends_on_week_start_date = excluded.ends_on_week_start_date,
      updated_at = excluded.updated_at`,
      weeklyObjectivesRows.toParams(nextObjective),
    );

    return cloneWeeklyObjective(nextObjective);
  }

  async deleteWeeklyObjective(objectiveId: string): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await db.execute("DELETE FROM weekly_objective_results WHERE objective_id = $1", [
        objectiveId,
      ]);
      await db.execute("DELETE FROM weekly_objectives WHERE id = $1", [objectiveId]);
    });
  }

  async getWeeklyObjectiveResults(weekStartDate: string): Promise<WeeklyObjectiveResult[]> {
    const db = await this.getDb();
    const normalized = buildWeekDates(weekStartDate);
    const rows = await db.select<weeklyObjectiveResultsRows.WeeklyObjectiveResultRow[]>(
      `SELECT ${weeklyObjectiveResultsRows.COLUMNS} FROM weekly_objective_results
       WHERE week_start_date = $1`,
      [normalized],
    );

    return rows.map((row) => weeklyObjectiveResultsRows.fromRow(row));
  }

  async getMidWeekDecisions(weekStartDate: string): Promise<MidWeekDecisions | null> {
    const db = await this.getDb();
    const rows = await db.select<midWeekDecisionsRows.MidWeekDecisionsRow[]>(
      `SELECT ${midWeekDecisionsRows.COLUMNS} FROM mid_week_decisions WHERE week_start_date = $1`,
      [buildWeekDates(weekStartDate)],
    );
    const row = rows[0];
    return row ? midWeekDecisionsRows.fromRow(row) : null;
  }

  async saveMidWeekDecisions(input: MidWeekDecisionsSaveInput): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await db.execute(
        `INSERT INTO mid_week_decisions
           (${midWeekDecisionsRows.COLUMNS})
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(week_start_date) DO UPDATE SET
           decisions = excluded.decisions,
           decided_on_date = excluded.decided_on_date,
           updated_at = excluded.updated_at,
           lagging_snapshot_json = COALESCE(
             excluded.lagging_snapshot_json,
             mid_week_decisions.lagging_snapshot_json
           )`,
        midWeekDecisionsRows.toParams(input),
      );
    });
  }

  async getRescueTimeSnapshotCache(
    weekStartDate: string,
    kind: RescueTimeSnapshotCacheKind,
    credentialFingerprint: string,
  ): Promise<RescueTimeSnapshotCacheEntry | null> {
    const db = await this.getDb();
    return this.selectRescueTimeCacheEntry(
      db,
      buildWeekDates(weekStartDate),
      kind,
      credentialFingerprint,
    );
  }

  private async selectRescueTimeCacheEntry(
    db: SqliteDatabase,
    weekStartDate: string,
    kind: RescueTimeSnapshotCacheKind,
    credentialFingerprint: string,
  ): Promise<RescueTimeSnapshotCacheEntry | null> {
    const rows = await db.select<rescueTimeCacheRows.RescueTimeCacheRow[]>(
      `SELECT ${rescueTimeCacheRows.COLUMNS} FROM rescuetime_snapshot_cache
       WHERE week_start_date = $1 AND kind = $2 AND credential_fingerprint = $3`,
      [weekStartDate, kind, credentialFingerprint],
    );
    const row = rows[0];
    return row ? rescueTimeCacheRows.fromRow(row) : null;
  }

  private async upsertRescueTimeCacheEntry(
    db: SqliteDatabase,
    entry: RescueTimeSnapshotCacheEntry,
  ): Promise<void> {
    await db.execute(
      `INSERT INTO rescuetime_snapshot_cache
         (${rescueTimeCacheRows.COLUMNS})
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(week_start_date, kind, credential_fingerprint) DO UPDATE SET
         payload_json = excluded.payload_json,
         fetched_at = excluded.fetched_at`,
      rescueTimeCacheRows.toParams(entry),
    );
  }

  async saveRescueTimeSnapshotCache(entry: RescueTimeSnapshotCacheEntry): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await this.upsertRescueTimeCacheEntry(db, entry);
    });
  }

  async pruneRescueTimeSnapshotCache(keepFingerprint: string | null): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      if (keepFingerprint === null) {
        await db.execute("DELETE FROM rescuetime_snapshot_cache");
        return;
      }
      await db.execute("DELETE FROM rescuetime_snapshot_cache WHERE credential_fingerprint <> $1", [
        keepFingerprint,
      ]);
    });
  }

  /**
   * Read, merge and upsert inside one `writeExclusive`, so no other queued write can land between
   * the read and the upsert. Uses the open connection directly and never re-enters the queue.
   */
  async mergeRescueTimeObjectiveSecondsCache(input: {
    weekStartDate: string;
    credentialFingerprint: string;
    values: Record<string, { seconds: number; fetchedAt: string }>;
    fetchedAt: string;
  }): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      const weekStartDate = buildWeekDates(input.weekStartDate);
      const existing = await this.selectRescueTimeCacheEntry(
        db,
        weekStartDate,
        "objective_seconds",
        input.credentialFingerprint,
      );
      const merged = mergeObjectiveSecondsPayload(existing?.payloadJson ?? null, input.values);
      await this.upsertRescueTimeCacheEntry(db, {
        weekStartDate,
        kind: "objective_seconds",
        credentialFingerprint: input.credentialFingerprint,
        payloadJson: JSON.stringify(merged),
        fetchedAt: input.fetchedAt,
      });
    });
  }

  async saveWeeklyObjectiveResult(result: WeeklyObjectiveResult): Promise<void> {
    return this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);

      const normalized = buildWeekDates(result.weekStartDate);
      const timestamp = nowIso();
      const nextResult: WeeklyObjectiveResult = {
        weekStartDate: normalized,
        objectiveId: result.objectiveId,
        achieved: result.achieved,
        updatedAt: timestamp,
      };

      await db.execute(
        `INSERT INTO weekly_objective_results (${weeklyObjectiveResultsRows.COLUMNS})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(week_start_date, objective_id) DO UPDATE SET
         achieved = excluded.achieved,
         updated_at = excluded.updated_at`,
        weeklyObjectiveResultsRows.toParams(nextResult),
      );

      const rows = await db.select<weeklyObjectivesRows.WeeklyObjectiveRow[]>(
        `SELECT ${weeklyObjectivesRows.COLUMNS}
         FROM weekly_objectives
         WHERE id = $1`,
        [nextResult.objectiveId],
      );
      const objective = rows[0] ? weeklyObjectivesRows.fromRow(rows[0]) : null;
      if (objective) {
        const nextObjective = objectiveAfterManualAchievement(
          objective,
          normalized,
          nextResult.achieved,
        );
        if (nextObjective.endsOnWeekStartDate !== objective.endsOnWeekStartDate) {
          await this.saveWeeklyObjectiveInternal(tx, nextObjective);
        }
      }
    });
  }

  async getSettings(): Promise<AppSettings> {
    const db = await this.getDb();
    const rows = await db.select<SettingsRow[]>("SELECT value FROM app_settings WHERE id = 1");

    if (rows.length === 0) {
      return defaultAppSettings();
    }

    return normalizeAppSettings(
      JSON.parse(rows[0].value) as Partial<AppSettings>,
      defaultAppSettings(),
    );
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await this.writeSettingsRow(db, settings);
    });
  }

  /** Callers must already hold the repository writer slot. */
  private async writeSettingsRow(db: SqliteDatabase, settings: AppSettings): Promise<AppSettings> {
    const normalized = normalizeAppSettings(settings, defaultAppSettings());
    await db.execute(
      `INSERT INTO app_settings (id, value)
       VALUES (1, $1)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(normalized)],
    );
    return normalized;
  }

  /** Read/apply/write is protected by the writer and rolls back on failure. */
  async updateSettings(updater: SettingsUpdater): Promise<AppSettings> {
    return this.writeTransaction(async (tx) => {
      const current = await this.getSettings();
      return this.writeSettingsRow(transactionDb(tx), updater(current));
    });
  }

  async addPastorCustomVerse(
    candidate: CatalogVerse,
  ): Promise<{ added: boolean; settings: AppSettings }> {
    let added = false;
    const settings = await this.updateSettings((current) => {
      const result = addCustomVerse(current.aiPastorCustomVerses, candidate);
      added = result.added;
      return { ...current, aiPastorCustomVerses: result.customVerses };
    });
    return { added, settings };
  }

  async getAiMessage(
    surface: AiSurface,
    scopeKey: string,
    inputHash: string,
  ): Promise<AiMessage | null> {
    const db = await this.getDb();
    const rows = await db.select<aiMessagesRows.AiMessageRow[]>(
      `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
       WHERE surface = $1 AND scope_key = $2 AND input_hash = $3 AND status = 'ok'
       ORDER BY created_at DESC
       LIMIT 1`,
      [surface, scopeKey, inputHash],
    );

    if (rows.length === 0) {
      return null;
    }

    return aiMessagesRows.fromRow(rows[0]);
  }

  async getAiMessageRecord(
    surface: AiSurface,
    scopeKey: string,
    inputHash: string,
  ): Promise<AiMessage | null> {
    const db = await this.getDb();
    const rows = await db.select<aiMessagesRows.AiMessageRow[]>(
      `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
       WHERE surface = $1 AND scope_key = $2 AND input_hash = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [surface, scopeKey, inputHash],
    );

    if (rows.length === 0) {
      return null;
    }

    return aiMessagesRows.fromRow(rows[0]);
  }

  async getLatestAiMessage(
    surface: AiSurface,
    scopeKey: string,
    status?: AiMessage["status"],
  ): Promise<AiMessage | null> {
    const db = await this.getDb();
    const rows =
      status === undefined
        ? await db.select<aiMessagesRows.AiMessageRow[]>(
            `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
             WHERE surface = $1 AND scope_key = $2
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [surface, scopeKey],
          )
        : await db.select<aiMessagesRows.AiMessageRow[]>(
            `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
             WHERE surface = $1 AND scope_key = $2 AND status = $3
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [surface, scopeKey, status],
          );

    if (rows.length === 0) {
      return null;
    }

    return aiMessagesRows.fromRow(rows[0]);
  }

  private async insertAiMessage(db: SqliteDatabase, message: AiMessage): Promise<AiMessage> {
    await db.execute(
      `INSERT INTO ai_messages (${aiMessagesRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      aiMessagesRows.toParams(message),
    );

    const rows = await db.select<aiMessagesRows.AiMessageRow[]>(
      `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
       WHERE id = $1`,
      [message.id],
    );

    if (rows.length === 0) {
      throw new Error("AI message insert failed");
    }

    return aiMessagesRows.fromRow(rows[0]);
  }

  async saveAiMessage(message: AiMessage): Promise<AiMessage> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      return this.insertAiMessage(db, message);
    });
  }

  async saveCoachPulseEpisode(
    message: AiMessage,
    proposals: AiProposal[],
  ): Promise<{ message: AiMessage; proposals: AiProposal[] }> {
    return this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);

      const savedMessage = await this.insertAiMessage(db, message);
      await db.execute(
        `DELETE FROM ai_proposals
           WHERE message_id = $1 AND status = 'pending'`,
        [savedMessage.id],
      );

      const savedProposals: AiProposal[] = [];
      for (const proposal of proposals) {
        await db.execute(
          `INSERT INTO ai_proposals (${aiProposalsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          aiProposalsRows.toParams({ ...proposal, messageId: savedMessage.id }),
        );
        savedProposals.push({ ...proposal, messageId: savedMessage.id });
      }

      return { message: savedMessage, proposals: savedProposals };
    });
  }

  async listAiMessages(surface?: AiSurface, limit = 50): Promise<AiMessage[]> {
    const db = await this.getDb();
    const rows = surface
      ? await db.select<aiMessagesRows.AiMessageRow[]>(
          `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
           WHERE surface = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [surface, limit],
        )
      : await db.select<aiMessagesRows.AiMessageRow[]>(
          `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit],
        );

    return rows.map((row) => aiMessagesRows.fromRow(row));
  }

  async listAiMessagesForDate(date: string): Promise<AiMessage[]> {
    const db = await this.getDb();
    const rows = await db.select<aiMessagesRows.AiMessageRow[]>(
      `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
       WHERE scope_key = $1 OR scope_key LIKE $2
       ORDER BY created_at ASC`,
      [date, `${date}#%`],
    );

    return rows.map((row) => aiMessagesRows.fromRow(row));
  }

  async listAiMessagesSince(sinceIso: string, limit = 10_000): Promise<AiMessage[]> {
    const db = await this.getDb();
    const rows = await db.select<aiMessagesRows.AiMessageRow[]>(
      `SELECT ${aiMessagesRows.COLUMNS} FROM ai_messages
       WHERE created_at >= $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sinceIso, limit],
    );

    return rows.reverse().map((row) => aiMessagesRows.fromRow(row));
  }

  async listAiProposals(messageId: string): Promise<AiProposal[]> {
    const db = await this.getDb();
    const rows = await db.select<aiProposalsRows.AiProposalRow[]>(
      `SELECT ${aiProposalsRows.COLUMNS} FROM ai_proposals
       WHERE message_id = $1
       ORDER BY created_at ASC`,
      [messageId],
    );

    return rows.map((row) => aiProposalsRows.fromRow(row));
  }

  async listAiProposalsSince(sinceIso: string): Promise<AiProposal[]> {
    const db = await this.getDb();
    const rows = await db.select<aiProposalsRows.AiProposalRow[]>(
      `SELECT ${aiProposalsRows.COLUMNS} FROM ai_proposals
       WHERE created_at >= $1
       ORDER BY created_at ASC`,
      [sinceIso],
    );

    return rows.map((row) => aiProposalsRows.fromRow(row));
  }

  async computeAiUsageForMonth(monthKey: string): Promise<AiUsageTotals> {
    const { startIso, endIso } = monthKeyToLocalRange(monthKey);
    const db = await this.getDb();
    const rows = await db.select<
      Array<{ call_count: number; tokens_prompt: number | null; tokens_completion: number | null }>
    >(
      `SELECT COUNT(*) AS call_count,
              COALESCE(SUM(tokens_prompt), 0) AS tokens_prompt,
              COALESCE(SUM(tokens_completion), 0) AS tokens_completion
       FROM ai_messages
       WHERE created_at >= $1 AND created_at < $2 AND status != 'local'`,
      [startIso, endIso],
    );

    const aggregate = rows[0] ?? { call_count: 0, tokens_prompt: 0, tokens_completion: 0 };
    const tokensPrompt = aggregate.tokens_prompt ?? 0;
    const tokensCompletion = aggregate.tokens_completion ?? 0;

    return {
      monthKey,
      callCount: aggregate.call_count,
      tokensPrompt,
      tokensCompletion,
      tokensTotal: tokensPrompt + tokensCompletion,
    };
  }

  async saveAiProposal(proposal: AiProposal): Promise<AiProposal> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await db.execute(
        `INSERT INTO ai_proposals (${aiProposalsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        payload_json = excluded.payload_json,
        status = excluded.status,
        applied_entity_id = excluded.applied_entity_id,
        decided_at = excluded.decided_at`,
        aiProposalsRows.toParams(proposal),
      );

      return proposal;
    });
  }

  async clearPendingAiProposals(messageId: string): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      await db.execute("DELETE FROM ai_proposals WHERE message_id = $1 AND status = 'pending'", [
        messageId,
      ]);
    });
  }

  async decideAiProposal(
    id: string,
    status: "accepted" | "dismissed",
    appliedEntityId?: string,
  ): Promise<AiProposal> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      const decidedAt = nowIso();
      await db.execute(
        `UPDATE ai_proposals
       SET status = $1, applied_entity_id = $2, decided_at = $3
       WHERE id = $4`,
        [status, appliedEntityId ?? null, decidedAt, id],
      );

      const rows = await db.select<aiProposalsRows.AiProposalRow[]>(
        `SELECT ${aiProposalsRows.COLUMNS} FROM ai_proposals
       WHERE id = $1`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error(`AI proposal not found: ${id}`);
      }

      return aiProposalsRows.fromRow(rows[0]);
    });
  }

  async acceptAiProposal(
    proposalId: string,
    effect: AcceptEffect | null,
  ): Promise<AiProposalAcceptResult> {
    return this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);
      const rows = await db.select<aiProposalsRows.AiProposalRow[]>(
        `SELECT ${aiProposalsRows.COLUMNS} FROM ai_proposals WHERE id = $1`,
        [proposalId],
      );
      if (!rows[0]) throw new Error(`AI proposal not found: ${proposalId}`);
      const proposal = aiProposalsRows.fromRow(rows[0]);
      if (proposal.status === "accepted") {
        if (effect?.kind === "memory" || effect?.kind === "weeklyObjective") {
          const id =
            proposal.appliedEntityId ??
            (effect.kind === "memory" ? effect.memory.id : effect.objective.id);
          const table = effect.kind === "memory" ? "ai_memories" : "weekly_objectives";
          const existing = await db.select<{ id: string }[]>(
            `SELECT id FROM ${table} WHERE id = $1`,
            [id],
          );
          if (!existing[0])
            throw new Error(
              `${effect.kind === "memory" ? "AI memory" : "Weekly objective"} not found: ${id}`,
            );
        }
        const appliedEntityId =
          proposal.appliedEntityId ??
          (effect?.kind === "memory"
            ? effect.memory.id
            : effect?.kind === "weeklyObjective"
              ? effect.objective.id
              : null);
        return { proposal, appliedEntityId, effectApplied: false };
      }
      if (!effect || proposal.status !== "pending")
        return { proposal, appliedEntityId: null, effectApplied: false };

      let appliedEntityId: string;
      switch (effect.kind) {
        case "memory": {
          const existing = await db.select<{ id: string }[]>(
            "SELECT id FROM ai_memories WHERE id = $1",
            [effect.memory.id],
          );
          appliedEntityId =
            existing[0]?.id ?? (await this.saveAiMemoryInternal(tx, effect.memory)).id;
          break;
        }
        case "weeklyObjective":
          appliedEntityId = (await this.saveWeeklyObjectiveInternal(tx, effect.objective)).id;
          break;
        case "weeklyReview":
          await this.saveWeeklyReviewInternal(tx, effect.review);
          appliedEntityId = effect.review.weekStartDate;
          break;
        case "monthlyReview":
          await this.saveMonthlyReviewInternal(tx, effect.review);
          appliedEntityId = effect.review.monthKey;
          break;
        case "dailyEntry":
          await this.saveDailyEntryInternal(tx, effect.entry);
          appliedEntityId = effect.entry.date;
          break;
        case "goalEvaluation": {
          const rows = await db.select<annualGoalsRows.AnnualGoalRow[]>(
            `SELECT ${annualGoalsRows.COLUMNS} FROM annual_goals WHERE id = $1`,
            [effect.goalId],
          );
          const goal = rows[0] ? annualGoalsRows.fromRow(rows[0]) : null;
          if (!goal) return { proposal, appliedEntityId: null, effectApplied: false };
          appliedEntityId = (
            await this.saveAnnualGoalInternal(
              tx,
              updateAnnualGoalEvaluation(goal, effect.monthKey, effect.evaluation),
            )
          ).id;
          break;
        }
        case "gtdTask": {
          const task = await this.getTaskById(effect.taskId);
          const next = task ? taskForAcceptEffect(task, effect) : null;
          if (!task || !next) return { proposal, appliedEntityId: null, effectApplied: false };
          await this.saveTaskInternal(tx, next);
          if (effect.action === "drop" && task.recurringTemplateId) {
            const template = await this.requireRecurringTemplate(task.recurringTemplateId);
            await this.persistRecurringTemplate({
              ...cloneRecurringTemplate(template),
              pendingMissedOccurrences: 0,
              updatedAt: nowIso(),
            });
          }
          appliedEntityId = task.id;
          break;
        }
      }
      const decidedAt = nowIso();
      await db.execute(
        `UPDATE ai_proposals SET status = 'accepted', applied_entity_id = $1, decided_at = $2 WHERE id = $3`,
        [appliedEntityId, decidedAt, proposalId],
      );
      return {
        proposal: { ...proposal, status: "accepted", appliedEntityId, decidedAt },
        appliedEntityId,
        effectApplied: true,
      };
    });
  }

  async listAiMemories(filters: AiMemoryFilters = {}): Promise<AiMemory[]> {
    const db = await this.getDb();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      clauses.push(
        `status IN (${statuses.map((_, index) => `$${params.length + index + 1}`).join(", ")})`,
      );
      params.push(...statuses);
    }

    if (filters.kind) {
      const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
      clauses.push(
        `kind IN (${kinds.map((_, index) => `$${params.length + index + 1}`).join(", ")})`,
      );
      params.push(...kinds);
    }

    if (typeof filters.pinned === "boolean") {
      clauses.push(`pinned = $${params.length + 1}`);
      params.push(filters.pinned ? 1 : 0);
    }

    if (filters.activeOnDate) {
      clauses.push(`(expires_at IS NULL OR expires_at >= $${params.length + 1})`);
      params.push(filters.activeOnDate);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await db.select<aiMemoriesRows.AiMemoryRow[]>(
      `SELECT ${aiMemoriesRows.COLUMNS} FROM ai_memories
       ${where}
       ORDER BY created_at DESC`,
      params,
    );

    return rows.map((row) => aiMemoriesRows.fromRow(row));
  }

  async saveAiMemory(memory: AiMemory): Promise<AiMemory> {
    return this.writeTransaction(async (tx) => {
      return this.saveAiMemoryInternal(tx, memory);
    });
  }

  /**
   * Transaction-scoped memory upsert. Callers must already hold an open writer slot
   * (via `writeTransaction`) and must not re-enter the writer from here.
   */
  private async saveAiMemoryInternal(tx: TxContext, memory: AiMemory): Promise<AiMemory> {
    const db = transactionDb(tx);

    await db.execute(
      `INSERT INTO ai_memories (${aiMemoriesRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        statement = excluded.statement,
        detail = excluded.detail,
        confidence = excluded.confidence,
        source = excluded.source,
        status = excluded.status,
        evidence_from = excluded.evidence_from,
        evidence_to = excluded.evidence_to,
        last_confirmed_at = excluded.last_confirmed_at,
        expires_at = excluded.expires_at,
        pinned = excluded.pinned`,
      aiMemoriesRows.toParams(memory),
    );

    const rows = await db.select<aiMemoriesRows.AiMemoryRow[]>(
      `SELECT ${aiMemoriesRows.COLUMNS} FROM ai_memories
       WHERE id = $1`,
      [memory.id],
    );

    if (rows.length === 0) {
      throw new Error("AI memory upsert failed");
    }

    return aiMemoriesRows.fromRow(rows[0]);
  }

  async archiveAiMemory(
    id: string,
    reason: "expired" | "contradicted" | "resolved",
  ): Promise<void> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      const rows = await db.select<aiMemoriesRows.AiMemoryRow[]>(
        `SELECT ${aiMemoriesRows.COLUMNS} FROM ai_memories
       WHERE id = $1`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error(`AI memory not found: ${id}`);
      }

      const existing = aiMemoriesRows.fromRow(rows[0]);
      const status = reason === "contradicted" ? "contradicted" : "archived";
      const detailSuffix = `[archive:${reason}]`;
      const detail = existing.detail.includes(detailSuffix)
        ? existing.detail
        : `${existing.detail}${existing.detail ? " " : ""}${detailSuffix}`.trim();

      await db.execute(
        `UPDATE ai_memories
       SET status = $1, detail = $2, last_confirmed_at = $3
       WHERE id = $4`,
        [status, detail, nowIso(), id],
      );
    });
  }

  async getStorageInfo(): Promise<StorageInfo> {
    const native = await invoke<NativeStoragePaths>("resolve_storage_paths");
    const settings = await this.getSettings();
    return {
      ...native,
      backupDir: isBackupDestinationConfigured(settings.backupDestinationDir)
        ? resolveBackupDir(settings.backupDestinationDir, native.environment)
        : "",
    };
  }

  async createBackup(kind: "manual" | "auto" = "manual"): Promise<BackupResult> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      const settings = await this.getSettings();
      if (!isBackupDestinationConfigured(settings.backupDestinationDir)) {
        throw new Error(t("backup.missingDestination", { ns: "settings" }));
      }

      const storageInfo = await invoke<NativeStoragePaths>("resolve_storage_paths");
      const backupDir = await invoke<string>("ensure_backup_dir", {
        destinationDir: settings.backupDestinationDir,
        environment: storageInfo.environment,
      });
      const createdAt = new Date().toISOString();
      const backupPath = `${backupDir}/${buildBackupFileName(createdAt, kind)}`;
      const escapedPath = backupPath.replace(/'/g, "''");

      logDebug("info", "storage.backup", "Creation d'un backup SQLite", {
        kind,
        backupPath,
      });

      await db.execute(`VACUUM INTO '${escapedPath}'`);

      try {
        const prune = await invoke<{ deletedPaths: string[]; failed: string[]; keptCount: number }>(
          "prune_backups",
          {
            destinationDir: settings.backupDestinationDir,
            environment: storageInfo.environment,
          },
        );
        if (prune.failed.length > 0) {
          logDebug("error", "storage.backup", "Retention des backups partielle", prune);
        } else {
          logDebug("info", "storage.backup", "Retention des backups appliquee", prune);
        }
      } catch (error) {
        logDebug(
          "error",
          "storage.backup",
          "Retention des backups echouee",
          formatUnknownError(error),
        );
      }

      return {
        backupPath,
        createdAt,
      };
    });
  }

  async importGoogleTasksExport(rawJson: unknown): Promise<GtdImportSummary> {
    const payload = buildGoogleTasksImport(rawJson);

    return this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);

      for (const context of payload.contexts) {
        await db.execute(
          `INSERT INTO gtd_contexts (${contextsRows.COLUMNS})
             VALUES ($1, $2, $3, $4)
             ON CONFLICT(id) DO NOTHING`,
          contextsRows.toParams(context),
        );
      }

      for (const project of payload.projects) {
        await db.execute(
          `INSERT INTO gtd_projects (${projectsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT(id) DO NOTHING`,
          projectsRows.toParams(project),
        );
      }

      for (const task of payload.tasks) {
        await this.persistTask(task, "ignore");
      }

      return payload.summary;
    });
  }

  async getGtdOverview(): Promise<{
    taskCount: number;
    projectCount: number;
    contextCount: number;
  }> {
    const db = await this.getDb();
    const [taskRows, projectRows, contextRows] = await Promise.all([
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_tasks"),
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_projects"),
      db.select<{ count: number }[]>("SELECT COUNT(*) as count FROM gtd_contexts"),
    ]);

    return {
      taskCount: Number(taskRows[0]?.count ?? 0),
      projectCount: Number(projectRows[0]?.count ?? 0),
      contextCount: Number(contextRows[0]?.count ?? 0),
    };
  }

  async moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number> {
    return this.writeExclusive(async () => {
      const tasks = await this.getAllTasks();
      const matchingTasks = tasks.filter(
        (task) =>
          task.status === "active" && task.contextIds.includes(contextId) && task.bucket !== bucket,
      );

      for (const task of matchingTasks) {
        await this.persistTask({
          ...task,
          bucket,
          updatedAt: nowIso(),
        });
      }

      return matchingTasks.length;
    });
  }

  async moveTasksWithScheduledDatesToBucket(bucket: Task["bucket"]): Promise<number> {
    return this.writeExclusive(async () => {
      const tasks = await this.getAllTasks();
      const matchingTasks = tasks.filter(
        (task) => task.status === "active" && Boolean(task.scheduledFor) && task.bucket !== bucket,
      );

      for (const task of matchingTasks) {
        await this.persistTask({
          ...task,
          bucket,
          updatedAt: nowIso(),
        });
      }

      return matchingTasks.length;
    });
  }

  async collapseGoogleRecurringTasks(rawJson: unknown): Promise<number> {
    return this.writeExclusive(async () => {
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
              (task.sourceExternalId ? sourceIds.has(task.sourceExternalId) : false)),
        );

        const previousPrimary =
          existingMatches.find((task) => task.id === desiredTask.id) ?? existingMatches[0] ?? null;
        await this.persistTask({
          ...cloneTask(desiredTask),
          notes: previousPrimary?.notes?.trim() ? previousPrimary.notes : desiredTask.notes,
          projectId: previousPrimary?.projectId ?? desiredTask.projectId,
          updatedAt: nowIso(),
        });
        changedCount += 1;

        const duplicateIds = existingMatches
          .filter((task) => task.id !== desiredTask.id)
          .map((task) => task.id);

        await this.deleteTasksByIds(duplicateIds);
      }

      return changedCount;
    });
  }

  async listContexts(): Promise<TaskContext[]> {
    const db = await this.getDb();
    const rows = await db.select<contextsRows.ContextRow[]>(
      `SELECT ${contextsRows.COLUMNS} FROM gtd_contexts ORDER BY name ASC`,
    );
    return rows.map((row) => contextsRows.fromRow(row));
  }

  async saveContext(context: TaskContext): Promise<TaskContext> {
    return this.writeExclusive(async () => {
      const db = await this.getDb();
      const timestamp = nowIso();
      const nextName = context.name.trim();

      if (!nextName) {
        throw new Error("Le nom du contexte est requis.");
      }

      const duplicateRows = await db.select<{ id: string }[]>(
        "SELECT id FROM gtd_contexts WHERE LOWER(name) = LOWER($1) AND id != $2 LIMIT 1",
        [nextName, context.id],
      );

      if (duplicateRows.length > 0) {
        throw new Error(`Le contexte "${nextName}" existe deja.`);
      }

      const previousRows = await db.select<contextsRows.ContextRow[]>(
        `SELECT ${contextsRows.COLUMNS} FROM gtd_contexts WHERE id = $1 LIMIT 1`,
        [context.id],
      );

      const previous = previousRows[0];
      const nextContext: TaskContext = {
        id: context.id,
        name: nextName,
        createdAt: previous?.created_at ?? context.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      await db.execute(
        `INSERT INTO gtd_contexts (${contextsRows.COLUMNS})
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at`,
        contextsRows.toParams(nextContext),
      );

      return nextContext;
    });
  }

  async listProjects(filters = {}): Promise<Project[]> {
    const db = await this.getDb();
    const rows = await db.select<projectsRows.ProjectRow[]>(
      `SELECT ${projectsRows.COLUMNS} FROM gtd_projects`,
    );
    return filterProjects(
      rows.map((row) => projectsRows.fromRow(row)),
      filters,
    );
  }

  async saveProject(project: Project): Promise<Project> {
    return this.writeTransaction(async (tx) => {
      const db = transactionDb(tx);

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
            : project.statusChangedAt ||
              previous?.statusChangedAt ||
              project.createdAt ||
              timestamp,
        updatedAt: timestamp,
        createdAt: project.createdAt || timestamp,
      };

      await this.ensureContextsExist(nextProject.contextIds);
      await db.execute(
        `INSERT INTO gtd_projects (${projectsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            status_changed_at = excluded.status_changed_at,
            notes = excluded.notes,
            context_ids_json = excluded.context_ids_json,
            source = excluded.source,
            source_external_id = excluded.source_external_id,
            updated_at = excluded.updated_at`,
        projectsRows.toParams(nextProject),
      );

      // A status change (e.g. resuming a paused project) can make it eligible for
      // auto-promotion; pausing/completing/cancelling it must stop future auto-promotion.
      await this.reconcileProjectsInternal(tx, [nextProject.id]);

      return nextProject;
    });
  }

  async listTasks(filters = {}): Promise<Task[]> {
    await this.generateDueRecurringTasks(getTodayDate());
    await this.promoteDueScheduledTasks(getTodayDate());
    const tasks = await this.getAllTasks();
    return filterTasks(tasks, filters);
  }

  async listTaskEvents(filters: TaskEventFilters = {}): Promise<TaskEvent[]> {
    const events = await this.getAllEvents();
    const types = filters.types;
    return types ? events.filter((event) => types.includes(event.type)) : events;
  }

  async listRecurringTaskTemplates(filters = {}) {
    const templates = await this.getAllRecurringTemplates();
    return filterRecurringTemplates(templates, filters);
  }

  async saveRecurringTaskTemplate(template: RecurringTaskTemplate): Promise<RecurringTaskTemplate> {
    return this.writeExclusive(async () => {
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
        updatedAt: timestamp,
      });

      await this.persistRecurringTemplate(nextTemplate);
      const activeTask = await this.findActiveRecurringTask(nextTemplate.id);
      if (activeTask) {
        await this.persistTask(this.syncActiveTaskWithTemplate(activeTask, nextTemplate));
      }
      return cloneRecurringTemplate(nextTemplate);
    });
  }

  async pauseRecurringTaskTemplate(id: string) {
    return this.writeExclusive(async () => {
      const template = await this.requireRecurringTemplate(id);
      const nextTemplate = syncTemplateStatusChange(template, "paused");
      await this.persistRecurringTemplate(nextTemplate);
      return cloneRecurringTemplate(nextTemplate);
    });
  }

  async resumeRecurringTaskTemplate(id: string) {
    return this.writeExclusive(async () => {
      const template = await this.requireRecurringTemplate(id);
      const nextTemplate = syncTemplateStatusChange(template, "active");
      await this.persistRecurringTemplate(nextTemplate);
      return cloneRecurringTemplate(nextTemplate);
    });
  }

  async cancelRecurringTaskTemplate(id: string) {
    return this.writeExclusive(async () => {
      const template = await this.requireRecurringTemplate(id);
      const nextTemplate = syncTemplateStatusChange(template, "cancelled");
      await this.persistRecurringTemplate(nextTemplate);
      const activeTask = await this.findActiveRecurringTask(id);
      if (activeTask) {
        await this.persistTask({
          ...cloneTask(activeTask),
          status: "cancelled",
          updatedAt: nowIso(),
        });
      }
      return cloneRecurringTemplate(nextTemplate);
    });
  }

  async generateDueRecurringTasks(date: string): Promise<number> {
    return this.writeExclusive(async () => {
      const templates = await this.getAllRecurringTemplates();
      const today = getTodayDate();
      const horizon = recurrenceGenerationHorizon(date, today);
      let changedCount = 0;

      for (const original of templates) {
        if (original.status !== "active") {
          continue;
        }

        const instance = await this.findRecurringInstance(original.id);
        const prepared = prepareRecurringGeneration(original, instance, today);
        let template = prepared.template;
        let activeTask = prepared.instance?.status === "active" ? prepared.instance : null;

        if (prepared.changed) {
          const timestamp = nowIso();
          template = {
            ...cloneRecurringTemplate(template),
            updatedAt: timestamp,
          };
          await this.persistRecurringTemplate(template);
          if (recurringInstanceWasRewound(instance, prepared.instance) && prepared.instance) {
            const previousInstance = instance ? cloneTask(instance) : null;
            const nextInstance = {
              ...cloneTask(prepared.instance),
              updatedAt: timestamp,
            };
            await this.persistTask(nextInstance);
            if (previousInstance) {
              await this.persistEvents(buildLifecycleEvents(previousInstance, nextInstance));
            }
            if (nextInstance.status === "active") {
              activeTask = nextInstance;
            }
          }
        }

        const startDate = this.findProcessingStartDate(template, activeTask);
        const dueDates = this.listDueDatesBetween(template, startDate, horizon);

        if (dueDates.length === 0) {
          continue;
        }

        const latestDueDate = dueDates[dueDates.length - 1];
        const nextPending =
          (activeTask?.pendingPastRecurrences ?? 0) + dueDates.length - 1 + (activeTask ? 1 : 0);
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
                  ? buildTaskFromRecurringTemplate(template, latestDueDate, pendingPastRecurrences)
                      .scheduledFor
                  : null,
              recurrenceDueDate: latestDueDate,
              pendingPastRecurrences,
              updatedAt: timestamp,
            }
          : buildTaskFromRecurringTemplate(
              template,
              latestDueDate,
              Math.max(0, dueDates.length - 1),
            );

        await this.persistTask(nextTask);
        await this.persistEvents(
          buildLifecycleEvents(activeTask ? cloneTask(activeTask) : null, nextTask),
        );
        await this.persistRecurringTemplate({
          ...cloneRecurringTemplate(template),
          lastGeneratedForDate: latestDueDate,
          pendingMissedOccurrences: nextTask.pendingPastRecurrences,
          updatedAt: timestamp,
        });

        changedCount += 1;
      }

      return changedCount;
    });
  }

  async promoteDueScheduledTasks(date: string): Promise<number> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      const snapshot = await this.getAllTasks();
      const updated = selectDueScheduledPromotions(snapshot, date, nowIso());
      if (updated.length === 0) {
        return 0;
      }

      const previousById = new Map(snapshot.map((task) => [task.id, task] as const));

      for (const next of updated) {
        const previous = previousById.get(next.id) ?? null;
        await this.persistTask(next);
        const localEventDate = toLocalDateString(next.updatedAt);
        await this.persistEvents(
          buildLifecycleEvents(previous, next).map((event) => ({
            ...event,
            eventDate: localEventDate,
          })),
        );
      }

      await this.reconcileProjectsInternal(
        tx,
        updated.map((task) => task.projectId),
      );

      return updated.length;
    });
  }

  async listRecurringPreviewOccurrences(rangeStart: string, rangeEnd: string) {
    const [templates, tasks] = await Promise.all([
      this.getAllRecurringTemplates(),
      this.getAllTasks(),
    ]);
    return buildRecurringPreviewOccurrences(templates, tasks, rangeStart, rangeEnd);
  }

  async applyRecurringEditScope(
    taskId: string,
    scope: RecurringEditScope,
    changes: RecurringTaskChanges,
  ) {
    const task = await this.requireTask(taskId);
    if (!task.recurringTemplateId) {
      return this.saveTask({
        ...task,
        ...changes,
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
        deadline: changes.deadline === undefined ? task.deadline : changes.deadline,
      });
    }

    const template = await this.requireRecurringTemplate(task.recurringTemplateId);
    const nextTemplate = applySeriesChangesToTemplate(template, changes);
    await this.saveRecurringTaskTemplate(nextTemplate);
    return this.saveTask(this.syncActiveTaskWithTemplate(task, nextTemplate));
  }

  async createTask(input: Parameters<AppRepository["createTask"]>[0]): Promise<Task> {
    return this.writeTransaction((tx) => this.createTaskInternal(tx, input));
  }

  /** Reuses the caller's transaction so generation checks and inserts share one writer slot. */
  private async createTaskInternal(
    tx: TxContext,
    input: Parameters<AppRepository["createTask"]>[0],
  ): Promise<Task> {
    transactionDb(tx);

    const draft = createTaskFromInput(input);
    const allTasks = await this.getAllTasks();
    const nextTask = adjustPlannedFieldsForSave(null, draft, allTasks);
    await this.assertPlannedProjectExists(tx, nextTask);

    await this.persistTask(nextTask);
    await this.persistEvents(buildLifecycleEvents(null, nextTask));
    await this.reconcileProjectsInternal(tx, [nextTask.projectId]);

    const stored = await this.getTaskById(nextTask.id);
    return cloneTask(stored ?? nextTask);
  }

  async saveTask(task: Task): Promise<Task> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      const nextTask = await this.saveTaskInternal(tx, task);

      return nextTask;
    });
  }

  /**
   * Transaction-scoped task save: validates/derives Planned invariants, persists the task,
   * emits lifecycle events, and reconciles every affected project. Callers must already hold
   * an active transaction context (via `writeTransaction`) and must not re-enter
   * the writer or open a nested transaction from here.
   */
  private async saveTaskInternal(tx: TxContext, task: Task): Promise<Task> {
    transactionDb(tx);

    const previous = await this.getTaskById(task.id);
    const allTasks = await this.getAllTasks();
    const adjusted = adjustPlannedFieldsForSave(previous, task, allTasks);
    const nextTask: Task = {
      ...cloneTask(adjusted),
      title: adjusted.title.trim(),
      notes: adjusted.notes.trim(),
      updatedAt: nowIso(),
    };
    await this.assertPlannedProjectExists(tx, nextTask);

    await this.persistTask(nextTask);
    await this.persistEvents(buildLifecycleEvents(previous, nextTask));
    await this.reconcileProjectsInternal(tx, [previous?.projectId, nextTask.projectId]);

    const stored = await this.getTaskById(nextTask.id);
    return cloneTask(stored ?? nextTask);
  }

  /**
   * A Planned task must reference a project that actually exists; a stale or unknown id
   * would silently become an orphaned, never-promoted Planned task (reconciliation no-ops
   * when `getProjectById` returns null). Must run inside the caller's open transaction.
   */
  private async assertPlannedProjectExists(tx: TxContext, task: Task): Promise<void> {
    transactionDb(tx);

    if (task.bucket !== "planned" || !task.projectId) {
      return;
    }

    const project = await this.getProjectById(task.projectId);
    if (!project) {
      throw new Error(`Le projet ${task.projectId} est introuvable`);
    }
  }

  async moveTask(
    taskId: string,
    bucket: Task["bucket"],
    contextIds: string[],
    projectId?: string | null,
  ): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      bucket,
      contextIds: [...contextIds],
      projectId: projectId ?? current.projectId,
    });
  }

  async scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task> {
    const current = await this.requireTask(taskId);

    // Reusing `scheduledFor` on an active Planned task is a planned-date display update: it
    // must never coerce the task to Scheduled.
    if (current.status === "active" && current.bucket === "planned") {
      return this.saveTask({ ...current, scheduledFor });
    }

    return this.saveTask({
      ...current,
      bucket: scheduledFor
        ? "scheduled"
        : current.bucket === "scheduled"
          ? "next_action"
          : current.bucket,
      scheduledFor,
    });
  }

  async promotePlannedTask(taskId: string): Promise<Task> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      // Re-read the task and project from the open connection rather than a snapshot
      // taken before the writer slot was acquired: another queued mutation (e.g. a
      // completion or a project pause) may have run first, and eligibility must be
      // evaluated against current DB state, not a stale read.
      const task = await this.getTaskById(taskId);
      if (!task || task.status !== "active" || task.bucket !== "planned" || !task.projectId) {
        throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
      }

      const project = await this.getProjectById(task.projectId);
      if (!project || project.status !== "active") {
        throw new Error("Le projet associe n'est pas actif");
      }

      const nextTask = await this.saveTaskInternal(tx, { ...task, bucket: "next_action" });

      return nextTask;
    });
  }

  async movePlannedTask(taskId: string, direction: "up" | "down"): Promise<Task[]> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      const task = await this.requireTask(taskId);
      if (task.status !== "active" || task.bucket !== "planned" || !task.projectId) {
        throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
      }

      const allTasks = await this.getAllTasks();
      const updates = swapPlannedOrder(allTasks, taskId, direction, nowIso());
      if (!updates) {
        throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
      }

      if (updates.length === 0) {
        return [cloneTask(task)];
      }

      for (const updated of updates) {
        await this.persistTask(updated);
      }

      const stored = await Promise.all(updates.map((updated) => this.getTaskById(updated.id)));
      return stored.map((row, index) => cloneTask(row ?? updates[index]));
    });
  }

  /**
   * Deduplicates project ids and reconciles each once; used after every task mutation.
   * The branded context enforces transaction scope; this never re-enters the writer.
   */
  private async reconcileProjectsInternal(
    tx: TxContext,
    projectIds: Array<string | null | undefined>,
  ): Promise<void> {
    transactionDb(tx);

    const uniqueIds = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    for (const projectId of uniqueIds) {
      await this.reconcileProjectNextActionInternal(tx, projectId);
    }
  }

  /**
   * Promotes at most one planned task when the project is active and has zero active next
   * actions, then compacts the remaining planned queue.
   */
  private async reconcileProjectNextActionInternal(
    tx: TxContext,
    projectId: string,
  ): Promise<void> {
    transactionDb(tx);

    const project = await this.getProjectById(projectId);
    const tasksSnapshot = await this.getAllTasks();
    const outcome = reconcileProjectPlannedTasks(tasksSnapshot, project, nowIso());

    if (outcome.updatedTasks.length === 0) {
      return;
    }

    const previousById = new Map(tasksSnapshot.map((task) => [task.id, task] as const));

    for (const updated of outcome.updatedTasks) {
      await this.persistTask(updated);

      if (updated.id === outcome.promotedTaskId) {
        const previous = previousById.get(updated.id) ?? null;
        // Auto-promotion lifecycle events must use the local calendar date, never a UTC
        // slice of the instant timestamp: near local midnight those diverge by a day.
        const localEventDate = toLocalDateString(updated.updatedAt);
        await this.persistEvents(
          buildLifecycleEvents(previous, updated).map((event) => ({
            ...event,
            eventDate: localEventDate,
          })),
        );
      }
    }
  }

  async completeTask(taskId: string, completedAt = nowIso()): Promise<Task> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      const current = await this.requireTask(taskId);
      const nextTask = await this.saveTaskInternal(tx, {
        ...current,
        status: "completed",
        completedAt,
      });

      if (current.recurringTemplateId) {
        const template = await this.requireRecurringTemplate(current.recurringTemplateId);
        const nextLastGeneratedForDate =
          current.recurrenceDueDate &&
          (!template.lastGeneratedForDate ||
            current.recurrenceDueDate > template.lastGeneratedForDate)
            ? current.recurrenceDueDate
            : template.lastGeneratedForDate;
        await this.persistRecurringTemplate({
          ...cloneRecurringTemplate(template),
          lastGeneratedForDate: nextLastGeneratedForDate,
          pendingMissedOccurrences: 0,
          updatedAt: nowIso(),
        });
      }

      return nextTask;
    });
  }

  async cancelTask(taskId: string): Promise<Task> {
    return this.writeTransaction(async (tx) => {
      transactionDb(tx);

      const current = await this.requireTask(taskId);
      const nextTask = await this.saveTaskInternal(tx, {
        ...current,
        status: "cancelled",
        completedAt: null,
      });

      if (current.recurringTemplateId) {
        const template = await this.requireRecurringTemplate(current.recurringTemplateId);
        await this.persistRecurringTemplate({
          ...cloneRecurringTemplate(template),
          pendingMissedOccurrences: 0,
          updatedAt: nowIso(),
        });
      }

      return nextTask;
    });
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = await this.requireTask(taskId);
    return this.saveTask({
      ...current,
      pendingPastRecurrences: 0,
    });
  }

  async generateDailyRelationshipTasks(date: string): Promise<number> {
    return this.writeTransaction(async (tx) => {
      const current = await this.getSettings();
      if (!current.relationshipDrawsEnabled) return 0;
      const plan = buildDailyRelationshipDrawPlan(date, current, await this.getAllTasks());
      for (const input of plan.taskInputs) await this.createTaskInternal(tx, input);
      if (plan.settings !== current) {
        await this.writeSettingsRow(transactionDb(tx), plan.settings);
      }
      return plan.taskInputs.length;
    });
  }

  async computeDailyTaskStats(date: string) {
    await this.generateDueRecurringTasks(date);
    await this.promoteDueScheduledTasks(getTodayDate());
    if (date <= getTodayDate() && isSunday(date)) {
      await this.applyWeeklyCarryover(date);
    }

    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    return buildDailyTaskStats(tasks, events, date);
  }

  async getDailyTaskBreakdown(date: string) {
    await this.generateDueRecurringTasks(date);
    await this.promoteDueScheduledTasks(getTodayDate());
    if (date <= getTodayDate() && isSunday(date)) {
      await this.applyWeeklyCarryover(date);
    }

    const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
    return buildDailyTaskBreakdown(tasks, events, date);
  }

  async applyWeeklyCarryover(weekStartDate: string): Promise<number> {
    return this.writeExclusive(async () => {
      const [tasks, events] = await Promise.all([this.getAllTasks(), this.getAllEvents()]);
      const nextEvents = buildCarryoverEvents(tasks, events, weekStartDate);
      await this.persistEvents(nextEvents);
      return nextEvents.length;
    });
  }

  async getPomodoroState() {
    const [sessions, segments] = await Promise.all([
      this.getAllPomodoroSessions(),
      this.getAllPomodoroSegments(),
    ]);
    return buildPomodoroState(sessions, segments);
  }

  async startPomodoro(options: PomodoroStartOptions = {}) {
    return this.writeExclusive(async () => {
      await this.completeExpiredPomodoroSessionsInternal();
      const state = await this.getPomodoroState();

      if (state.activeSession) {
        return state;
      }

      const startedAt = nowIso();
      const { session, segmentsToUpsert } = startSession(state, options, startedAt);

      await this.persistPomodoroSession(session);
      for (const segment of segmentsToUpsert) {
        await this.persistPomodoroSegment(segment);
      }

      return this.getPomodoroState();
    });
  }

  async stopPomodoroSession(sessionId: string, status: "completed" | "cancelled", at = nowIso()) {
    return this.writeExclusive(async () => this.stopPomodoroSessionInternal(sessionId, status, at));
  }

  /**
   * Writer-scoped stop of a Pomodoro session. Callers must already hold the writer
   * slot (via `writeExclusive`) and must not re-enter it from here.
   */
  private async stopPomodoroSessionInternal(
    sessionId: string,
    status: "completed" | "cancelled",
    at = nowIso(),
  ) {
    const session = requirePomodoroSession(await this.getPomodoroSessionById(sessionId), sessionId);

    if (session.status !== "running" && session.status !== "paused") {
      return this.getPomodoroState();
    }

    const openSegments = await this.getOpenPomodoroSegments(sessionId);
    const transition = stopSession(session, openSegments, status, at);
    await this.persistPomodoroSession(transition.session);
    for (const segment of transition.segmentsToUpsert) {
      await this.persistPomodoroSegment(segment);
    }

    return this.getPomodoroState();
  }

  async pausePomodoroSession(sessionId: string, at = nowIso()) {
    return this.writeExclusive(async () => {
      const session = requirePomodoroSession(
        await this.getPomodoroSessionById(sessionId),
        sessionId,
      );

      if (session.status !== "running") {
        return this.getPomodoroState();
      }

      const openSegments = await this.getOpenPomodoroSegments(sessionId);
      const transition = pauseSession(session, openSegments, at);
      await this.persistPomodoroSession(transition.session);
      for (const segment of transition.segmentsToUpsert) {
        await this.persistPomodoroSegment(segment);
      }

      return this.getPomodoroState();
    });
  }

  async resumePomodoroSession(sessionId: string, at = nowIso()) {
    return this.writeExclusive(async () => {
      const session = requirePomodoroSession(
        await this.getPomodoroSessionById(sessionId),
        sessionId,
      );

      if (session.status !== "paused") {
        return this.getPomodoroState();
      }

      const latestSegment =
        session.kind === "focus"
          ? (await this.getAllPomodoroSegments())
              .filter((segment) => segment.sessionId === sessionId)
              .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
              .at(-1)
          : null;
      const transition = resumeSession(session, latestSegment, at);
      await this.persistPomodoroSession(transition.session);
      for (const segment of transition.segmentsToUpsert) {
        await this.persistPomodoroSegment(segment);
      }

      return this.getPomodoroState();
    });
  }

  async completeExpiredPomodoroSessions(now = nowIso()) {
    return this.writeExclusive(async () => this.completeExpiredPomodoroSessionsInternal(now));
  }

  /**
   * Writer-scoped auto-completion of expired Pomodoro sessions. Callers must
   * already hold the writer slot (via `writeExclusive`) and must not re-enter it here.
   */
  private async completeExpiredPomodoroSessionsInternal(now = nowIso()) {
    let sessions = await this.getAllPomodoroSessions();
    const expiredRunningSessions = sessions.filter(
      (session) =>
        session.status === "running" &&
        new Date(session.endsAt).getTime() <= new Date(now).getTime(),
    );

    for (const session of expiredRunningSessions) {
      await this.stopPomodoroSessionInternal(session.id, "completed", session.endsAt);
    }

    sessions = await this.getAllPomodoroSessions();
    for (const sessionId of getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset(
      sessions,
      now,
    )) {
      await this.stopPomodoroSessionInternal(sessionId, "completed", now);
    }

    return this.getPomodoroState();
  }

  async switchPomodoroTask(
    sessionId: string,
    taskId: string | null,
    title: string | null = null,
    changedAt = nowIso(),
  ) {
    return this.writeExclusive(async () => {
      const session = requirePomodoroSession(
        await this.getPomodoroSessionById(sessionId),
        sessionId,
      );

      if (session.status !== "running" || session.kind !== "focus") {
        return this.getPomodoroState();
      }

      const openSegments = await this.getOpenPomodoroSegments(sessionId);
      const openSegment = openSegments[0] ?? null;
      const transition = switchSessionTask(session, openSegment, taskId, title, changedAt);
      if (!transition) {
        return this.getPomodoroState();
      }
      for (const segment of transition.segmentsToUpsert) {
        await this.persistPomodoroSegment(segment);
      }
      return this.getPomodoroState();
    });
  }

  async listPomodoroSessions(date: string) {
    const [sessions, segments] = await Promise.all([
      this.getAllPomodoroSessions(),
      this.getAllPomodoroSegments(),
    ]);
    return buildPomodoroSessionDetails(
      sessions.filter((session) => session.date === date),
      segments,
    );
  }

  async listPomodoroTaskSummaries(date: string, now = nowIso()) {
    const [sessions, segments, tasks] = await Promise.all([
      this.getAllPomodoroSessions(),
      this.getAllPomodoroSegments(),
      this.getAllTasks(),
    ]);

    return buildPomodoroTaskSummaries(sessions, segments, tasks, date, now);
  }

  async computeDailyPomodoroStats(date: string) {
    await this.completeExpiredPomodoroSessions();
    const sessions = await this.getAllPomodoroSessions();
    return computeDailyPomodoroStats(sessions, date);
  }

  private async getDb(): Promise<SqliteDatabase> {
    if (!this.dbPromise) {
      logDebug("info", "storage.sqlite", "Ouverture connexion SQLite", this.connectionString);
      this.dbPromise = this.openDb(this.connectionString);
    }

    return this.dbPromise;
  }

  private async decorateEntry(entry: DailyEntry): Promise<DailyEntry> {
    const [taskStats, pomodoroStats] = await Promise.all([
      this.computeDailyTaskStats(entry.date),
      this.computeDailyPomodoroStats(entry.date),
    ]);
    return applyDailyPomodoroStats(
      applyDailyTaskStats(cloneEntry(entry), taskStats),
      pomodoroStats,
    );
  }

  private async getAllTasks(): Promise<Task[]> {
    const db = await this.getDb();
    const rows = await db.select<tasksRows.TaskRow[]>(`SELECT ${tasksRows.COLUMNS} FROM gtd_tasks`);
    return rows.map((row) => tasksRows.fromRow(row));
  }

  private async getAllEvents(): Promise<TaskEvent[]> {
    const db = await this.getDb();
    // Parity with `MemoryRepository.listTaskEvents`: order chronologically by `eventAt` rather
    // than leaving callers to depend on incidental table (insertion) order.
    const rows = await db.select<taskEventsRows.TaskEventRow[]>(
      `SELECT ${taskEventsRows.COLUMNS} FROM gtd_task_events ORDER BY event_at ASC`,
    );
    return rows.map((row) => taskEventsRows.fromRow(row));
  }

  private async getAllPomodoroSessions(): Promise<PomodoroSession[]> {
    const db = await this.getDb();
    const rows = await db.select<pomodoroSessionsRows.PomodoroSessionRow[]>(
      `SELECT ${pomodoroSessionsRows.COLUMNS} FROM pomodoro_sessions`,
    );
    return rows.map((row) => pomodoroSessionsRows.fromRow(row));
  }

  private async getAllPomodoroSegments(): Promise<PomodoroSegment[]> {
    const db = await this.getDb();
    const rows = await db.select<pomodoroSegmentsRows.PomodoroSegmentRow[]>(
      `SELECT ${pomodoroSegmentsRows.COLUMNS} FROM pomodoro_segments`,
    );
    return rows.map((row) => pomodoroSegmentsRows.fromRow(row));
  }

  private async getAllRecurringTemplates(): Promise<RecurringTaskTemplate[]> {
    const db = await this.getDb();
    const rows = await db.select<recurringTemplatesRows.RecurringTemplateRow[]>(
      `SELECT ${recurringTemplatesRows.COLUMNS} FROM recurring_task_templates`,
    );

    return rows.map((row) => recurringTemplatesRows.fromRow(row));
  }

  private async getTaskById(taskId: string): Promise<Task | null> {
    const db = await this.getDb();
    const rows = await db.select<tasksRows.TaskRow[]>(
      `SELECT ${tasksRows.COLUMNS} FROM gtd_tasks
      WHERE id = $1`,
      [taskId],
    );

    return rows[0] ? tasksRows.fromRow(rows[0]) : null;
  }

  private async getProjectById(projectId: string): Promise<Project | null> {
    const db = await this.getDb();
    const rows = await db.select<projectsRows.ProjectRow[]>(
      `SELECT ${projectsRows.COLUMNS} FROM gtd_projects
      WHERE id = $1`,
      [projectId],
    );

    return rows[0] ? projectsRows.fromRow(rows[0]) : null;
  }

  private async getRecurringTemplateById(
    templateId: string,
  ): Promise<RecurringTaskTemplate | null> {
    const db = await this.getDb();
    const rows = await db.select<recurringTemplatesRows.RecurringTemplateRow[]>(
      `SELECT ${recurringTemplatesRows.COLUMNS} FROM recurring_task_templates
      WHERE id = $1`,
      [templateId],
    );

    return rows[0] ? recurringTemplatesRows.fromRow(rows[0]) : null;
  }

  private async getPomodoroSessionById(sessionId: string): Promise<PomodoroSession | null> {
    const db = await this.getDb();
    const rows = await db.select<pomodoroSessionsRows.PomodoroSessionRow[]>(
      `SELECT ${pomodoroSessionsRows.COLUMNS} FROM pomodoro_sessions
      WHERE id = $1`,
      [sessionId],
    );

    return rows[0] ? pomodoroSessionsRows.fromRow(rows[0]) : null;
  }

  private async getOpenPomodoroSegments(sessionId: string): Promise<PomodoroSegment[]> {
    const db = await this.getDb();
    const rows = await db.select<pomodoroSegmentsRows.PomodoroSegmentRow[]>(
      `SELECT ${pomodoroSegmentsRows.COLUMNS} FROM pomodoro_segments
      WHERE session_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC`,
      [sessionId],
    );

    return rows.map((row) => pomodoroSegmentsRows.fromRow(row));
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

  private async findRecurringInstance(templateId: string): Promise<Task | null> {
    const task = await this.getTaskById(`recurring-task:${templateId}`);
    if (!task?.isRecurringInstance || task.recurringTemplateId !== templateId) {
      return null;
    }

    return task;
  }

  private async findActiveRecurringTask(templateId: string): Promise<Task | null> {
    const tasks = await this.getAllTasks();
    return (
      tasks.find(
        (candidate) =>
          candidate.recurringTemplateId === templateId &&
          candidate.isRecurringInstance &&
          candidate.status === "active",
      ) ?? null
    );
  }

  private findProcessingStartDate(
    template: RecurringTaskTemplate,
    activeTask: Task | null,
  ): string {
    const candidates = [template.startDate];

    if (template.lastGeneratedForDate) {
      candidates.push(addDays(template.lastGeneratedForDate, 1));
    }

    if (activeTask?.recurrenceDueDate) {
      candidates.push(addDays(activeTask.recurrenceDueDate, 1));
    }

    const sorted = [...candidates].sort();
    return sorted.length > 0 ? sorted[sorted.length - 1] : template.startDate;
  }

  private listDueDatesBetween(
    template: RecurringTaskTemplate,
    rangeStart: string,
    rangeEnd: string,
  ): string[] {
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
          ? buildTaskFromRecurringTemplate(
              template,
              task.recurrenceDueDate,
              task.pendingPastRecurrences,
            ).scheduledFor
          : null,
      updatedAt: nowIso(),
    };
  }

  private async persistTask(task: Task, conflict: "update" | "ignore" = "update"): Promise<void> {
    const db = await this.getDb();
    if (conflict === "update") await this.ensureContextsExist(task.contextIds);
    await db.execute(tasksRows.insertSql(conflict), tasksRows.toParams(task));
  }

  private async persistRecurringTemplate(template: RecurringTaskTemplate): Promise<void> {
    const db = await this.getDb();
    await this.ensureContextsExist(template.contextIds);
    await db.execute(
      `INSERT INTO recurring_task_templates (${recurringTemplatesRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
      recurringTemplatesRows.toParams(template),
    );
  }

  private async persistPomodoroSession(session: PomodoroSession): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO pomodoro_sessions (${pomodoroSessionsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        started_at = excluded.started_at,
        ends_at = excluded.ends_at,
        paused_remaining_ms = excluded.paused_remaining_ms,
        completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at,
        cycle_index = excluded.cycle_index,
        date = excluded.date`,
      pomodoroSessionsRows.toParams(session),
    );
  }

  private async persistPomodoroSegment(segment: PomodoroSegment): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO pomodoro_segments (${pomodoroSegmentsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        title = excluded.title,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at`,
      pomodoroSegmentsRows.toParams(segment),
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
          `INSERT INTO gtd_task_events (${taskEventsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT(dedupe_key) DO NOTHING`,
          taskEventsRows.toParams(event),
        );
        continue;
      }

      await db.execute(
        `INSERT OR IGNORE INTO gtd_task_events (${taskEventsRows.COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        taskEventsRows.toParams(event),
      );
    }
  }

  private async ensureContextsExist(contextIds: string[]): Promise<void> {
    const db = await this.getDb();

    for (const contextId of contextIds) {
      const name = contextId.startsWith("context:")
        ? contextId.slice("context:".length).replace(/-/g, " ")
        : contextId;
      const timestamp = nowIso();
      await db.execute(
        `INSERT INTO gtd_contexts (${contextsRows.COLUMNS})
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(id) DO NOTHING`,
        [contextId, name, timestamp, timestamp],
      );
    }
  }

  // --- Finance (Phase 2) ---------------------------------------------------------------

  async listFinancePeople() {
    return this.getFinanceStore().listPeople();
  }

  async saveFinancePerson(person: import("../../domain/finance").FinancePerson) {
    return this.writeExclusive(() => this.getFinanceStore().savePerson(person));
  }

  async listFinanceAccounts(filters?: import("../../domain/finance").FinanceAccountFilters) {
    return this.getFinanceStore().listAccounts(filters);
  }

  async saveFinanceAccount(account: import("../../domain/finance").FinanceAccount) {
    return this.writeExclusive(() => this.getFinanceStore().saveAccount(account));
  }

  async closeFinanceAccount(id: string) {
    return this.writeExclusive(() => this.getFinanceStore().closeAccount(id));
  }

  async listFinanceCategories(includeArchived?: boolean) {
    return this.getFinanceStore().listCategories(includeArchived);
  }

  async saveFinanceCategory(category: import("../../domain/finance").FinanceCategory) {
    return this.writeExclusive(() => this.getFinanceStore().saveCategory(category));
  }

  async archiveFinanceCategory(id: string, reassignToId: string) {
    return this.writeExclusive(() => this.getFinanceStore().archiveCategory(id, reassignToId));
  }

  async seedFinanceDefaultCategories() {
    return this.writeExclusive(() => this.getFinanceStore().seedDefaultCategories());
  }

  async listFinanceRules() {
    return this.getFinanceStore().listRules();
  }

  async saveFinanceRule(rule: import("../../domain/finance").FinanceRule) {
    return this.writeExclusive(() => this.getFinanceStore().saveRule(rule));
  }

  async deleteFinanceRule(id: string) {
    return this.writeExclusive(() => this.getFinanceStore().deleteRule(id));
  }

  async listFinanceMerchantMemory(
    filters?: import("../../domain/finance").FinanceMerchantMemoryFilters,
  ) {
    return this.getFinanceStore().listMerchantMemory(filters);
  }

  async upsertFinanceMerchantMemory(
    entry: import("../../domain/finance").FinanceMerchantMemoryEntry,
  ) {
    return this.writeExclusive(() => this.getFinanceStore().upsertMerchantMemory(entry));
  }

  async forgetFinanceMerchantMemory(merchantKey: string, accountId: string, sign: -1 | 0 | 1) {
    return this.writeExclusive(() =>
      this.getFinanceStore().forgetMerchantMemory(merchantKey, accountId, sign),
    );
  }

  async listFinanceTransactions(
    filters?: import("../../domain/finance").FinanceTransactionFilters,
  ) {
    return this.getFinanceStore().listTransactions(filters);
  }

  async countFinanceTransactions(
    filters?: import("../../domain/finance").FinanceTransactionFilters,
  ) {
    return this.getFinanceStore().countTransactions(filters);
  }

  async getFinanceTransaction(id: string) {
    return this.getFinanceStore().getTransaction(id);
  }

  async saveFinanceTransaction(txn: import("../../domain/finance").FinanceTransaction) {
    return this.writeExclusive(() => this.getFinanceStore().saveTransaction(txn));
  }

  async setFinanceTransactionCategory(
    input: import("../../domain/finance").SetFinanceTransactionCategoryInput,
  ) {
    return this.writeExclusive(() => this.getFinanceStore().setTransactionCategory(input));
  }

  async bulkUpdateFinanceTransactions(
    ids: string[],
    patch: import("../../domain/finance").BulkUpdateFinanceTransactionsPatch,
  ) {
    return this.writeExclusive(() => this.getFinanceStore().bulkUpdateTransactions(ids, patch));
  }

  async saveFinanceTransactionSplits(
    transactionId: string,
    splits: import("../../domain/finance").FinanceTransactionSplit[],
  ) {
    return this.writeExclusive(() =>
      this.getFinanceStore().saveTransactionSplits(transactionId, splits),
    );
  }

  async listFinanceTransactionSplits(transactionId: string) {
    return this.getFinanceStore().listTransactionSplits(transactionId);
  }

  async setFinanceTransfer(
    pair: import("../../domain/finance").SetFinanceTransferPair | null,
    groupId?: string,
  ) {
    return this.writeExclusive(() => this.getFinanceStore().setTransfer(pair, groupId));
  }

  async clearFinanceTransfer(transactionId: string) {
    return this.writeExclusive(() => this.getFinanceStore().clearTransfer(transactionId));
  }

  async listFinanceImportProfiles() {
    return this.getFinanceStore().listImportProfiles();
  }

  async saveFinanceImportProfile(profile: import("../../domain/finance").FinanceImportProfile) {
    return this.writeExclusive(() => this.getFinanceStore().saveImportProfile(profile));
  }

  async findFinanceImportProfileBySignature(signature: string) {
    return this.getFinanceStore().findImportProfileBySignature(signature);
  }

  async importFinanceTransactions(input: import("../../domain/finance").FinanceImportRequest) {
    return this.writeExclusive(() => this.getFinanceStore().importTransactions(input));
  }

  async listFinanceImportBatches(limit?: number) {
    return this.getFinanceStore().listImportBatches(limit);
  }

  async undoFinanceImportBatch(batchId: string) {
    return this.writeExclusive(() => this.getFinanceStore().undoImportBatch(batchId));
  }

  async listFinanceCategorySuggestions(
    status?: import("../../domain/finance").FinanceCategorySuggestion["status"],
    limit?: number,
  ) {
    return this.getFinanceStore().listCategorySuggestions(status, limit);
  }

  async saveFinanceCategorySuggestions(
    suggestions: import("../../domain/finance").FinanceCategorySuggestion[],
  ) {
    return this.writeExclusive(() => this.getFinanceStore().saveCategorySuggestions(suggestions));
  }

  async decideFinanceCategorySuggestion(
    id: string,
    decision: import("../../domain/finance").DecideFinanceCategorySuggestionInput,
  ) {
    return this.writeExclusive(() => this.getFinanceStore().decideCategorySuggestion(id, decision));
  }
}
