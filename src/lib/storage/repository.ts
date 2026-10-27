import type { AcceptEffect, AiProposalAcceptResult } from "../ai/proposals/accept-effect";
import type { ReconcileDayResult } from "../gtd/reconcile";
import type { SyncApplyOptions, SyncApplyResult, SyncChangeSet } from "../sync/change-set";
import type { SyncDomain } from "../sync/registry";
import type {
  SyncIdentityResult,
  SyncPeerAppliedInput,
  SyncPublishCounters,
  SyncPublishMark,
  SyncSnapshot,
  SyncStatus,
} from "../sync/status";
import type {
  CalendarSyncDetachReason,
  CalendarSyncLink,
  CalendarSyncSettings,
} from "../../domain/calendar-sync";
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
  ApplyFinanceStatementBalanceInput,
  ApplyFinanceStatementBalanceResult,
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

export interface BackupOptions {
  /** `dev:<uuid v4>` of this device. */
  deviceId?: string;
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
  /**
   * Daily entry reads (`getDailyEntry`, `listDailyEntries*`) all return entries decorated once with
   * suggested GTD/Pomodoro metrics derived from persisted data. They never write or reconcile, so
   * callers must not re-apply `applyDailyTaskStats`/`applyDailyPomodoroStats` to them.
   */
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
    values: Record<string, { seconds: number; fetchedAt: string; mapping?: string }>;
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
  /**
   * `VACUUM INTO` a snapshot in the backup destination. With a device id the file name carries the
   * device tag and retention is counted per device (see `buildBackupFileName`); without one it is the
   * legacy name. While multi-device sync is enabled the SQLite repository uses this device's id by
   * default, so two laptops sharing one backup folder never prune each other's snapshots. An id that
   * is not a device id never blocks a backup: it falls back to the legacy name.
   */
  createBackup(kind?: "manual" | "auto", options?: BackupOptions): Promise<BackupResult>;
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
  /**
   * Explicit time-driven write entry point: generates due recurrences for `date`, promotes due
   * Scheduled tasks, applies Sunday carryover, and completes expired Pomodoro sessions. Only time
   * owners (bootstrap, local-day boundary, explicit refresh) call it; every read below is
   * side-effect free.
   */
  reconcileDay(date: string, now?: string): Promise<ReconcileDayResult>;
  /** Pure read over persisted tasks/events; does not reconcile. */
  computeDailyTaskStats(date: string): Promise<DailyTaskStats>;
  /** Pure read over persisted tasks/events; does not reconcile. */
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
   * One `writeExclusive` block / one `BEGIN IMMEDIATE`: chunked multi-row inserts, exact-hash
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
   * Idempotent upsert; assigning `0` deletes the row unless it holds a non-default policy or note (see
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
  computeFinanceBudgetState(monthKey: string, baseCurrency: string): Promise<FinanceBudgetState>;
  /**
   * "Cover overspending from another category" quick action: delegates to the pure
   * `computeCoverOverspending`. Returns the amount actually movable (capped at the
   * deficit and the source's available) and both categories' new assignment totals;
   * the caller still writes them via two `setFinanceBudgetAssignment` calls.
   */
  computeFinanceCoverOverspending(
    monthKey: string,
    baseCurrency: string,
    fromCategoryId: string,
    toCategoryId: string,
  ): Promise<CoverOverspendingResult>;
  /**
   * Atomically moves the cover amount from `fromCategoryId` to `toCategoryId` (both rows
   * written in one transaction) and returns what was moved.
   */
  applyFinanceCoverOverspending(
    monthKey: string,
    baseCurrency: string,
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
  /**
   * Newest transaction `posted_date` per account (transfers included), keyed by account id.
   * Accounts with no transactions are absent. One grouped read, not a scan per account.
   */
  listFinanceLatestTransactionDates(): Promise<Record<string, string>>;
  /**
   * Uses a statement's closing balance as the account's starting point: re-bases
   * `openingBalanceMinor` so the derived balance as of `statementDate` equals `balanceMinor`
   * (transactions posted after that date keep flowing on top) and records a `statement`-source
   * balance snapshot for that date. One transaction; `finance_transactions` is never modified.
   */
  applyFinanceStatementBalance(
    input: ApplyFinanceStatementBalanceInput,
  ): Promise<ApplyFinanceStatementBalanceResult>;

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

  // --- Calendar sync (Phase 0) -----------------------------------------------------------

  getCalendarSyncSettings(): Promise<CalendarSyncSettings>;
  /** Upsert. Bumps `generation` and clears every link when the account or calendar changes. */
  saveCalendarSyncSettings(settings: CalendarSyncSettings): Promise<CalendarSyncSettings>;
  listCalendarSyncLinks(): Promise<CalendarSyncLink[]>;
  getCalendarSyncLink(taskId: string, occurrenceKey: string): Promise<CalendarSyncLink | null>;
  saveCalendarSyncLink(link: CalendarSyncLink): Promise<CalendarSyncLink>;
  deleteCalendarSyncLink(taskId: string, occurrenceKey: string): Promise<void>;
  detachCalendarSyncLink(
    taskId: string,
    occurrenceKey: string,
    reason: CalendarSyncDetachReason,
  ): Promise<void>;
  clearCalendarSyncLinks(): Promise<void>;

  // --- Multi-device sync (foundation: identity and status only) -------------------------

  /**
   * Read-only sync state. Memory (browser preview) reports `{ supported: false }`; SQLite reports
   * the identity row (or `null` before `ensureSyncIdentity`), change counters and known peers.
   */
  getSyncStatus(): Promise<SyncStatus>;
  /**
   * Creates the single `sync_identity` row when missing. The device-id file written by the native
   * host is the authority: when the row exists with a different `deviceId` (a restored or cloned
   * database), the row is rewritten to `input.deviceId`, the clock state is kept, and the result
   * has `repaired: true`. An existing device name changes only when `input.deviceName` is non-empty
   * and different. Rejects an invalid device id. Memory rejects: sync is unavailable in browser
   * preview.
   */
  ensureSyncIdentity(input: { deviceId: string; deviceName: string }): Promise<SyncIdentityResult>;
  /**
   * Turns on change capture for this database: installs the capture triggers and stamps every
   * existing synced row that has no clock yet (and re-checks the ones that do, so edits made while
   * capture was off are not lost), all in one write transaction. Idempotent. Requires an existing
   * sync identity (`ensureSyncIdentity`) and rejects otherwise. Returns whether the trigger set was
   * (re)installed by this call and how many entities were stamped by the backfill. Memory rejects:
   * sync is unavailable in browser preview. Nothing in the app calls this yet.
   */
  enableSyncCapture(): Promise<{ installed: boolean; backfilled: number }>;
  /**
   * The full synced state of one domain (not a log): every live entity of the tables this build can
   * merge with its field clocks, tombstones, the full row sets of grow-only-union tables, and the
   * synced settings of the domain with their clocks. Read only, and consistent: it runs inside the
   * writer slot. Tables whose merge class is not implemented yet, and rows excluded by a registry
   * row filter, are never published. Requires the sync identity. Memory rejects: sync is unavailable
   * in browser preview. Nothing in the app calls this yet.
   */
  listSyncChanges(domain: SyncDomain): Promise<SyncChangeSet>;
  /**
   * Merges a peer's change set of `domain` into this database in ONE write transaction, or throws
   * and changes nothing: a malformed or oversized bundle (`SyncChangeSetError`), a domain mismatch,
   * a table this build cannot merge (`unsupported_merge_class`), a schema newer than ours, capture
   * not enabled, a unique-key collision or any SQL error (`SyncApplyError`), a bad remote clock
   * (`SyncClockError`). Idempotent and order independent for the supported classes; merge-applied
   * writes are not captured back and do not touch `change_counter` (except with `options.republish`,
   * which bumps it once, in the same transaction, when the merge changed anything). Memory rejects. Nothing in the
   * app calls this yet.
   */
  applySyncBundle(
    domain: SyncDomain,
    changeSet: SyncChangeSet,
    options?: SyncApplyOptions,
  ): Promise<SyncApplyResult>;
  /**
   * Records what the sync engine has taken from one peer, in `sync_peers` (device-local; never
   * published). The per-domain bundle hashes are MERGED into the stored map (a domain that is not
   * named keeps its hash), the manifest is replaced, `syncedAt` replaces the contact time (`null` keeps the stored one), and the row is created on first
   * contact. Call it only after the bundles it names were applied: it is what makes the next pull of
   * an unchanged manifest a no-op. Rejects an invalid peer id or an unknown domain. Memory rejects:
   * sync is unavailable in browser preview.
   */
  recordSyncPeerApplied(input: SyncPeerAppliedInput): Promise<void>;
  /**
   * Marks the changes up to `changeCounterAtRead` as published: sets `last_publish_counter` to it,
   * but only if it moves forward and does not pass `change_counter` (compare-and-set). The caller
   * reads the counter BEFORE `listSyncChanges`, so an edit made while the bundle was being written
   * has bumped `change_counter` past the value stored here and stays pending. Never moves backwards.
   * Memory rejects: sync is unavailable in browser preview.
   */
  markSyncPublished(changeCounterAtRead: number): Promise<SyncPublishMark>;
  /**
   * The COMMITTED `change_counter` and `last_publish_counter`, read in a writer slot: no other write
   * transaction is in flight, so a counter that another operation has advanced but not yet committed
   * (and may still roll back) is never observed. `null` before `ensureSyncIdentity`. This, not
   * `getSyncStatus` (a cheap read outside the queue, fine for showing "pending" in the UI), is what
   * the decision to publish and `markSyncPublished` must be based on. Memory rejects.
   */
  readSyncPublishCounters(): Promise<SyncPublishCounters | null>;
  /**
   * `listSyncChanges(domain)` together with the committed `change_counter` read in the same writer
   * slot, so the counter is exactly what the returned change set covers. A publisher records THIS
   * value as "published up to here" (and passes it to `markSyncPublished`), never a counter read
   * earlier or elsewhere. Requires the sync identity. Memory rejects.
   */
  readSyncSnapshot(domain: SyncDomain): Promise<SyncSnapshot>;
  /**
   * Makes the whole synced state pending again: bumps `change_counter` by one, durably, without
   * touching any row. The sync engine uses it when a publish that it had given up on (timed out)
   * eventually settles, because that late write may have replaced a newer snapshot in the folder:
   * the next publish then rewrites the current state. Requires the sync identity. Memory rejects:
   * sync is unavailable in browser preview.
   */
  queueSyncRepublish(): Promise<void>;
}

export type { SyncApplyOptions, SyncApplyResult, SyncChangeSet } from "../sync/change-set";
export type {
  SyncIdentity,
  SyncIdentityResult,
  SyncPeerAppliedInput,
  SyncPeerSummary,
  SyncPublishCounters,
  SyncPublishMark,
  SyncSnapshot,
  SyncStatus,
} from "../sync/status";
