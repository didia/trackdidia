// Finance domain types. Mirrors the SQLite schema in the finance spec
// (specs/done/finance.md) one-for-one, like src/domain/email-triage.ts.
// Types only — no migrations, no I/O, no settings fields live here.

export type FinanceAccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit_card"
  | "line_of_credit"
  | "loan"
  | "mortgage"
  | "investment"
  | "asset"
  | "other";

export type FinanceAccountOwnership = "individual" | "joint";

export type FinanceCategoryKind = "expense" | "income" | "transfer" | "internal";

export type FinanceCategorySource = "user" | "rule" | "memory" | "seed" | "ai" | "default";

export type FinanceMerchantMemorySource = "seed" | "auto_confirm" | "user_correction";

export type FinanceCategorySuggestionOrigin = "memory" | "seed" | "ai";

export type FinanceCategorySuggestionStatus = "pending" | "accepted" | "corrected" | "dismissed";

export type FinanceOverspendPolicy = "reduce_next_ready_to_assign" | "carry_negative";

export type FinanceRecurringCadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "quarterly"
  | "annual";

export type FinanceRecurringStatus = "active" | "paused" | "ended";

export type FinanceBalanceSnapshotSource = "derived" | "statement" | "manual";

export type FinanceImportAmountMode =
  | "single_signed"
  | "debit_credit_columns"
  | "amount_with_type_column";

export type FinanceImportBatchStatus = "running" | "completed" | "failed";

export type FinanceDateFormat = "M/D/YYYY" | "D/M/YYYY" | "YYYY-MM-DD";

export interface FinancePerson {
  id: string;
  displayName: string;
  color: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceAccount {
  id: string;
  name: string;
  institution: string | null;
  type: FinanceAccountType;
  currency: string;
  ownerPersonId: string | null;
  ownership: FinanceAccountOwnership;
  onBudget: boolean;
  closed: boolean;
  openingBalanceMinor: number;
  currentBalanceMinor: number | null;
  balanceAsOf: string | null;
  externalKey: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceCategory {
  id: string;
  name: string;
  parentId: string | null;
  kind: FinanceCategoryKind;
  archived: boolean;
  isSystem: boolean;
  defersToNextMonth: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceTransaction {
  id: string;
  accountId: string;
  postedDate: string;
  amountMinor: number;
  currency: string;
  descriptionRaw: string;
  descriptionOriginal: string | null;
  merchantKey: string;
  merchantDisplay: string | null;
  categoryId: string | null;
  categorySource: FinanceCategorySource;
  categoryConfidence: number | null;
  categorizedAt: string | null;
  personId: string | null;
  notes: string | null;
  labelsJson: string | null;
  pending: boolean;
  isTransfer: boolean;
  transferGroupId: string | null;
  excludedFromBudget: boolean;
  excludedFromReports: boolean;
  hasSplits: boolean;
  importBatchId: string | null;
  dedupeHash: string;
  sourceRowJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceTransactionSplit {
  id: string;
  transactionId: string;
  amountMinor: number;
  categoryId: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface FinanceRuleMatcher {
  descriptionContains?: string;
  descriptionRegex?: string;
  accountIds?: string[];
  personId?: string;
  amountMinMinor?: number;
  amountMaxMinor?: number;
  sign?: 1 | -1;
}

export interface FinanceRuleActions {
  categoryId?: string;
  merchantDisplay?: string;
  personId?: string;
  markTransfer?: boolean;
  excludeFromBudget?: boolean;
  excludeFromReports?: boolean;
  addLabels?: string[];
}

export interface FinanceRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  matcher: FinanceRuleMatcher;
  actions: FinanceRuleActions;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt: string | null;
  appliedCount: number;
}

export interface FinanceMerchantMemoryEntry {
  merchantKey: string;
  accountId: string;
  sign: -1 | 0 | 1;
  categoryId: string;
  hitCount: number;
  correctionCount: number;
  confidence: number;
  source: FinanceMerchantMemorySource;
  lastAppliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceCategorySuggestion {
  id: string;
  transactionId: string;
  merchantKey: string;
  suggestedCategoryId: string;
  confidence: number;
  origin: FinanceCategorySuggestionOrigin;
  rationale: string | null;
  model: string | null;
  promptVersion: string | null;
  status: FinanceCategorySuggestionStatus;
  decidedAt: string | null;
  createdAt: string;
}

export interface FinanceBudgetEntry {
  monthKey: string;
  categoryId: string;
  assignedMinor: number;
  overspendPolicy: FinanceOverspendPolicy;
  note: string | null;
  updatedAt: string;
}

export interface FinanceBudgetMonth {
  monthKey: string;
  readyToAssignNote: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface FinanceRecurringSeries {
  id: string;
  merchantKey: string;
  accountId: string;
  categoryId: string | null;
  cadence: FinanceRecurringCadence;
  expectedAmountMinor: number;
  amountToleranceMinor: number;
  dayOfMonth: number | null;
  lastSeenDate: string;
  nextExpectedDate: string;
  occurrenceCount: number;
  status: FinanceRecurringStatus;
  confirmedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceAccountBalanceSnapshot {
  accountId: string;
  asOfDate: string;
  balanceMinor: number;
  source: FinanceBalanceSnapshotSource;
  createdAt: string;
}

export interface FinanceImportColumnMap {
  date?: number;
  description?: number;
  descriptionOriginal?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  transactionType?: number;
  account?: number;
  categoryHint?: number;
  notes?: number;
  labels?: number;
}

export interface FinanceImportProfile {
  id: string;
  name: string;
  signature: string;
  columnMap: FinanceImportColumnMap;
  dateFormat: FinanceDateFormat;
  amountMode: FinanceImportAmountMode;
  signConvention: string | null;
  decimalSeparator?: "." | ",";
  thousandsSeparator?: "," | "." | " " | "";
  defaultAccountId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface FinanceImportBatch {
  id: string;
  profileId: string | null;
  fileName: string;
  fileHash: string;
  accountId: string | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  skippedCount: number;
  errorCount: number;
  status: FinanceImportBatchStatus;
  errorSummary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// Repository-facing request/response/filter shapes (Phase 2). Mirrors the
// "Repository methods" section of specs/done/finance.md.

export interface FinanceAccountFilters {
  includeClosed?: boolean;
  onBudgetOnly?: boolean;
  ownerPersonId?: string | null;
}

export interface FinanceMerchantMemoryFilters {
  merchantKey?: string;
  accountId?: string;
}

export interface FinanceTransactionFilters {
  dateFrom?: string;
  dateTo?: string;
  accountIds?: string[];
  categoryIds?: string[];
  personIds?: string[];
  search?: string;
  uncategorizedOnly?: boolean;
  includeTransfers?: boolean;
  limit?: number;
  offset?: number;
}

export type FinanceTransactionCategoryScope = "this" | "this_and_future" | "all_matching";

export interface SetFinanceTransactionCategoryInput {
  transactionId: string;
  categoryId: string;
  scope: FinanceTransactionCategoryScope;
}

/**
 * A transaction's category fields as they were immediately before a bulk
 * recategorize, so `scope: "all_matching"` can offer a single undo (see
 * specs/done/finance.md "Learning from corrections").
 */
export interface FinanceCategoryBackfillEntry {
  transactionId: string;
  categoryId: string | null;
  categorySource: FinanceCategorySource;
  categoryConfidence: number | null;
  categorizedAt: string | null;
  /**
   * The category the `all_matching` call wrote to this row. `revertFinanceCategoryBackfill`
   * only reverts a row whose current `category_id` still equals this value and whose
   * `categorized_at` is still `appliedAt` — a later unrelated edit to the row is never
   * silently clobbered by an undo of an older bulk edit. (The bulk edit itself marks the row
   * `category_source = 'user'` so automation never overwrites it.)
   */
  appliedCategoryId: string;
  /** The `categorized_at` timestamp the `all_matching` call stamped on this row. */
  appliedAt: string;
}

export interface SetFinanceTransactionCategoryResult {
  updated: number;
  memory: FinanceMerchantMemoryEntry | null;
  /**
   * Populated only for `scope: "all_matching"` — the prior state of every
   * row this call recategorized besides the target transaction, passed back
   * to `revertFinanceCategoryBackfill` for a single undo.
   */
  backfill: FinanceCategoryBackfillEntry[];
}

export interface BulkUpdateFinanceTransactionsPatch {
  categoryId?: string;
  personId?: string | null;
  excludedFromBudget?: boolean;
  excludedFromReports?: boolean;
}

export interface SetFinanceTransferPair {
  transactionIdA: string;
  transactionIdB: string;
}

/** One already-mapped CSV row, ready for insertion (parsing/mapping is Phase 1/3). */
export interface FinanceImportRow {
  accountId: string;
  postedDate: string;
  amountMinor: number;
  currency: string;
  descriptionRaw: string;
  descriptionOriginal: string | null;
  merchantKey: string;
  categoryHint: string | null;
  personId: string | null;
  notes: string | null;
  labelsJson: string | null;
  sourceRowJson: string | null;
}

export interface FinanceImportRequest {
  /** The batch's primary account, used for the batch row and undo scoping. */
  accountId: string;
  profileId: string | null;
  fileName: string;
  fileHash: string;
  rows: FinanceImportRow[];
  /**
   * Records the caller could not turn into rows (CSV parse drops, mapping errors). They never
   * reach `rows`, so the caller reports them here to land in the batch counts and warnings.
   */
  rejected?: { skipped: number; errors: number; warnings: string[] };
}

export interface FinanceImportNearDuplicate {
  transactionId: string;
  existingTransactionId: string;
  similarity: number;
  dateDiffDays: number;
}

export interface FinanceImportSummary {
  batchId: string;
  rowCount: number;
  imported: number;
  duplicates: number;
  skipped: number;
  errors: number;
  newAccounts: number;
  transfersDetected: number;
  pendingSuggestions: number;
  warnings: string[];
  nearDuplicates: FinanceImportNearDuplicate[];
}

export interface DecideFinanceCategorySuggestionInput {
  status: Exclude<FinanceCategorySuggestionStatus, "pending">;
  categoryId?: string;
}

/**
 * `deleted` is rows actually removed; `refusedUserCategorized` is rows the undo left alone
 * because `category_source = 'user'` (see specs/done/finance.md "Overlapping exports").
 */
export interface UndoFinanceImportBatchResult {
  deleted: number;
  refusedUserCategorized: number;
}

/**
 * `reclassifyFinancePending` re-runs `classifyTransaction` (rules, memory,
 * seeds — no AI, no transfer re-detection) over every non-`user` transaction.
 * `reclassified` is rows whose `category_id`/`category_source` changed;
 * `suggestionsCreated` is new pending `finance_category_suggestions` rows.
 */
export interface ReclassifyFinancePendingResult {
  reclassified: number;
  suggestionsCreated: number;
}

// --- Finance (Phase 8 — AI categorization) ---------------------------------------------

/**
 * One merchant-level group of currently "unknown" transactions — `category_id ===
 * UNCATEGORIZED_CATEGORY_ID`, `category_source !== "user"`, not a transfer, and with no
 * existing pending suggestion (rules/memory/seeds all failed to decide — see
 * specs/done/finance.md "AI stage"). This is the unit `listFinanceUnknownMerchants` returns
 * and the unit `src/lib/ai/context/finance-categorization-snapshot.ts` sanitizes for the AI
 * request. `amountMinorSample` and `accountType` are representative values (median absolute
 * amount; most common account type among the group's transactions) used only for the AI
 * payload's amount bucket and account-type fields — never sent as exact figures.
 */
export interface FinanceUnknownMerchantGroup {
  merchantKey: string;
  /** Most common sign among the group's transactions. */
  sign: -1 | 0 | 1;
  occurrenceCount: number;
  amountMinorSample: number;
  accountType: FinanceAccountType;
  transactionIds: string[];
}

/** One merchant's AI categorization answer, keyed by the (possibly sanitized) request key. */
export interface FinanceCategorizationMerchantResult {
  merchantKey: string;
  categoryId: string;
  confidence: number;
  rationale: string;
}

export interface ApplyFinanceCategorizationResultsInput {
  results: FinanceCategorizationMerchantResult[];
  /**
   * Sanitized/request merchant key -> the original `finance_transactions.merchant_key` values
   * it represents. Almost always a single-entry array; only collapses multiple original keys
   * when sanitization happens to make two distinct merchants collide (see
   * `finance-categorization-snapshot.ts`).
   */
  merchantKeyMap: Record<string, string[]>;
  /**
   * The transaction ids that were listed (and sent to the model) for this request. Apply only
   * touches these, and still skips any that gained a pending suggestion during the AI round
   * trip — siblings that were never requested, or already carry a suggestion, are left alone.
   */
  transactionIds: string[];
  model: string;
  promptVersion: string;
  autoApply: boolean;
  autoApplyMinConfidence: number;
  /** Injectable "today" (local YYYY-MM-DD) for the dismissed-pair window. */
  today?: string;
}

export interface ApplyFinanceCategorizationResultsOutcome {
  /** New `finance_category_suggestions` rows written (both auto-applied and left pending). */
  suggestionsCreated: number;
  /** Transactions whose category was set directly because the auto-apply gate held. */
  autoApplied: number;
  /**
   * Original merchant keys skipped because `(merchantKey, categoryId)` was dismissed in the
   * last 90 days — counted once per merchant key (not per transaction, and not per AI result:
   * a result whose `merchantKeyMap` entry maps to several original merchant keys counts each
   * dismissed key separately).
   */
  suppressedDismissed: number;
}
