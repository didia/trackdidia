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
import type {
  ApplyFinanceCategorizationResultsInput,
  ApplyFinanceCategorizationResultsOutcome,
  BulkUpdateFinanceTransactionsPatch,
  DecideFinanceCategorySuggestionInput,
  FinanceAccount,
  FinanceAccountFilters,
  FinanceBudgetEntry,
  FinanceBudgetMonth,
  FinanceCategory,
  FinanceCategoryBackfillEntry,
  FinanceCategorySuggestion,
  FinanceAccountBalanceSnapshot,
  FinanceImportBatch,
  FinanceImportProfile,
  FinanceImportRequest,
  FinanceImportSummary,
  FinanceMerchantMemoryEntry,
  FinanceMerchantMemoryFilters,
  FinanceOverspendPolicy,
  FinancePerson,
  FinanceRecurringSeries,
  FinanceRule,
  FinanceTransaction,
  FinanceTransactionFilters,
  FinanceTransactionSplit,
  FinanceUnknownMerchantGroup,
  ReclassifyFinancePendingResult,
  SetFinanceTransactionCategoryInput,
  SetFinanceTransactionCategoryResult,
  SetFinanceTransferPair,
  UndoFinanceImportBatchResult,
} from "../../domain/finance";
import type { CoverOverspendingResult, FinanceBudgetState } from "../../domain/finance/budget";
import type { FinanceCashFlowSummary } from "../../domain/finance/cash-flow";
import type {
  FinanceNetWorthHistoryPoint,
  FinanceNetWorthSnapshot,
} from "../../domain/finance/net-worth";
import type {
  FinanceCategorySpendRow,
  FinanceDateRange,
  FinanceMerchantSpendRow,
  FinanceMonthOverMonthRow,
  FinancePersonSpendRow,
  FinanceReportGroupBy,
  FinanceReportLine,
  FinanceTrendGranularity,
  FinanceTrendPoint,
} from "../../domain/finance/reports";
import type { FinanceAlert, FinanceForecast, FinanceSnapshot } from "../../domain/finance/forecast";

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
  /**
   * Atomically merges `candidate` into `settings.aiPastorCustomVerses` ("Ajouter à ma liste"):
   * reads the settings row and writes the merged result as a single serialized operation, so a
   * concurrent `saveSettings` call for an unrelated field (pulse/backup metadata) cannot lose
   * this addition, and this addition cannot lose that concurrent write. Scoped to this one field
   * rather than a generic settings patch — see docs/ai-settings-and-privacy.md. `added` is
   * `false` when the reference already exists in the merged catalog (no-op, current settings
   * returned unchanged).
   */
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
  acceptAiMemoryProposal(
    proposal: AiProposal,
    memory: AiMemory,
  ): Promise<{ memory: AiMemory; proposal: AiProposal }>;
  acceptAiWeeklyObjectiveProposal(
    proposal: AiProposal,
    objective: WeeklyObjective,
  ): Promise<{ objective: WeeklyObjective; proposal: AiProposal }>;
  acceptAiReviewSectionDraftProposal(
    proposal: AiProposal,
    review: WeeklyReview,
  ): Promise<{ review: WeeklyReview; proposal: AiProposal }>;
  acceptAiMonthlyReviewSectionDraftProposal(
    proposal: AiProposal,
    review: MonthlyReview,
  ): Promise<{ review: MonthlyReview; proposal: AiProposal }>;
  acceptAiGtdActionProposal(
    proposal: AiProposal,
    scheduledDate: string,
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
  getEmailTriageGlobalSettings(): Promise<
    import("../../domain/email-triage").EmailTriageGlobalSettings
  >;
  saveEmailTriageGlobalSettings(
    settings: import("../../domain/email-triage").EmailTriageGlobalSettings,
  ): Promise<void>;
  listEmailTriageAccounts(): Promise<import("../../domain/email-triage").EmailTriageAccount[]>;
  getEmailTriageAccount(
    accountId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageAccount | null>;
  saveEmailTriageAccount(
    account: import("../../domain/email-triage").EmailTriageAccount,
  ): Promise<import("../../domain/email-triage").EmailTriageAccount>;
  deleteEmailTriageAccount(accountId: string): Promise<void>;
  listEmailTriageReviews(
    status?: import("../../domain/email-triage").EmailTriageReview["status"],
  ): Promise<import("../../domain/email-triage").EmailTriageReview[]>;
  resolveEmailTriageReview(input: {
    reviewId: string;
    expectedDecisionVersion: number;
    resolution: import("../../domain/email-triage").EmailTriageReview["resolution"];
    ignoreReason?: string | null;
  }): Promise<import("../../domain/email-triage").EmailTriageReview>;
  listEmailTriageEvaluations(
    limit?: number,
  ): Promise<import("../../domain/email-triage").EmailTriageEvaluation[]>;
  saveEmailTriageEvaluation(
    evaluation: import("../../domain/email-triage").EmailTriageEvaluation,
  ): Promise<import("../../domain/email-triage").EmailTriageEvaluation>;
  getLatestMatchingEmailTriageEvaluation(
    settings: import("../../domain/email-triage").EmailTriageGlobalSettings,
  ): Promise<import("../../domain/email-triage").EmailTriageEvaluation | null>;
  dismissEmailTriageReview(
    reviewId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageReview>;
  listEmailTriageAuditEvents(
    accountId?: string,
    limit?: number,
  ): Promise<import("../../domain/email-triage").EmailTriageAuditEvent[]>;
  recoverEmailTriageStaleEffects(): Promise<number>;
  emailTriageUpsertConversation(
    accountId: string,
    conversationKey: string,
    patch: Partial<import("../../domain/email-triage").EmailTriageConversation>,
  ): Promise<import("../../domain/email-triage").EmailTriageConversation>;
  emailTriageGetConversationByKey(
    accountId: string,
    conversationKey: string,
  ): Promise<import("../../domain/email-triage").EmailTriageConversation | null>;
  emailTriageUpdateAccountSyncState(
    accountId: string,
    syncState: Record<string, unknown>,
    patch?: Partial<import("../../domain/email-triage").EmailTriageAccount>,
  ): Promise<import("../../domain/email-triage").EmailTriageAccount>;
  emailTriagePersistMessageBatch(
    input: import("../email-triage/sync-engine").PersistMessageBatchInput,
  ): Promise<import("../email-triage/sync-engine").PersistMessageBatchResult>;
  emailTriageGetMessageByProviderId(
    accountId: string,
    providerMessageId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageMessage | null>;
  emailTriageGetConversation(
    conversationId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageConversation | null>;
  emailTriageDismissPendingReviews(conversationId: string): Promise<void>;
  emailTriageListPendingEffects(
    conversationId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageDesiredEffect[]>;
  emailTriageListPendingEffectsForAccount(
    accountId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageDesiredEffect[]>;
  emailTriageSaveDesiredEffect(
    effect: import("../../domain/email-triage").EmailTriageDesiredEffect,
  ): Promise<import("../../domain/email-triage").EmailTriageDesiredEffect>;
  emailTriageGetTaskByExternalId(externalId: string): Promise<Task | null>;
  emailTriageApplyGtdUpdate(
    input: import("../email-triage/sync-engine").ApplyGtdUpdateInput,
  ): Promise<Task | null>;
  emailTriageCreateReview(
    input: import("../email-triage/sync-engine").CreateReviewInput,
  ): Promise<import("../../domain/email-triage").EmailTriageReview>;
  listEmailTriageMessages(
    accountId: string,
    limit?: number,
  ): Promise<import("../../domain/email-triage").EmailTriageMessage[]>;
  listEmailTriageClassificationAttempts(
    messageId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageClassificationAttempt[]>;
  emailTriageFindConversationKeyByMessageId(
    accountId: string,
    messageIdHeader: string,
  ): Promise<string | null>;
  emailTriageSaveAlias(
    accountId: string,
    conversationKey: string,
    messageIdHeader: string,
  ): Promise<void>;

  // --- Finance (Phase 2 — Schema and repository parity) ---------------------------------

  listFinancePeople(): Promise<FinancePerson[]>;
  saveFinancePerson(person: FinancePerson): Promise<FinancePerson>;
  listFinanceAccounts(filters?: FinanceAccountFilters): Promise<FinanceAccount[]>;
  saveFinanceAccount(account: FinanceAccount): Promise<FinanceAccount>;
  closeFinanceAccount(id: string): Promise<FinanceAccount>;
  listFinanceCategories(includeArchived?: boolean): Promise<FinanceCategory[]>;
  saveFinanceCategory(category: FinanceCategory): Promise<FinanceCategory>;
  archiveFinanceCategory(id: string, reassignToId: string): Promise<number>;
  /** Idempotent (fixed ids, `INSERT OR IGNORE`) seed of the default French taxonomy. */
  seedFinanceDefaultCategories(): Promise<number>;
  listFinanceRules(): Promise<FinanceRule[]>;
  saveFinanceRule(rule: FinanceRule): Promise<FinanceRule>;
  deleteFinanceRule(id: string): Promise<void>;
  listFinanceMerchantMemory(
    filters?: FinanceMerchantMemoryFilters,
  ): Promise<FinanceMerchantMemoryEntry[]>;
  upsertFinanceMerchantMemory(
    entry: FinanceMerchantMemoryEntry,
  ): Promise<FinanceMerchantMemoryEntry>;
  forgetFinanceMerchantMemory(
    merchantKey: string,
    accountId: string,
    sign: -1 | 0 | 1,
  ): Promise<void>;
  listFinanceTransactions(filters?: FinanceTransactionFilters): Promise<FinanceTransaction[]>;
  countFinanceTransactions(filters?: FinanceTransactionFilters): Promise<number>;
  getFinanceTransaction(id: string): Promise<FinanceTransaction | null>;
  saveFinanceTransaction(txn: FinanceTransaction): Promise<FinanceTransaction>;
  /** The single learning entry point — see specs/done/finance.md "Learning from corrections". */
  setFinanceTransactionCategory(
    input: SetFinanceTransactionCategoryInput,
  ): Promise<SetFinanceTransactionCategoryResult>;
  bulkUpdateFinanceTransactions(
    ids: string[],
    patch: BulkUpdateFinanceTransactionsPatch,
  ): Promise<number>;
  saveFinanceTransactionSplits(
    transactionId: string,
    splits: FinanceTransactionSplit[],
  ): Promise<FinanceTransaction>;
  listFinanceTransactionSplits(transactionId: string): Promise<FinanceTransactionSplit[]>;
  setFinanceTransfer(pair: SetFinanceTransferPair | null, groupId?: string): Promise<void>;
  clearFinanceTransfer(transactionId: string): Promise<void>;
  listFinanceImportProfiles(): Promise<FinanceImportProfile[]>;
  saveFinanceImportProfile(profile: FinanceImportProfile): Promise<FinanceImportProfile>;
  findFinanceImportProfileBySignature(signature: string): Promise<FinanceImportProfile | null>;
  /**
   * One `runExclusive` block / one `BEGIN IMMEDIATE`: chunked multi-row inserts, exact-hash
   * dedupe, near-duplicate detection, and transfer detection across the whole history. See
   * specs/done/finance.md "Write-path discipline".
   */
  importFinanceTransactions(input: FinanceImportRequest): Promise<FinanceImportSummary>;
  listFinanceImportBatches(limit?: number): Promise<FinanceImportBatch[]>;
  /** Restricted to the most recent batch for the batch's account; never touches `user`-set rows. */
  undoFinanceImportBatch(batchId: string): Promise<UndoFinanceImportBatchResult>;
  listFinanceCategorySuggestions(
    status?: FinanceCategorySuggestion["status"],
    limit?: number,
  ): Promise<FinanceCategorySuggestion[]>;
  saveFinanceCategorySuggestions(
    suggestions: FinanceCategorySuggestion[],
  ): Promise<FinanceCategorySuggestion[]>;
  decideFinanceCategorySuggestion(
    id: string,
    decision: DecideFinanceCategorySuggestionInput,
  ): Promise<FinanceCategorySuggestion>;

  // --- Finance (Phase 4 — Classification: rules, memory, seeds, review queue) -----------

  /**
   * Re-runs `classifyTransaction` (rules, memory, seeds — no AI, no transfer
   * re-detection) over every non-`user` transaction. Used after a rule is
   * created/edited ("Réappliquer les règles") and by `/finances/review`.
   */
  reclassifyFinancePending(): Promise<ReclassifyFinancePendingResult>;
  /** Reverts the `backfill` entries from a `scope: "all_matching"` call — a single undo. */
  revertFinanceCategoryBackfill(entries: FinanceCategoryBackfillEntry[]): Promise<number>;

  // --- Finance (Phase 5 — Budget) --------------------------------------------------------

  /** The advisory `finance_budget_months` row (`closed_at`, `ready_to_assign_note`); never persisted until written. */
  getFinanceBudgetMonth(monthKey: string): Promise<FinanceBudgetMonth>;
  /**
   * Idempotent upsert; assigning `0` deletes the row (see
   * `src/domain/finance/budget.ts`'s "Non budgété" doc comment). Rejects
   * `kind = "income"` categories via `assertFinanceCategoryAssignable`.
   */
  setFinanceBudgetAssignment(
    monthKey: string,
    categoryId: string,
    assignedMinor: number,
  ): Promise<FinanceBudgetEntry | null>;
  /** Writes the policy on `(monthKey, categoryId)` and every later existing entry for that category. */
  setFinanceCategoryOverspendPolicy(
    monthKey: string,
    categoryId: string,
    policy: FinanceOverspendPolicy,
  ): Promise<void>;
  /** Envelope grid + Ready to Assign for `monthKey`, built by `computeFinanceBudgetState` — never materialized. */
  computeFinanceBudgetState(monthKey: string): Promise<FinanceBudgetState>;
  /**
   * "Cover overspending from another category" quick action: delegates to the pure
   * `computeCoverOverspending`. Returns the amount actually movable (capped at the
   * deficit and the source's available) and both categories' new assignment totals;
   * the caller still writes them via two `setFinanceBudgetAssignment` calls.
   */
  computeFinanceCoverOverspending(
    monthKey: string,
    fromCategoryId: string,
    toCategoryId: string,
  ): Promise<CoverOverspendingResult>;
  /** Advisory freeze/unfreeze of a month's budget inputs; changes no arithmetic. */
  setFinanceBudgetMonthClosed(monthKey: string, closed: boolean): Promise<FinanceBudgetMonth>;
  setFinanceBudgetReadyToAssignNote(
    monthKey: string,
    note: string | null,
  ): Promise<FinanceBudgetMonth>;

  // --- Finance (Phase 6 — Tracking, reports, recurring, net worth) ----------------------

  /** Assets/liabilities split by account type, as of `asOfDate`. Off-budget accounts included. */
  computeFinanceNetWorth(asOfDate: string): Promise<FinanceNetWorthSnapshot>;
  /** Net-worth-over-time series built from `finance_account_balance_snapshots`. */
  listFinanceNetWorthHistory(): Promise<FinanceNetWorthHistoryPoint[]>;
  /** Income/expense/net for one month; transfers and `excludedFromReports` rows excluded. */
  computeFinanceCashFlow(monthKey: string): Promise<FinanceCashFlowSummary>;
  computeFinanceCategorySpend(
    range: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
  ): Promise<FinanceCategorySpendRow[]>;
  /** The exact lines summing to one `FinanceCategorySpendRow.totalMinor` — the drill-down input. */
  listFinanceCategorySpendDrilldown(
    range: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
    key: string,
  ): Promise<FinanceReportLine[]>;
  computeFinanceMerchantSpend(
    range: FinanceDateRange,
    limit: number,
  ): Promise<FinanceMerchantSpendRow[]>;
  computeFinancePersonSpend(range: FinanceDateRange): Promise<FinancePersonSpendRow[]>;
  computeFinanceTrend(
    range: FinanceDateRange,
    granularity: FinanceTrendGranularity,
  ): Promise<FinanceTrendPoint[]>;
  computeFinanceMonthOverMonth(
    currentRange: FinanceDateRange,
    previousRange: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
  ): Promise<FinanceMonthOverMonthRow[]>;
  listFinanceRecurringSeries(
    status?: FinanceRecurringSeries["status"],
  ): Promise<FinanceRecurringSeries[]>;
  saveFinanceRecurringSeries(series: FinanceRecurringSeries): Promise<FinanceRecurringSeries>;
  /** Re-runs detection over the full history; preserves `confirmedByUser` series. Also run after import. */
  detectFinanceRecurringSeries(): Promise<{ created: number; updated: number }>;
  /** Idempotent per day: derives and upserts one balance snapshot per account for `asOfDate`. */
  snapshotFinanceAccountBalances(asOfDate: string): Promise<number>;
  listFinanceAccountBalanceSnapshots(accountId: string): Promise<FinanceAccountBalanceSnapshot[]>;

  // --- Finance (Phase 7 — Forecasting and proactive alerts) -----------------------------

  /** The forecast/alert input bundle for `computeFinanceForecast`; see `src/domain/finance/forecast.ts`. */
  buildFinanceSnapshot(asOfDate: string): Promise<FinanceSnapshot>;
  /** Loads the snapshot and calls the pure `computeFinanceForecast` + `buildFinanceAlerts`. */
  computeFinanceForecast(
    asOfDate: string,
  ): Promise<{ forecast: FinanceForecast; alerts: FinanceAlert[] }>;
  /** Alert keys already notified on `onDate` — the once-per-day-per-key rate limit ledger. */
  listNotifiedFinanceAlertKeys(onDate: string): Promise<string[]>;
  recordFinanceAlertNotifications(onDate: string, alertKeys: string[]): Promise<void>;

  // --- Finance (Phase 8 — AI categorization) --------------------------------------------

  /**
   * Merchant-level groups of currently unknown transactions (see
   * `FinanceUnknownMerchantGroup`), the candidate pool for the AI stage. Plain read, not
   * wrapped in a write transaction — the caller builds the AI payload from this and calls the
   * model *before* touching the database again, so the network call never happens inside a
   * `DbSerialQueue`/`BEGIN IMMEDIATE` slot.
   */
  listFinanceUnknownMerchants(limit?: number): Promise<FinanceUnknownMerchantGroup[]>;
  /**
   * Applies AI categorization results in one short exclusive block: writes a pending
   * `finance_category_suggestions` row (origin `"ai"`) for every eligible transaction sharing
   * each result's merchant key, honoring the 90-day dismissed-pair suppression, and — only when
   * `autoApply` and `confidence >= autoApplyMinConfidence` — sets the transaction's category
   * directly (`category_source = "ai"`) and marks that suggestion `"accepted"`. Never touches a
   * `category_source = "user"` row.
   */
  applyFinanceCategorizationResults(
    input: ApplyFinanceCategorizationResultsInput,
  ): Promise<ApplyFinanceCategorizationResultsOutcome>;
}
