// Finance domain types. Mirrors the SQLite schema in the finance spec
// (specs/todo/finance.md) one-for-one, like src/domain/email-triage.ts.
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
  dateFormat: string;
  amountMode: FinanceImportAmountMode;
  signConvention: string | null;
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
