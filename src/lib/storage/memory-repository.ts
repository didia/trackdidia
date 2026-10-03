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
import {
  buildAnnualGoalSnapshots,
  cloneAnnualGoal,
  createEmptyAnnualGoal,
} from "../../domain/annual-goals";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  cloneEntry,
  createEmptyDailyEntry,
} from "../../domain/daily-entry";
import { mergeObjectiveSecondsPayload } from "../../domain/rescuetime-goals";
import { journalPeriodOverlaps } from "../../domain/journal-feed";
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
  AppSettings,
  CatalogVerse,
  CreateTaskInput,
  DailyEntry,
  DailyTaskStats,
  GtdImportSummary,
  MidWeekDecisions,
  MidWeekDecisionsSaveInput,
  MonthlyReview,
  PomodoroSegment,
  PomodoroSession,
  PomodoroState,
  Project,
  ProjectFilters,
  RecurringEditScope,
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
} from "../../domain/types";
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
} from "../../domain/weekly-review";
import { monthKeyToLocalRange } from "../ai/analytics/month-range";
import { getTodayDate, isSunday } from "../date";
import { addCustomVerse } from "../pastor/custom-verse";
import {
  buildCarryoverEvents,
  buildDailyTaskBreakdown,
  buildDailyTaskStats,
  buildLifecycleEvents,
  cloneContexts,
  createTaskFromInput,
  filterProjects,
  filterTasks,
} from "../gtd/engine";
import { buildGoogleTasksImport } from "../gtd/google-tasks-import";
import {
  adjustPlannedFieldsForSave,
  reconcileProjectPlannedTasks,
  swapPlannedOrder,
} from "../gtd/planned";
import { promoteDueScheduledTasks as selectDueScheduledPromotions } from "../gtd/scheduled";
import { buildContextId, cloneProject, cloneTask, createEntityId, nowIso } from "../gtd/shared";
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
import type { AppRepository, PomodoroStartOptions, StorageInfo } from "./repository";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import { FinanceMemoryStore } from "./finance-memory-store";

export class MemoryRepository implements AppRepository {
  private entries = new Map<string, DailyEntry>();
  private weeklyReviews = new Map<string, WeeklyReview>();
  private weeklyObjectives = new Map<string, WeeklyObjective>();
  private weeklyObjectiveResults = new Map<string, WeeklyObjectiveResult>();
  private midWeekDecisions = new Map<string, MidWeekDecisions>();
  private rescueTimeSnapshotCache = new Map<string, RescueTimeSnapshotCacheEntry>();
  private monthlyReviews = new Map<string, MonthlyReview>();
  private annualGoals = new Map<string, AnnualGoal>();
  private settings: AppSettings = defaultAppSettings();
  private tasks = new Map<string, Task>();
  private projects = new Map<string, Project>();
  private contexts = new Map<string, TaskContext>();
  private events = new Map<string, TaskEvent>();
  private pomodoroSessions = new Map<string, PomodoroSession>();
  private pomodoroSegments = new Map<string, PomodoroSegment>();
  private recurringTemplates = new Map<string, RecurringTaskTemplate>();
  private aiMessages = new Map<string, AiMessage>();
  private aiProposals = new Map<string, AiProposal>();
  private aiMemories = new Map<string, AiMemory>();
  readonly emailTriage = new EmailTriageMemoryStore({
    getTaskByExternalId: (externalId) =>
      [...this.tasks.values()].find((task) => task.sourceExternalId === externalId),
    createTask: (input) => {
      const task = createTaskFromInput(input);
      this.tasks.set(task.id, task);
      for (const event of buildLifecycleEvents(null, task)) {
        this.events.set(event.id, event);
      }
      return task;
    },
    saveTask: (task) => {
      this.tasks.set(task.id, task);
      return task;
    },
    persistEvents: (events) => {
      for (const event of events) {
        this.events.set(event.id, event);
      }
    },
    getTaskById: (id) => this.tasks.get(id),
  });
  private readonly finance = new FinanceMemoryStore();

  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  // --- Finance (Phase 2) ---------------------------------------------------------------

  async listFinancePeople() {
    return Promise.resolve(this.finance.listPeople());
  }

  async saveFinancePerson(person: import("../../domain/finance").FinancePerson) {
    return Promise.resolve(this.finance.savePerson(person));
  }

  async listFinanceAccounts(filters?: import("../../domain/finance").FinanceAccountFilters) {
    return Promise.resolve(this.finance.listAccounts(filters));
  }

  async saveFinanceAccount(account: import("../../domain/finance").FinanceAccount) {
    return Promise.resolve(this.finance.saveAccount(account));
  }

  async closeFinanceAccount(id: string) {
    return Promise.resolve(this.finance.closeAccount(id));
  }

  async listFinanceCategories(includeArchived?: boolean) {
    return Promise.resolve(this.finance.listCategories(includeArchived));
  }

  async saveFinanceCategory(category: import("../../domain/finance").FinanceCategory) {
    return Promise.resolve(this.finance.saveCategory(category));
  }

  async archiveFinanceCategory(id: string, reassignToId: string) {
    return Promise.resolve(this.finance.archiveCategory(id, reassignToId));
  }

  async seedFinanceDefaultCategories() {
    return Promise.resolve(this.finance.seedDefaultCategories());
  }

  async listFinanceRules() {
    return Promise.resolve(this.finance.listRules());
  }

  async saveFinanceRule(rule: import("../../domain/finance").FinanceRule) {
    return Promise.resolve(this.finance.saveRule(rule));
  }

  async deleteFinanceRule(id: string) {
    this.finance.deleteRule(id);
    return Promise.resolve();
  }

  async listFinanceMerchantMemory(
    filters?: import("../../domain/finance").FinanceMerchantMemoryFilters,
  ) {
    return Promise.resolve(this.finance.listMerchantMemory(filters));
  }

  async upsertFinanceMerchantMemory(
    entry: import("../../domain/finance").FinanceMerchantMemoryEntry,
  ) {
    return Promise.resolve(this.finance.upsertMerchantMemory(entry));
  }

  async forgetFinanceMerchantMemory(merchantKey: string, accountId: string, sign: -1 | 0 | 1) {
    this.finance.forgetMerchantMemory(merchantKey, accountId, sign);
    return Promise.resolve();
  }

  async listFinanceTransactions(
    filters?: import("../../domain/finance").FinanceTransactionFilters,
  ) {
    return Promise.resolve(this.finance.listTransactions(filters));
  }

  async countFinanceTransactions(
    filters?: import("../../domain/finance").FinanceTransactionFilters,
  ) {
    return Promise.resolve(this.finance.countTransactions(filters));
  }

  async getFinanceTransaction(id: string) {
    return Promise.resolve(this.finance.getTransaction(id));
  }

  async saveFinanceTransaction(txn: import("../../domain/finance").FinanceTransaction) {
    return Promise.resolve(this.finance.saveTransaction(txn));
  }

  async setFinanceTransactionCategory(
    input: import("../../domain/finance").SetFinanceTransactionCategoryInput,
  ) {
    return Promise.resolve(this.finance.setTransactionCategory(input));
  }

  async bulkUpdateFinanceTransactions(
    ids: string[],
    patch: import("../../domain/finance").BulkUpdateFinanceTransactionsPatch,
  ) {
    return Promise.resolve(this.finance.bulkUpdateTransactions(ids, patch));
  }

  async saveFinanceTransactionSplits(
    transactionId: string,
    splits: import("../../domain/finance").FinanceTransactionSplit[],
  ) {
    return Promise.resolve(this.finance.saveTransactionSplits(transactionId, splits));
  }

  async listFinanceTransactionSplits(transactionId: string) {
    return Promise.resolve(this.finance.listTransactionSplits(transactionId));
  }

  async setFinanceTransfer(
    pair: import("../../domain/finance").SetFinanceTransferPair | null,
    groupId?: string,
  ) {
    this.finance.setTransfer(pair, groupId);
    return Promise.resolve();
  }

  async clearFinanceTransfer(transactionId: string) {
    this.finance.clearTransfer(transactionId);
    return Promise.resolve();
  }

  async listFinanceImportProfiles() {
    return Promise.resolve(this.finance.listImportProfiles());
  }

  async saveFinanceImportProfile(profile: import("../../domain/finance").FinanceImportProfile) {
    return Promise.resolve(this.finance.saveImportProfile(profile));
  }

  async findFinanceImportProfileBySignature(signature: string) {
    return Promise.resolve(this.finance.findImportProfileBySignature(signature));
  }

  async importFinanceTransactions(input: import("../../domain/finance").FinanceImportRequest) {
    return Promise.resolve(this.finance.importTransactions(input));
  }

  async listFinanceImportBatches(limit?: number) {
    return Promise.resolve(this.finance.listImportBatches(limit));
  }

  async undoFinanceImportBatch(batchId: string) {
    return Promise.resolve(this.finance.undoImportBatch(batchId));
  }

  async listFinanceCategorySuggestions(
    status?: import("../../domain/finance").FinanceCategorySuggestion["status"],
    limit?: number,
  ) {
    return Promise.resolve(this.finance.listCategorySuggestions(status, limit));
  }

  async saveFinanceCategorySuggestions(
    suggestions: import("../../domain/finance").FinanceCategorySuggestion[],
  ) {
    return Promise.resolve(this.finance.saveCategorySuggestions(suggestions));
  }

  async decideFinanceCategorySuggestion(
    id: string,
    decision: import("../../domain/finance").DecideFinanceCategorySuggestionInput,
  ) {
    return Promise.resolve(this.finance.decideCategorySuggestion(id, decision));
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

  async listDailyEntriesOnOrBefore(endDate: string, limit = 180): Promise<DailyEntry[]> {
    const sorted = [...this.entries.values()]
      .filter((entry) => entry.date <= endDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);

    return Promise.all(sorted.map((entry) => this.decorateEntry(entry)));
  }

  async listDailyEntriesInRange(startDate: string, endDate: string): Promise<DailyEntry[]> {
    const sorted = [...this.entries.values()]
      .filter((entry) => entry.date >= startDate && entry.date <= endDate)
      .sort((a, b) => b.date.localeCompare(a.date));

    // Journal only reads note text. Skip decorateEntry so a wide range cannot
    // fan out into per-day GTD/Pomodoro writes and full-table scans.
    return sorted.map((entry) => cloneEntry(entry));
  }

  async getWeeklyReview(weekStartDate: string): Promise<WeeklyReview | null> {
    const normalized = buildWeekDates(weekStartDate);
    const existing = this.weeklyReviews.get(normalized);
    return existing ? cloneWeeklyReview(existing) : null;
  }

  async saveWeeklyReview(review: WeeklyReview): Promise<void> {
    return this.saveWeeklyReviewInternal(review);
  }

  private saveWeeklyReviewInternal(review: WeeklyReview): void {
    const normalized = buildWeekDates(review.weekStartDate);
    const nextReview = {
      ...cloneWeeklyReview(review),
      weekStartDate: normalized,
      weekEndDate: addDays(normalized, 6),
    };
    this.weeklyReviews.set(normalized, nextReview);
  }

  async listWeeklyReviews(limit = 12): Promise<WeeklyReview[]> {
    return [...this.weeklyReviews.values()]
      .sort((left, right) => right.weekStartDate.localeCompare(left.weekStartDate))
      .slice(0, limit)
      .map((review) => cloneWeeklyReview(review));
  }

  async listWeeklyReviewsOverlapping(startDate: string, endDate: string): Promise<WeeklyReview[]> {
    return [...this.weeklyReviews.values()]
      .filter((review) =>
        journalPeriodOverlaps(review.weekStartDate, review.weekEndDate, startDate, endDate),
      )
      .sort((left, right) => right.weekStartDate.localeCompare(left.weekStartDate))
      .map((review) => cloneWeeklyReview(review));
  }

  async computeWeeklyReviewSummary(weekStartDate: string) {
    const normalized = buildWeekDates(weekStartDate);
    const entries = await Promise.all(
      listWeekDates(normalized).map(async (date) => {
        const existing = this.entries.get(date);
        return this.decorateEntry(existing ?? createEmptyDailyEntry(date));
      }),
    );

    return buildWeeklyReviewSummary(normalized, entries);
  }

  async listWeeklyObjectives(): Promise<WeeklyObjective[]> {
    return [...this.weeklyObjectives.values()]
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
      )
      .map((objective) => cloneWeeklyObjective(objective));
  }

  async saveWeeklyObjective(objective: WeeklyObjective): Promise<WeeklyObjective> {
    return this.saveWeeklyObjectiveInternal(objective);
  }

  private saveWeeklyObjectiveInternal(objective: WeeklyObjective): WeeklyObjective {
    const timestamp = nowIso();
    const nextObjective = createEmptyWeeklyObjective({
      ...cloneWeeklyObjective(objective),
      id: objective.id || createEntityId("weekly-objective"),
      title: objective.title.trim(),
      createdAt: objective.createdAt || timestamp,
      updatedAt: timestamp,
    });
    this.weeklyObjectives.set(nextObjective.id, nextObjective);
    return cloneWeeklyObjective(nextObjective);
  }

  async deleteWeeklyObjective(objectiveId: string): Promise<void> {
    this.weeklyObjectives.delete(objectiveId);
    for (const [key, result] of this.weeklyObjectiveResults) {
      if (result.objectiveId === objectiveId) {
        this.weeklyObjectiveResults.delete(key);
      }
    }
  }

  async getWeeklyObjectiveResults(weekStartDate: string): Promise<WeeklyObjectiveResult[]> {
    const normalized = buildWeekDates(weekStartDate);
    return [...this.weeklyObjectiveResults.values()]
      .filter((result) => result.weekStartDate === normalized)
      .map((result) => ({ ...result }));
  }

  async getMidWeekDecisions(weekStartDate: string): Promise<MidWeekDecisions | null> {
    const row = this.midWeekDecisions.get(buildWeekDates(weekStartDate));
    return row
      ? {
          ...row,
          laggingSnapshot: row.laggingSnapshot ? structuredClone(row.laggingSnapshot) : null,
        }
      : null;
  }

  async saveMidWeekDecisions(input: MidWeekDecisionsSaveInput): Promise<void> {
    const weekStartDate = buildWeekDates(input.weekStartDate);
    const stored = this.midWeekDecisions.get(weekStartDate);
    this.midWeekDecisions.set(weekStartDate, {
      weekStartDate,
      decisions: input.decisions,
      decidedOnDate: input.decidedOnDate,
      laggingSnapshot: input.laggingSnapshot
        ? structuredClone(input.laggingSnapshot)
        : (stored?.laggingSnapshot ?? null),
      updatedAt: input.updatedAt,
    });
  }

  private rescueTimeCacheKey(
    weekStartDate: string,
    kind: RescueTimeSnapshotCacheKind,
    credentialFingerprint: string,
  ): string {
    return `${buildWeekDates(weekStartDate)}:${kind}:${credentialFingerprint}`;
  }

  async getRescueTimeSnapshotCache(
    weekStartDate: string,
    kind: RescueTimeSnapshotCacheKind,
    credentialFingerprint: string,
  ): Promise<RescueTimeSnapshotCacheEntry | null> {
    const entry = this.rescueTimeSnapshotCache.get(
      this.rescueTimeCacheKey(weekStartDate, kind, credentialFingerprint),
    );
    return entry ? { ...entry } : null;
  }

  async saveRescueTimeSnapshotCache(entry: RescueTimeSnapshotCacheEntry): Promise<void> {
    const weekStartDate = buildWeekDates(entry.weekStartDate);
    this.rescueTimeSnapshotCache.set(
      this.rescueTimeCacheKey(weekStartDate, entry.kind, entry.credentialFingerprint),
      { ...entry, weekStartDate },
    );
  }

  async pruneRescueTimeSnapshotCache(keepFingerprint: string | null): Promise<void> {
    for (const [key, entry] of this.rescueTimeSnapshotCache) {
      if (entry.credentialFingerprint !== keepFingerprint) {
        this.rescueTimeSnapshotCache.delete(key);
      }
    }
  }

  /** Read, merge and write run synchronously (no `await`), so calls cannot interleave. */
  async mergeRescueTimeObjectiveSecondsCache(input: {
    weekStartDate: string;
    credentialFingerprint: string;
    values: Record<string, { seconds: number; fetchedAt: string }>;
    fetchedAt: string;
  }): Promise<void> {
    const weekStartDate = buildWeekDates(input.weekStartDate);
    const key = this.rescueTimeCacheKey(
      weekStartDate,
      "objective_seconds",
      input.credentialFingerprint,
    );
    const merged = mergeObjectiveSecondsPayload(
      this.rescueTimeSnapshotCache.get(key)?.payloadJson ?? null,
      input.values,
    );
    this.rescueTimeSnapshotCache.set(key, {
      weekStartDate,
      kind: "objective_seconds",
      credentialFingerprint: input.credentialFingerprint,
      payloadJson: JSON.stringify(merged),
      fetchedAt: input.fetchedAt,
    });
  }

  async saveWeeklyObjectiveResult(result: WeeklyObjectiveResult): Promise<void> {
    const normalized = buildWeekDates(result.weekStartDate);
    const timestamp = nowIso();
    const nextResult: WeeklyObjectiveResult = {
      weekStartDate: normalized,
      objectiveId: result.objectiveId,
      achieved: result.achieved,
      updatedAt: timestamp,
    };
    this.weeklyObjectiveResults.set(`${normalized}:${result.objectiveId}`, nextResult);

    const objective = this.weeklyObjectives.get(result.objectiveId);
    if (!objective) {
      return;
    }

    const nextObjective = objectiveAfterManualAchievement(objective, normalized, result.achieved);
    if (nextObjective !== objective) {
      this.weeklyObjectives.set(objective.id, {
        ...nextObjective,
        updatedAt: timestamp,
      });
    }
  }

  async getMonthlyReview(monthKey: string): Promise<MonthlyReview | null> {
    const normalized = getMonthKey(`${monthKey}-01`);
    const existing = this.monthlyReviews.get(normalized);
    return existing ? cloneMonthlyReview(existing) : null;
  }

  async saveMonthlyReview(review: MonthlyReview): Promise<void> {
    return this.saveMonthlyReviewInternal(review);
  }

  private saveMonthlyReviewInternal(review: MonthlyReview): void {
    const normalized = getMonthKey(`${review.monthKey}-01`);
    this.monthlyReviews.set(normalized, {
      ...cloneMonthlyReview(review),
      monthKey: normalized,
    });
  }

  async listMonthlyReviews(limit = 12): Promise<MonthlyReview[]> {
    return [...this.monthlyReviews.values()]
      .sort((left, right) => right.monthKey.localeCompare(left.monthKey))
      .slice(0, limit)
      .map((review) => cloneMonthlyReview(review));
  }

  async listMonthlyReviewsOverlapping(
    startDate: string,
    endDate: string,
  ): Promise<MonthlyReview[]> {
    return [...this.monthlyReviews.values()]
      .filter((review) =>
        journalPeriodOverlaps(review.monthStartDate, review.monthEndDate, startDate, endDate),
      )
      .sort((left, right) => right.monthKey.localeCompare(left.monthKey))
      .map((review) => cloneMonthlyReview(review));
  }

  async computeMonthlyReviewSummary(monthKey: string) {
    const normalized = getMonthKey(`${monthKey}-01`);
    const entries = (
      await Promise.all(
        [...this.entries.values()]
          .filter((entry) => getMonthKey(entry.date) === normalized)
          .map((entry) => this.decorateEntry(entry)),
      )
    ).sort((left, right) => left.date.localeCompare(right.date));
    const weekStarts = listWeekStartsForMonth(normalized);
    const weeklySummaries = await Promise.all(
      weekStarts.map((weekStartDate) => this.computeWeeklyReviewSummary(weekStartDate)),
    );
    const weeklyReviews = weekStarts
      .map((weekStartDate) => this.weeklyReviews.get(weekStartDate))
      .filter((review): review is WeeklyReview => Boolean(review))
      .map((review) => cloneWeeklyReview(review));

    return buildMonthlyReviewSummary(normalized, entries, weeklyReviews, weeklySummaries);
  }

  async listAnnualGoals(): Promise<AnnualGoal[]> {
    return [...this.annualGoals.values()]
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((goal) => cloneAnnualGoal(goal));
  }

  async saveAnnualGoal(goal: AnnualGoal): Promise<AnnualGoal> {
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

    this.annualGoals.set(nextGoal.id, cloneAnnualGoal(nextGoal));
    return cloneAnnualGoal(nextGoal);
  }

  async deleteAnnualGoal(goalId: string): Promise<void> {
    this.annualGoals.delete(goalId);
  }

  async computeAnnualGoalSnapshots(year: number, asOfDate: string = getTodayDate()) {
    const entries = await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.date.startsWith(`${year}-`))
        .map((entry) => this.decorateEntry(entry)),
    );
    const weekStarts = [...new Set(entries.map((entry) => buildWeekDates(entry.date)))].sort();
    const weeklySummaries = await Promise.all(
      weekStarts.map((weekStartDate) => this.computeWeeklyReviewSummary(weekStartDate)),
    );
    return buildAnnualGoalSnapshots(
      [...this.annualGoals.values()].map((goal) => cloneAnnualGoal(goal)),
      year,
      entries,
      weeklySummaries,
      asOfDate,
    );
  }

  async getSettings(): Promise<AppSettings> {
    return structuredClone(normalizeAppSettings(this.settings));
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    this.settings = structuredClone(normalizeAppSettings(settings));
  }

  async updateSettings(updater: SettingsUpdater): Promise<AppSettings> {
    // No await: read/apply/write form one synchronous operation. Clone before exposing
    // the snapshot so an updater that mutates and throws cannot damage stored settings.
    const current = structuredClone(normalizeAppSettings(this.settings));
    const next = normalizeAppSettings(updater(current));
    this.settings = structuredClone(next);
    return structuredClone(next);
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
    const matches = [...this.aiMessages.values()]
      .filter(
        (message) =>
          message.surface === surface &&
          message.scopeKey === scopeKey &&
          message.inputHash === inputHash &&
          message.status === "ok",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return matches[0] ? { ...matches[0] } : null;
  }

  async getAiMessageRecord(
    surface: AiSurface,
    scopeKey: string,
    inputHash: string,
  ): Promise<AiMessage | null> {
    const matches = [...this.aiMessages.values()]
      .filter(
        (message) =>
          message.surface === surface &&
          message.scopeKey === scopeKey &&
          message.inputHash === inputHash,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return matches[0] ? { ...matches[0] } : null;
  }

  async getLatestAiMessage(
    surface: AiSurface,
    scopeKey: string,
    status?: AiMessage["status"],
  ): Promise<AiMessage | null> {
    const matches = [...this.aiMessages.values()]
      .filter(
        (message) =>
          message.surface === surface &&
          message.scopeKey === scopeKey &&
          (status === undefined || message.status === status),
      )
      .sort((left, right) => {
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        return byCreatedAt !== 0 ? byCreatedAt : right.id.localeCompare(left.id);
      });

    return matches[0] ? { ...matches[0] } : null;
  }

  async saveAiMessage(message: AiMessage): Promise<AiMessage> {
    const persisted = { ...message };
    this.aiMessages.set(message.id, persisted);
    return { ...persisted };
  }

  async saveCoachPulseEpisode(
    message: AiMessage,
    proposals: AiProposal[],
  ): Promise<{ message: AiMessage; proposals: AiProposal[] }> {
    const savedMessage = await this.saveAiMessage(message);
    for (const [id, proposal] of this.aiProposals.entries()) {
      if (proposal.messageId === savedMessage.id && proposal.status === "pending") {
        this.aiProposals.delete(id);
      }
    }

    const savedProposals: AiProposal[] = [];
    for (const proposal of proposals) {
      const persisted = { ...proposal, messageId: savedMessage.id };
      this.aiProposals.set(persisted.id, persisted);
      savedProposals.push({ ...persisted });
    }

    return { message: savedMessage, proposals: savedProposals };
  }

  async listAiMessages(surface?: AiSurface, limit = 50): Promise<AiMessage[]> {
    const messages = [...this.aiMessages.values()]
      .filter((message) => !surface || message.surface === surface)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
    return messages.map((message) => ({ ...message }));
  }

  async listAiMessagesForDate(date: string): Promise<AiMessage[]> {
    return [...this.aiMessages.values()]
      .filter((message) => message.scopeKey === date || message.scopeKey.startsWith(`${date}#`))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({ ...message }));
  }

  async listAiMessagesSince(sinceIso: string, limit = 10_000): Promise<AiMessage[]> {
    return [...this.aiMessages.values()]
      .filter((message) => message.createdAt >= sinceIso)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({ ...message }));
  }

  async listAiProposals(messageId: string): Promise<AiProposal[]> {
    return [...this.aiProposals.values()]
      .filter((proposal) => proposal.messageId === messageId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((proposal) => ({ ...proposal }));
  }

  async listAiProposalsSince(sinceIso: string): Promise<AiProposal[]> {
    return [...this.aiProposals.values()]
      .filter((proposal) => proposal.createdAt >= sinceIso)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((proposal) => ({ ...proposal }));
  }

  async computeAiUsageForMonth(monthKey: string): Promise<AiUsageTotals> {
    const { startIso, endIso } = monthKeyToLocalRange(monthKey);
    const messages = [...this.aiMessages.values()].filter(
      (message) =>
        message.createdAt >= startIso &&
        message.createdAt < endIso &&
        // `local` rows never called the model (no AI configured) — they must not count as a
        // "call" in the cost dashboard.
        message.status !== "local",
    );

    const tokensPrompt = messages.reduce(
      (total, message) => total + (message.tokensPrompt ?? 0),
      0,
    );
    const tokensCompletion = messages.reduce(
      (total, message) => total + (message.tokensCompletion ?? 0),
      0,
    );

    return {
      monthKey,
      callCount: messages.length,
      tokensPrompt,
      tokensCompletion,
      tokensTotal: tokensPrompt + tokensCompletion,
    };
  }

  async saveAiProposal(proposal: AiProposal): Promise<AiProposal> {
    this.aiProposals.set(proposal.id, { ...proposal });
    return { ...proposal };
  }

  async clearPendingAiProposals(messageId: string): Promise<void> {
    for (const [id, proposal] of this.aiProposals.entries()) {
      if (proposal.messageId === messageId && proposal.status === "pending") {
        this.aiProposals.delete(id);
      }
    }
  }

  async decideAiProposal(
    id: string,
    status: "accepted" | "dismissed",
    appliedEntityId?: string,
  ): Promise<AiProposal> {
    const existing = this.aiProposals.get(id);
    if (!existing) {
      throw new Error(`AI proposal not found: ${id}`);
    }

    const updated: AiProposal = {
      ...existing,
      status,
      appliedEntityId: appliedEntityId ?? null,
      decidedAt: nowIso(),
    };
    this.aiProposals.set(id, updated);
    return { ...updated };
  }

  async acceptAiProposal(
    proposalId: string,
    effect: AcceptEffect | null,
  ): Promise<AiProposalAcceptResult> {
    const proposal = this.aiProposals.get(proposalId);
    if (!proposal) throw new Error(`AI proposal not found: ${proposalId}`);
    if (proposal.status === "accepted") {
      if (
        effect?.kind === "memory" &&
        !this.aiMemories.has(proposal.appliedEntityId ?? effect.memory.id)
      ) {
        throw new Error(`AI memory not found: ${proposal.appliedEntityId ?? effect.memory.id}`);
      }
      if (
        effect?.kind === "weeklyObjective" &&
        !this.weeklyObjectives.has(proposal.appliedEntityId ?? effect.objective.id)
      ) {
        throw new Error(
          `Weekly objective not found: ${proposal.appliedEntityId ?? effect.objective.id}`,
        );
      }
      const appliedEntityId =
        proposal.appliedEntityId ??
        (effect?.kind === "memory"
          ? effect.memory.id
          : effect?.kind === "weeklyObjective"
            ? effect.objective.id
            : null);
      return { proposal: { ...proposal }, appliedEntityId };
    }
    if (!effect) return { proposal: { ...proposal }, appliedEntityId: null };

    // All internal effect writers below are synchronous. No other caller can interleave
    // between their mutations and the decision; rollback restores all affected maps.
    const snapshot = {
      aiProposals: new Map(this.aiProposals),
      ...(effect.kind === "memory" ? { aiMemories: new Map(this.aiMemories) } : {}),
      ...(effect.kind === "weeklyObjective"
        ? { weeklyObjectives: new Map(this.weeklyObjectives) }
        : {}),
      ...(effect.kind === "weeklyReview" ? { weeklyReviews: new Map(this.weeklyReviews) } : {}),
      ...(effect.kind === "monthlyReview" ? { monthlyReviews: new Map(this.monthlyReviews) } : {}),
      ...(effect.kind === "gtdTask"
        ? {
            tasks: new Map(this.tasks),
            contexts: new Map(this.contexts),
            events: new Map(this.events),
            recurringTemplates: new Map(this.recurringTemplates),
          }
        : {}),
    };
    try {
      let appliedEntityId: string;
      switch (effect.kind) {
        case "memory":
          appliedEntityId = (
            this.aiMemories.get(effect.memory.id) ?? this.saveAiMemoryInternal(effect.memory)
          ).id;
          break;
        case "weeklyObjective":
          appliedEntityId = this.saveWeeklyObjectiveInternal(effect.objective).id;
          break;
        case "weeklyReview":
          this.saveWeeklyReviewInternal(effect.review);
          appliedEntityId = effect.review.weekStartDate;
          break;
        case "monthlyReview":
          this.saveMonthlyReviewInternal(effect.review);
          appliedEntityId = effect.review.monthKey;
          break;
        case "gtdTask": {
          const task = this.tasks.get(effect.taskId);
          const next = task ? taskForAcceptEffect(task, effect) : null;
          if (!task || !next) return { proposal: { ...proposal }, appliedEntityId: null };
          this.saveTaskInternal(next);
          if (effect.action === "drop" && task.recurringTemplateId) {
            const template = this.getExistingRecurringTemplate(task.recurringTemplateId);
            this.recurringTemplates.set(template.id, {
              ...cloneRecurringTemplate(template),
              pendingMissedOccurrences: 0,
              updatedAt: nowIso(),
            });
          }
          appliedEntityId = task.id;
          break;
        }
      }
      const accepted: AiProposal = {
        ...proposal,
        status: "accepted",
        appliedEntityId,
        decidedAt: nowIso(),
      };
      this.aiProposals.set(proposalId, accepted);
      return { proposal: { ...accepted }, appliedEntityId };
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async listAiMemories(filters: AiMemoryFilters = {}): Promise<AiMemory[]> {
    let memories = [...this.aiMemories.values()];

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      memories = memories.filter((memory) => statuses.includes(memory.status));
    }

    if (filters.kind) {
      const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
      memories = memories.filter((memory) => kinds.includes(memory.kind));
    }

    if (typeof filters.pinned === "boolean") {
      memories = memories.filter((memory) => memory.pinned === filters.pinned);
    }

    if (filters.activeOnDate) {
      memories = memories.filter(
        (memory) => !memory.expiresAt || memory.expiresAt >= filters.activeOnDate!,
      );
    }

    return memories
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((memory) => ({ ...memory }));
  }

  async saveAiMemory(memory: AiMemory): Promise<AiMemory> {
    return this.saveAiMemoryInternal(memory);
  }

  private saveAiMemoryInternal(memory: AiMemory): AiMemory {
    const persisted = { ...memory };
    this.aiMemories.set(persisted.id, persisted);
    return { ...persisted };
  }

  async archiveAiMemory(
    id: string,
    reason: "expired" | "contradicted" | "resolved",
  ): Promise<void> {
    const existing = this.aiMemories.get(id);
    if (!existing) {
      throw new Error(`AI memory not found: ${id}`);
    }

    const detailSuffix = `[archive:${reason}]`;
    const detail = existing.detail.includes(detailSuffix)
      ? existing.detail
      : `${existing.detail}${existing.detail ? " " : ""}${detailSuffix}`.trim();

    this.aiMemories.set(id, {
      ...existing,
      status: reason === "contradicted" ? "contradicted" : "archived",
      detail,
      lastConfirmedAt: nowIso(),
    });
  }

  async getStorageInfo(): Promise<StorageInfo | null> {
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

  async getGtdOverview(): Promise<{
    taskCount: number;
    projectCount: number;
    contextCount: number;
  }> {
    return {
      taskCount: this.tasks.size,
      projectCount: this.projects.size,
      contextCount: this.contexts.size,
    };
  }

  async moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number> {
    let movedCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (
        task.status !== "active" ||
        !task.contextIds.includes(contextId) ||
        task.bucket === bucket
      ) {
        continue;
      }

      this.tasks.set(taskId, {
        ...cloneTask(task),
        bucket,
        updatedAt: nowIso(),
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
        updatedAt: nowIso(),
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
            (task.sourceExternalId ? sourceIds.has(task.sourceExternalId) : false)),
      );

      const previousPrimary =
        existingMatches.find((task) => task.id === desiredTask.id) ?? existingMatches[0] ?? null;
      const nextTask: Task = {
        ...cloneTask(desiredTask),
        notes: previousPrimary?.notes?.trim() ? previousPrimary.notes : desiredTask.notes,
        projectId: previousPrimary?.projectId ?? desiredTask.projectId,
        updatedAt: nowIso(),
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
    return cloneContexts(
      [...this.contexts.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  async saveContext(context: TaskContext): Promise<TaskContext> {
    const timestamp = nowIso();
    const nextName = context.name.trim();

    if (!nextName) {
      throw new Error("Le nom du contexte est requis.");
    }

    const duplicate = [...this.contexts.values()].find(
      (candidate) =>
        candidate.id !== context.id &&
        candidate.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase(),
    );

    if (duplicate) {
      throw new Error(`Le contexte "${nextName}" existe deja.`);
    }

    const previous = this.contexts.get(context.id);
    const nextContext: TaskContext = {
      id: context.id,
      name: nextName,
      createdAt: previous?.createdAt ?? context.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    this.contexts.set(nextContext.id, nextContext);
    return cloneContexts([nextContext])[0];
  }

  async listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
    return filterProjects([...this.projects.values()], filters);
  }

  async saveProject(project: Project): Promise<Project> {
    const timestamp = nowIso();
    const previous = project.id ? (this.projects.get(project.id) ?? null) : null;
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
      createdAt: project.createdAt || timestamp,
    };

    this.ensureContextsByIds(nextProject.contextIds);
    this.projects.set(nextProject.id, cloneProject(nextProject));
    this.reconcileProjects([nextProject.id]);
    return cloneProject(this.projects.get(nextProject.id)!);
  }

  async listTasks(filters: TaskFilters = {}): Promise<Task[]> {
    await this.generateDueRecurringTasks(getTodayDate());
    await this.promoteDueScheduledTasks(getTodayDate());
    return filterTasks([...this.tasks.values()], filters);
  }

  async listTaskEvents(filters: TaskEventFilters = {}): Promise<TaskEvent[]> {
    const types = filters.types;
    return [...this.events.values()]
      .filter((event) => !types || types.includes(event.type))
      .map((event) => ({
        ...event,
        metadata: { ...event.metadata },
      }))
      .sort((left, right) => left.eventAt.localeCompare(right.eventAt));
  }

  async listRecurringTaskTemplates(filters: RecurringTemplateFilters = {}) {
    return filterRecurringTemplates(
      [...this.recurringTemplates.values()].map((template) => cloneRecurringTemplate(template)),
      filters,
    );
  }

  async saveRecurringTaskTemplate(template: RecurringTaskTemplate): Promise<RecurringTaskTemplate> {
    const timestamp = nowIso();
    const previous = template.id ? (this.recurringTemplates.get(template.id) ?? null) : null;
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
        updatedAt: nowIso(),
      });
    }
    return cloneRecurringTemplate(nextTemplate);
  }

  async generateDueRecurringTasks(date: string): Promise<number> {
    const today = getTodayDate();
    const horizon = recurrenceGenerationHorizon(date, today);
    let changedCount = 0;

    for (const original of [...this.recurringTemplates.values()]) {
      if (original.status !== "active") {
        continue;
      }

      const instance = this.findRecurringInstance(original.id);
      const prepared = prepareRecurringGeneration(original, instance, today);
      let template = prepared.template;
      let activeTask = prepared.instance?.status === "active" ? prepared.instance : null;

      if (prepared.changed) {
        const timestamp = nowIso();
        template = {
          ...cloneRecurringTemplate(template),
          updatedAt: timestamp,
        };
        this.recurringTemplates.set(template.id, cloneRecurringTemplate(template));
        if (prepared.instance && recurringInstanceWasRewound(instance, prepared.instance)) {
          const previousInstance = instance ? cloneTask(instance) : null;
          const nextInstance = {
            ...cloneTask(prepared.instance),
            updatedAt: timestamp,
          };
          this.tasks.set(nextInstance.id, cloneTask(nextInstance));
          if (previousInstance) {
            this.persistEvents(buildLifecycleEvents(previousInstance, nextInstance));
          }
          if (nextInstance.status === "active") {
            activeTask = nextInstance;
          }
        }
      }

      const startDate = this.findProcessingStartDate(template, activeTask);
      const dueDates = listDueDatesBetween(template, startDate, horizon);

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
            // Reapply the template's contextIds/projectId on every generation (matching
            // TauriSqliteRepository): a new occurrence is driven by the template's current
            // structural fields even if a previous occurrence-scope edit changed them, while
            // title/notes are deliberately left as the active task's (occurrence customization
            // survives regeneration).
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
        : buildTaskFromRecurringTemplate(template, latestDueDate, Math.max(0, dueDates.length - 1));

      this.ensureContextsByIds(template.contextIds);
      this.tasks.set(nextTask.id, cloneTask(nextTask));
      this.persistEvents(buildLifecycleEvents(activeTask ? cloneTask(activeTask) : null, nextTask));

      this.recurringTemplates.set(template.id, {
        ...cloneRecurringTemplate(template),
        lastGeneratedForDate: latestDueDate,
        pendingMissedOccurrences: nextTask.pendingPastRecurrences,
        updatedAt: timestamp,
      });

      changedCount += 1;
    }

    return changedCount;
  }

  async promoteDueScheduledTasks(date: string): Promise<number> {
    const now = nowIso();
    const snapshot = [...this.tasks.values()];
    const updated = selectDueScheduledPromotions(snapshot, date, now);
    const previousById = new Map(snapshot.map((task) => [task.id, task] as const));

    for (const next of updated) {
      const previous = previousById.get(next.id) ?? null;
      this.tasks.set(next.id, cloneTask(next));
      const localEventDate = toLocalDateString(next.updatedAt);
      this.persistEvents(
        buildLifecycleEvents(previous, next).map((event) => ({
          ...event,
          eventDate: localEventDate,
        })),
      );
    }

    this.reconcileProjects(updated.map((task) => task.projectId));
    return updated.length;
  }

  async listRecurringPreviewOccurrences(rangeStart: string, rangeEnd: string) {
    return buildRecurringPreviewOccurrences(
      [...this.recurringTemplates.values()],
      [...this.tasks.values()],
      rangeStart,
      rangeEnd,
    );
  }

  async applyRecurringEditScope(
    taskId: string,
    scope: RecurringEditScope,
    changes: RecurringTaskChanges,
  ) {
    const task = this.getExistingTask(taskId);
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

    const template = this.getExistingRecurringTemplate(task.recurringTemplateId);
    const nextTemplate = applySeriesChangesToTemplate(template, changes);
    await this.saveRecurringTaskTemplate(nextTemplate);
    const nextTask = this.syncActiveTaskWithTemplate(this.getExistingTask(taskId), nextTemplate);
    return this.saveTask(nextTask);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.createTaskInternal(input);
  }

  private createTaskInternal(input: CreateTaskInput): Task {
    const draft = createTaskFromInput(input);
    const nextTask = this.applyPlannedAdjustments(null, draft);
    this.assertPlannedProjectExists(nextTask);
    this.ensureContextsByIds(nextTask.contextIds);
    this.tasks.set(nextTask.id, cloneTask(nextTask));
    this.persistEvents(buildLifecycleEvents(null, nextTask));
    this.reconcileProjects([nextTask.projectId]);
    return cloneTask(this.tasks.get(nextTask.id) ?? nextTask);
  }

  async saveTask(task: Task): Promise<Task> {
    return this.saveTaskInternal(task);
  }

  private saveTaskInternal(task: Task): Task {
    const previous = this.tasks.get(task.id) ?? null;
    const adjusted = this.applyPlannedAdjustments(previous, task);
    const nextTask: Task = {
      ...cloneTask(adjusted),
      title: adjusted.title.trim(),
      notes: adjusted.notes.trim(),
      updatedAt: nowIso(),
    };
    this.assertPlannedProjectExists(nextTask);

    this.ensureContextsByIds(nextTask.contextIds);
    this.tasks.set(nextTask.id, cloneTask(nextTask));
    this.persistEvents(buildLifecycleEvents(previous ? cloneTask(previous) : null, nextTask));
    this.reconcileProjects([previous?.projectId, nextTask.projectId]);
    return cloneTask(this.tasks.get(nextTask.id) ?? nextTask);
  }

  async moveTask(
    taskId: string,
    bucket: Task["bucket"],
    contextIds: string[],
    projectId?: string | null,
  ): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      bucket,
      contextIds: [...contextIds],
      projectId: projectId ?? current.projectId,
    });
  }

  async scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task> {
    const current = this.getExistingTask(taskId);

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
    const task = this.getExistingTask(taskId);
    if (task.status !== "active" || task.bucket !== "planned" || !task.projectId) {
      throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
    }

    const project = this.projects.get(task.projectId) ?? null;
    if (!project || project.status !== "active") {
      throw new Error("Le projet associe n'est pas actif");
    }

    return this.saveTask({ ...task, bucket: "next_action" });
  }

  async movePlannedTask(taskId: string, direction: "up" | "down"): Promise<Task[]> {
    const task = this.getExistingTask(taskId);
    if (task.status !== "active" || task.bucket !== "planned" || !task.projectId) {
      throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
    }

    const updates = swapPlannedOrder([...this.tasks.values()], taskId, direction, nowIso());
    if (!updates) {
      throw new Error(`La tache ${taskId} n'est pas planifiee et active`);
    }

    if (updates.length === 0) {
      return [cloneTask(task)];
    }

    for (const updated of updates) {
      this.tasks.set(updated.id, cloneTask(updated));
    }

    return updates.map((updated) => cloneTask(this.tasks.get(updated.id) ?? updated));
  }

  async completeTask(taskId: string, completedAt = nowIso()): Promise<Task> {
    const current = this.getExistingTask(taskId);
    const nextTask = await this.saveTask({
      ...current,
      status: "completed",
      completedAt,
    });
    if (current.recurringTemplateId) {
      const template = this.getExistingRecurringTemplate(current.recurringTemplateId);
      const nextLastGeneratedForDate =
        current.recurrenceDueDate &&
        (!template.lastGeneratedForDate ||
          current.recurrenceDueDate > template.lastGeneratedForDate)
          ? current.recurrenceDueDate
          : template.lastGeneratedForDate;
      this.recurringTemplates.set(current.recurringTemplateId, {
        ...cloneRecurringTemplate(template),
        lastGeneratedForDate: nextLastGeneratedForDate,
        pendingMissedOccurrences: 0,
        updatedAt: nowIso(),
      });
    }
    return nextTask;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    const nextTask = await this.saveTask({
      ...current,
      status: "cancelled",
      completedAt: null,
    });
    if (current.recurringTemplateId) {
      const template = this.getExistingRecurringTemplate(current.recurringTemplateId);
      this.recurringTemplates.set(current.recurringTemplateId, {
        ...cloneRecurringTemplate(template),
        pendingMissedOccurrences: 0,
        updatedAt: nowIso(),
      });
    }
    return nextTask;
  }

  async clearPastRecurrences(taskId: string): Promise<Task> {
    const current = this.getExistingTask(taskId);
    return this.saveTask({
      ...current,
      pendingPastRecurrences: 0,
    });
  }

  async generateDailyRelationshipTasks(date: string): Promise<number> {
    let createdCount = 0;
    await this.updateSettings((current) => {
      const plan = buildDailyRelationshipDrawPlan(date, current, [...this.tasks.values()]);
      const snapshot = {
        tasks: new Map(this.tasks),
        contexts: new Map(this.contexts),
        events: new Map(this.events),
        projects: new Map(this.projects),
      };
      try {
        // No await: the active-task check, inserts, and settings update cannot interleave.
        for (const input of plan.taskInputs) this.createTaskInternal(input);
        createdCount = plan.taskInputs.length;
        return plan.settings;
      } catch (error) {
        Object.assign(this, snapshot);
        throw error;
      }
    });
    return createdCount;
  }

  async computeDailyTaskStats(date: string): Promise<DailyTaskStats> {
    await this.generateDueRecurringTasks(date);
    await this.promoteDueScheduledTasks(getTodayDate());
    if (date <= getTodayDate() && isSunday(date)) {
      await this.applyWeeklyCarryover(date);
    }

    return buildDailyTaskStats([...this.tasks.values()], [...this.events.values()], date);
  }

  async getDailyTaskBreakdown(date: string) {
    await this.generateDueRecurringTasks(date);
    await this.promoteDueScheduledTasks(getTodayDate());
    if (date <= getTodayDate() && isSunday(date)) {
      await this.applyWeeklyCarryover(date);
    }

    return buildDailyTaskBreakdown([...this.tasks.values()], [...this.events.values()], date);
  }

  async applyWeeklyCarryover(weekStartDate: string): Promise<number> {
    const nextEvents = buildCarryoverEvents(
      [...this.tasks.values()],
      [...this.events.values()],
      weekStartDate,
    );
    this.persistEvents(nextEvents);
    return nextEvents.length;
  }

  async getPomodoroState(): Promise<PomodoroState> {
    return buildPomodoroState(
      [...this.pomodoroSessions.values()],
      [...this.pomodoroSegments.values()],
    );
  }

  async startPomodoro(options: PomodoroStartOptions = {}): Promise<PomodoroState> {
    await this.completeExpiredPomodoroSessions();
    const state = await this.getPomodoroState();

    if (state.activeSession) {
      return state;
    }

    const startedAt = nowIso();
    const { session, segmentsToUpsert } = startSession(state, options, startedAt);
    this.pomodoroSessions.set(session.id, session);
    for (const segment of segmentsToUpsert) {
      this.pomodoroSegments.set(segment.id, segment);
    }

    return this.getPomodoroState();
  }

  async stopPomodoroSession(
    sessionId: string,
    status: "completed" | "cancelled",
    at = nowIso(),
  ): Promise<PomodoroState> {
    const session = requirePomodoroSession(this.pomodoroSessions.get(sessionId), sessionId);

    if (session.status !== "running" && session.status !== "paused") {
      return this.getPomodoroState();
    }

    const openSegments = [...this.pomodoroSegments.values()].filter(
      (segment) => segment.sessionId === sessionId && segment.endedAt === null,
    );
    const transition = stopSession(session, openSegments, status, at);
    this.pomodoroSessions.set(sessionId, transition.session);
    for (const segment of transition.segmentsToUpsert) {
      this.pomodoroSegments.set(segment.id, segment);
    }

    return this.getPomodoroState();
  }

  async pausePomodoroSession(sessionId: string, at = nowIso()): Promise<PomodoroState> {
    const session = requirePomodoroSession(this.pomodoroSessions.get(sessionId), sessionId);

    if (session.status !== "running") {
      return this.getPomodoroState();
    }

    const openSegments = [...this.pomodoroSegments.values()].filter(
      (segment) => segment.sessionId === sessionId && segment.endedAt === null,
    );
    const transition = pauseSession(session, openSegments, at);
    this.pomodoroSessions.set(sessionId, transition.session);
    for (const segment of transition.segmentsToUpsert) {
      this.pomodoroSegments.set(segment.id, segment);
    }

    return this.getPomodoroState();
  }

  async resumePomodoroSession(sessionId: string, at = nowIso()): Promise<PomodoroState> {
    const session = requirePomodoroSession(this.pomodoroSessions.get(sessionId), sessionId);

    if (session.status !== "paused") {
      return this.getPomodoroState();
    }

    const latestSegment =
      session.kind === "focus"
        ? [...this.pomodoroSegments.values()]
            .filter((segment) => segment.sessionId === sessionId)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .at(-1)
        : null;
    const transition = resumeSession(session, latestSegment, at);
    this.pomodoroSessions.set(sessionId, transition.session);
    for (const segment of transition.segmentsToUpsert) {
      this.pomodoroSegments.set(segment.id, segment);
    }

    return this.getPomodoroState();
  }

  async completeExpiredPomodoroSessions(now = nowIso()): Promise<PomodoroState> {
    const expiredRunningSessions = [...this.pomodoroSessions.values()].filter(
      (session) =>
        session.status === "running" &&
        new Date(session.endsAt).getTime() <= new Date(now).getTime(),
    );

    for (const session of expiredRunningSessions) {
      await this.stopPomodoroSession(session.id, "completed", session.endsAt);
    }

    const afterExpiry = [...this.pomodoroSessions.values()];
    for (const sessionId of getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset(
      afterExpiry,
      now,
    )) {
      await this.stopPomodoroSession(sessionId, "completed", now);
    }

    return this.getPomodoroState();
  }

  async switchPomodoroTask(
    sessionId: string,
    taskId: string | null,
    title: string | null = null,
    changedAt = nowIso(),
  ): Promise<PomodoroState> {
    const session = requirePomodoroSession(this.pomodoroSessions.get(sessionId), sessionId);

    if (session.status !== "running" || session.kind !== "focus") {
      return this.getPomodoroState();
    }

    const openSegment = [...this.pomodoroSegments.values()].find(
      (segment) => segment.sessionId === sessionId && segment.endedAt === null,
    );

    const transition = switchSessionTask(session, openSegment, taskId, title, changedAt);
    if (!transition) {
      return this.getPomodoroState();
    }
    for (const segment of transition.segmentsToUpsert) {
      this.pomodoroSegments.set(segment.id, segment);
    }
    return this.getPomodoroState();
  }

  async listPomodoroSessions(date: string) {
    return buildPomodoroSessionDetails(
      [...this.pomodoroSessions.values()].filter((session) => session.date === date),
      [...this.pomodoroSegments.values()],
    );
  }

  async listPomodoroTaskSummaries(date: string, now = nowIso()) {
    return buildPomodoroTaskSummaries(
      [...this.pomodoroSessions.values()],
      [...this.pomodoroSegments.values()],
      [...this.tasks.values()],
      date,
      now,
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

  private findRecurringInstance(templateId: string): Task | null {
    const task = this.tasks.get(`recurring-task:${templateId}`);
    if (!task?.isRecurringInstance || task.recurringTemplateId !== templateId) {
      return null;
    }

    return cloneTask(task);
  }

  private findActiveRecurringTask(templateId: string): Task | null {
    const task = [...this.tasks.values()].find(
      (candidate) =>
        candidate.recurringTemplateId === templateId &&
        candidate.isRecurringInstance &&
        candidate.status === "active",
    );

    return task ? cloneTask(task) : null;
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
          ? buildTaskFromRecurringTemplate(
              template,
              task.recurrenceDueDate,
              task.pendingPastRecurrences,
            ).scheduledFor
          : null,
      updatedAt: nowIso(),
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
      this.computeDailyPomodoroStats(entry.date),
    ]);
    return applyDailyPomodoroStats(
      applyDailyTaskStats(cloneEntry(entry), taskStats),
      pomodoroStats,
    );
  }

  private getExistingTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} introuvable`);
    }

    return cloneTask(task);
  }

  private applyPlannedAdjustments(previous: Task | null, requested: Task): Task {
    return adjustPlannedFieldsForSave(previous, requested, [...this.tasks.values()]);
  }

  /**
   * A Planned task must reference a project that actually exists; a stale or unknown id
   * would silently become an orphaned, never-promoted Planned task (reconciliation no-ops
   * when the project lookup returns null).
   */
  private assertPlannedProjectExists(task: Task): void {
    if (task.bucket !== "planned" || !task.projectId) {
      return;
    }

    if (!this.projects.has(task.projectId)) {
      throw new Error(`Le projet ${task.projectId} est introuvable`);
    }
  }

  /** Deduplicates project ids and reconciles each once; used after every task mutation. */
  private reconcileProjects(projectIds: Array<string | null | undefined>): void {
    const uniqueIds = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    for (const projectId of uniqueIds) {
      this.reconcileProjectNextAction(projectId);
    }
  }

  /** Promotes at most one planned task when eligible, then compacts the planned queue. */
  private reconcileProjectNextAction(projectId: string): void {
    const project = this.projects.get(projectId) ?? null;
    const tasksSnapshot = [...this.tasks.values()];
    const outcome = reconcileProjectPlannedTasks(tasksSnapshot, project, nowIso());

    if (outcome.updatedTasks.length === 0) {
      return;
    }

    const previousById = new Map(tasksSnapshot.map((task) => [task.id, task] as const));

    for (const updated of outcome.updatedTasks) {
      const previous = previousById.get(updated.id) ?? null;
      this.tasks.set(updated.id, cloneTask(updated));

      if (updated.id === outcome.promotedTaskId && previous) {
        // Auto-promotion lifecycle events must use the local calendar date, never a UTC
        // slice of the instant timestamp: near local midnight those diverge by a day.
        const localEventDate = toLocalDateString(updated.updatedAt);
        this.persistEvents(
          buildLifecycleEvents(cloneTask(previous), updated).map((event) => ({
            ...event,
            eventDate: localEventDate,
          })),
        );
      }
    }
  }

  private persistEvents(events: TaskEvent[]): void {
    for (const event of events) {
      if (event.dedupeKey) {
        const existing = [...this.events.values()].find(
          (candidate) => candidate.dedupeKey === event.dedupeKey,
        );
        if (existing) {
          continue;
        }
      }

      this.events.set(event.id, {
        ...event,
        metadata: { ...event.metadata },
      });
    }
  }

  private ensureContextsByIds(contextIds: string[]): void {
    for (const contextId of contextIds) {
      if (this.contexts.has(contextId)) {
        continue;
      }

      const name = contextId.startsWith("context:")
        ? contextId.slice("context:".length).replace(/-/g, " ")
        : contextId;
      const timestamp = nowIso();
      this.contexts.set(contextId, {
        id: contextId,
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
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
      updatedAt: nowIso(),
    };
    this.contexts.set(id, context);
    return context;
  }
}
