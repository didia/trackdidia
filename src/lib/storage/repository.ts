import type { AcceptEffect, AiProposalAcceptResult } from "../ai/proposals/accept-effect";
import type { EmailTriageStore } from "./email-triage-store";
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
  CreateTaskInput,
  DailyEntry,
  DailyPomodoroStats,
  DailyTaskStats,
  GtdImportSummary,
  MidWeekDecisions,
  MidWeekDecisionsSaveInput,
  MonthlyReview,
  MonthlyReviewSummary,
  PomodoroKind,
  PomodoroSessionDetails,
  PomodoroState,
  PomodoroStatus,
  PomodoroTaskSummary,
  Project,
  ProjectFilters,
  RecurringEditScope,
  RecurringPreviewOccurrence,
  RecurringTaskChanges,
  RecurringTaskTemplate,
  RecurringTemplateFilters,
  RescueTimeSnapshotCacheEntry,
  RescueTimeSnapshotCacheKind,
  Task,
  TaskContext,
  TaskEvent,
  TaskEventFilters,
  TaskFilters,
  WeeklyObjective,
  WeeklyObjectiveResult,
  WeeklyReview,
  WeeklyReviewSummary,
} from "../../domain/types";

export interface NativeStoragePaths {
  databasePath: string;
  connectionString: string;
  environment: "development" | "production";
}

export interface StorageInfo extends NativeStoragePaths {
  backupDir: string;
}

export interface BackupResult {
  backupPath: string;
  createdAt: string;
}

export interface DailyTaskBreakdown {
  date: string;
  addedTasks: Task[];
  completedTasks: Task[];
}

export interface PomodoroStartOptions {
  kind?: PomodoroKind;
  taskId?: string | null;
  title?: string | null;
}

export interface AppRepository {
  initialize(): Promise<void>;
  getDailyEntry(date: string): Promise<DailyEntry | null>;
  saveDailyEntry(entry: DailyEntry): Promise<void>;
  listDailyEntries(limit?: number): Promise<DailyEntry[]>;
  listDailyEntriesOnOrBefore(endDate: string, limit?: number): Promise<DailyEntry[]>;
  listDailyEntriesInRange(startDate: string, endDate: string): Promise<DailyEntry[]>;
  getWeeklyReview(weekStartDate: string): Promise<WeeklyReview | null>;
  saveWeeklyReview(review: WeeklyReview): Promise<void>;
  listWeeklyReviews(limit?: number): Promise<WeeklyReview[]>;
  listWeeklyReviewsOverlapping(startDate: string, endDate: string): Promise<WeeklyReview[]>;
  computeWeeklyReviewSummary(weekStartDate: string): Promise<WeeklyReviewSummary>;
  listWeeklyObjectives(): Promise<WeeklyObjective[]>;
  saveWeeklyObjective(objective: WeeklyObjective): Promise<WeeklyObjective>;
  deleteWeeklyObjective(objectiveId: string): Promise<void>;
  getWeeklyObjectiveResults(weekStartDate: string): Promise<WeeklyObjectiveResult[]>;
  saveWeeklyObjectiveResult(result: WeeklyObjectiveResult): Promise<void>;
  /** Resolves `null` only when no row exists; a read failure rejects. */
  getMidWeekDecisions(weekStartDate: string): Promise<MidWeekDecisions | null>;
  /**
   * Upserts the week's decisions. An absent `laggingSnapshot` keeps the stored snapshot
   * (`COALESCE`); a first insert without one stores `null`. A snapshot can never be erased.
   */
  saveMidWeekDecisions(input: MidWeekDecisionsSaveInput): Promise<void>;
  /** Cache entry for the given week, kind and credential fingerprint, or `null` on a miss. */
  getRescueTimeSnapshotCache(
    weekStartDate: string,
    kind: RescueTimeSnapshotCacheKind,
    credentialFingerprint: string,
  ): Promise<RescueTimeSnapshotCacheEntry | null>;
  /** Upsert; `fetchedAt` is supplied by the caller. Used for the `goals` and `pulse` kinds. */
  saveRescueTimeSnapshotCache(entry: RescueTimeSnapshotCacheEntry): Promise<void>;
  /** Deletes every entry whose fingerprint differs from `keepFingerprint` (all when `null`). */
  pruneRescueTimeSnapshotCache(keepFingerprint: string | null): Promise<void>;
  /**
   * Atomically merges `values` into the `objective_seconds` entry: reads the current row, merges
   * with `mergeObjectiveSecondsPayload` and writes as one serialized step, so overlapping
   * computations cannot erase each other's ids. `fetchedAt` is the row-level write time.
   */
  mergeRescueTimeObjectiveSecondsCache(input: {
    weekStartDate: string;
    credentialFingerprint: string;
    values: Record<string, { seconds: number; fetchedAt: string }>;
    fetchedAt: string;
  }): Promise<void>;
  getMonthlyReview(monthKey: string): Promise<MonthlyReview | null>;
  saveMonthlyReview(review: MonthlyReview): Promise<void>;
  listMonthlyReviews(limit?: number): Promise<MonthlyReview[]>;
  listMonthlyReviewsOverlapping(startDate: string, endDate: string): Promise<MonthlyReview[]>;
  computeMonthlyReviewSummary(monthKey: string): Promise<MonthlyReviewSummary>;
  listAnnualGoals(): Promise<AnnualGoal[]>;
  saveAnnualGoal(goal: AnnualGoal): Promise<AnnualGoal>;
  deleteAnnualGoal(goalId: string): Promise<void>;
  computeAnnualGoalSnapshots(year: number, asOfDate?: string): Promise<AnnualGoalSnapshot[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  /** Read, apply and persist within one writer slot. The updater must be synchronous. */
  updateSettings(updater: (current: AppSettings) => AppSettings): Promise<AppSettings>;
  /** Convenience wrapper over updateSettings; duplicate references are harmless. */
  addPastorCustomVerse(candidate: CatalogVerse): Promise<{ added: boolean; settings: AppSettings }>;
  getAiMessage(surface: AiSurface, scopeKey: string, inputHash: string): Promise<AiMessage | null>;
  /** Latest row for surface/scope/hash regardless of status (e.g. weekly distill markers). */
  getAiMessageRecord(
    surface: AiSurface,
    scopeKey: string,
    inputHash: string,
  ): Promise<AiMessage | null>;
  /** Latest row for a surface+scopeKey, optionally restricted to one status. */
  getLatestAiMessage(
    surface: AiSurface,
    scopeKey: string,
    status?: AiMessage["status"],
  ): Promise<AiMessage | null>;
  saveAiMessage(message: AiMessage): Promise<AiMessage>;
  saveCoachPulseEpisode(
    message: AiMessage,
    proposals: AiProposal[],
  ): Promise<{ message: AiMessage; proposals: AiProposal[] }>;
  listAiMessages(surface?: AiSurface, limit?: number): Promise<AiMessage[]>;
  listAiMessagesForDate(date: string): Promise<AiMessage[]>;
  listAiMessagesSince(sinceIso: string, limit?: number): Promise<AiMessage[]>;
  listAiProposals(messageId: string): Promise<AiProposal[]>;
  listAiProposalsSince(sinceIso: string): Promise<AiProposal[]>;
  computeAiUsageForMonth(monthKey: string): Promise<AiUsageTotals>;
  saveAiProposal(proposal: AiProposal): Promise<AiProposal>;
  clearPendingAiProposals(messageId: string): Promise<void>;
  decideAiProposal(
    id: string,
    status: "accepted" | "dismissed",
    appliedEntityId?: string,
  ): Promise<AiProposal>;
  acceptAiProposal(
    proposalId: string,
    effect: AcceptEffect | null,
  ): Promise<AiProposalAcceptResult>;
  listAiMemories(filters?: AiMemoryFilters): Promise<AiMemory[]>;
  saveAiMemory(memory: AiMemory): Promise<AiMemory>;
  archiveAiMemory(id: string, reason: "expired" | "contradicted" | "resolved"): Promise<void>;
  getStorageInfo(): Promise<StorageInfo | null>;
  createBackup(kind?: "manual" | "auto"): Promise<BackupResult>;
  importGoogleTasksExport(rawJson: unknown): Promise<GtdImportSummary>;
  getGtdOverview(): Promise<{ taskCount: number; projectCount: number; contextCount: number }>;
  moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number>;
  moveTasksWithScheduledDatesToBucket(bucket: Task["bucket"]): Promise<number>;
  collapseGoogleRecurringTasks(rawJson: unknown): Promise<number>;
  listContexts(): Promise<TaskContext[]>;
  saveContext(context: TaskContext): Promise<TaskContext>;
  listProjects(filters?: ProjectFilters): Promise<Project[]>;
  saveProject(project: Project): Promise<Project>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  listTaskEvents(filters?: TaskEventFilters): Promise<TaskEvent[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  saveTask(task: Task): Promise<Task>;
  moveTask(
    taskId: string,
    bucket: Task["bucket"],
    contextIds: string[],
    projectId?: string | null,
  ): Promise<Task>;
  scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task>;
  completeTask(taskId: string, completedAt?: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  /** Explicit manual promotion of a single active Planned task to `next_action`. */
  promotePlannedTask(taskId: string): Promise<Task>;
  /** Swaps a Planned task with its adjacent active sibling in the same project. */
  movePlannedTask(taskId: string, direction: "up" | "down"): Promise<Task[]>;
  clearPastRecurrences(taskId: string): Promise<Task>;
  generateDailyRelationshipTasks(date: string): Promise<number>;
  computeDailyTaskStats(date: string): Promise<DailyTaskStats>;
  getDailyTaskBreakdown(date: string): Promise<DailyTaskBreakdown>;
  applyWeeklyCarryover(weekStartDate: string): Promise<number>;
  getPomodoroState(): Promise<PomodoroState>;
  startPomodoro(options?: PomodoroStartOptions): Promise<PomodoroState>;
  stopPomodoroSession(
    sessionId: string,
    status: Extract<PomodoroStatus, "completed" | "cancelled">,
    at?: string,
  ): Promise<PomodoroState>;
  pausePomodoroSession(sessionId: string, at?: string): Promise<PomodoroState>;
  resumePomodoroSession(sessionId: string, at?: string): Promise<PomodoroState>;
  completeExpiredPomodoroSessions(now?: string): Promise<PomodoroState>;
  switchPomodoroTask(
    sessionId: string,
    taskId: string | null,
    title?: string | null,
    changedAt?: string,
  ): Promise<PomodoroState>;
  listPomodoroSessions(date: string): Promise<PomodoroSessionDetails[]>;
  listPomodoroTaskSummaries(date: string, now?: string): Promise<PomodoroTaskSummary[]>;
  computeDailyPomodoroStats(date: string): Promise<DailyPomodoroStats>;
  listRecurringTaskTemplates(filters?: RecurringTemplateFilters): Promise<RecurringTaskTemplate[]>;
  saveRecurringTaskTemplate(template: RecurringTaskTemplate): Promise<RecurringTaskTemplate>;
  pauseRecurringTaskTemplate(id: string): Promise<RecurringTaskTemplate>;
  resumeRecurringTaskTemplate(id: string): Promise<RecurringTaskTemplate>;
  cancelRecurringTaskTemplate(id: string): Promise<RecurringTaskTemplate>;
  generateDueRecurringTasks(date: string, now?: string): Promise<number>;
  /** Moves due/overdue Scheduled tasks to Next Actions; returns how many were promoted. */
  promoteDueScheduledTasks(date: string): Promise<number>;
  listRecurringPreviewOccurrences(
    rangeStart: string,
    rangeEnd: string,
  ): Promise<RecurringPreviewOccurrence[]>;
  applyRecurringEditScope(
    taskId: string,
    scope: RecurringEditScope,
    changes: RecurringTaskChanges,
  ): Promise<Task>;
  readonly emailTriage: EmailTriageStore;
}
