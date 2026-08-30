import type {
  AppSettings,
  CreateTaskInput,
  DailyEntry,
  DailyPomodoroStats,
  DailyTaskStats,
  GtdImportSummary,
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
  Task,
  TaskContext,
  TaskFilters,
  MonthlyReview,
  MonthlyReviewSummary,
  AnnualGoal,
  AnnualGoalSnapshot,
  AiMemory,
  AiMemoryFilters,
  AiProposal,
  AiMessage,
  AiSurface,
  WeeklyReview,
  WeeklyReviewSummary,
  WeeklyObjective,
  WeeklyObjectiveResult
} from "../../domain/types";

export interface StorageInfo {
  databasePath: string;
  backupDir: string;
  connectionString: string;
  environment: "development" | "production";
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
  getWeeklyReview(weekStartDate: string): Promise<WeeklyReview | null>;
  saveWeeklyReview(review: WeeklyReview): Promise<void>;
  listWeeklyReviews(limit?: number): Promise<WeeklyReview[]>;
  computeWeeklyReviewSummary(weekStartDate: string): Promise<WeeklyReviewSummary>;
  listWeeklyObjectives(): Promise<WeeklyObjective[]>;
  saveWeeklyObjective(objective: WeeklyObjective): Promise<WeeklyObjective>;
  deleteWeeklyObjective(objectiveId: string): Promise<void>;
  getWeeklyObjectiveResults(weekStartDate: string): Promise<WeeklyObjectiveResult[]>;
  saveWeeklyObjectiveResult(result: WeeklyObjectiveResult): Promise<void>;
  getMonthlyReview(monthKey: string): Promise<MonthlyReview | null>;
  saveMonthlyReview(review: MonthlyReview): Promise<void>;
  listMonthlyReviews(limit?: number): Promise<MonthlyReview[]>;
  computeMonthlyReviewSummary(monthKey: string): Promise<MonthlyReviewSummary>;
  listAnnualGoals(): Promise<AnnualGoal[]>;
  saveAnnualGoal(goal: AnnualGoal): Promise<AnnualGoal>;
  deleteAnnualGoal(goalId: string): Promise<void>;
  computeAnnualGoalSnapshots(year: number): Promise<AnnualGoalSnapshot[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getAiMessage(surface: AiSurface, scopeKey: string, inputHash: string): Promise<AiMessage | null>;
  /** Latest row for surface/scope/hash regardless of status (e.g. weekly distill markers). */
  getAiMessageRecord(surface: AiSurface, scopeKey: string, inputHash: string): Promise<AiMessage | null>;
  saveAiMessage(message: AiMessage): Promise<AiMessage>;
  saveCoachPulseEpisode(message: AiMessage, proposals: AiProposal[]): Promise<{ message: AiMessage; proposals: AiProposal[] }>;
  listAiMessages(surface?: AiSurface, limit?: number): Promise<AiMessage[]>;
  listAiMessagesForDate(date: string): Promise<AiMessage[]>;
  listAiProposals(messageId: string): Promise<AiProposal[]>;
  saveAiProposal(proposal: AiProposal): Promise<AiProposal>;
  clearPendingAiProposals(messageId: string): Promise<void>;
  decideAiProposal(
    id: string,
    status: "accepted" | "dismissed",
    appliedEntityId?: string
  ): Promise<AiProposal>;
  acceptAiMemoryProposal(proposal: AiProposal, memory: AiMemory): Promise<{ memory: AiMemory; proposal: AiProposal }>;
  acceptAiWeeklyObjectiveProposal(
    proposal: AiProposal,
    objective: WeeklyObjective
  ): Promise<{ objective: WeeklyObjective; proposal: AiProposal }>;
  acceptAiReviewSectionDraftProposal(
    proposal: AiProposal,
    review: WeeklyReview
  ): Promise<{ review: WeeklyReview; proposal: AiProposal }>;
  acceptAiGtdActionProposal(
    proposal: AiProposal,
    scheduledDate: string
  ): Promise<{ taskId: string | null; proposal: AiProposal }>;
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
  createTask(input: CreateTaskInput): Promise<Task>;
  saveTask(task: Task): Promise<Task>;
  moveTask(taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null): Promise<Task>;
  scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task>;
  completeTask(taskId: string, completedAt?: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  clearPastRecurrences(taskId: string): Promise<Task>;
  generateDailyRelationshipTasks(date: string): Promise<number>;
  computeDailyTaskStats(date: string): Promise<DailyTaskStats>;
  getDailyTaskBreakdown(date: string): Promise<DailyTaskBreakdown>;
  applyWeeklyCarryover(weekStartDate: string): Promise<number>;
  getPomodoroState(): Promise<PomodoroState>;
  startPomodoro(options?: PomodoroStartOptions): Promise<PomodoroState>;
  stopPomodoroSession(sessionId: string, status: Extract<PomodoroStatus, "completed" | "cancelled">, at?: string): Promise<PomodoroState>;
  pausePomodoroSession(sessionId: string, at?: string): Promise<PomodoroState>;
  resumePomodoroSession(sessionId: string, at?: string): Promise<PomodoroState>;
  completeExpiredPomodoroSessions(now?: string): Promise<PomodoroState>;
  switchPomodoroTask(
    sessionId: string,
    taskId: string | null,
    title?: string | null,
    changedAt?: string
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
  listRecurringPreviewOccurrences(rangeStart: string, rangeEnd: string): Promise<RecurringPreviewOccurrence[]>;
  applyRecurringEditScope(taskId: string, scope: RecurringEditScope, changes: RecurringTaskChanges): Promise<Task>;
}
