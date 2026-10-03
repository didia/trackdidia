// Finance persistence (Phase 2 — Schema and repository parity). Mirrors the
// email-triage pattern: row mapping/query code lives here, reached through
// thin delegating methods on `TauriSqliteRepository` (see `getFinanceStore()`).
// See specs/done/finance.md "Repository methods" and "CSV import".

import type {
  ApplyFinanceCategorizationResultsInput,
  ApplyFinanceCategorizationResultsOutcome,
  BulkUpdateFinanceTransactionsPatch,
  DecideFinanceCategorySuggestionInput,
  FinanceAccount,
  FinanceAccountBalanceSnapshot,
  FinanceAccountFilters,
  FinanceAccountType,
  FinanceBudgetEntry,
  FinanceBudgetMonth,
  FinanceCategory,
  FinanceCategoryBackfillEntry,
  FinanceCategorySuggestion,
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
  FinanceRuleActions,
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
import {
  assertFinanceCategoryAssignable,
  computeCoverOverspending,
  computeFinanceBudgetState,
  type CoverOverspendingResult,
  type FinanceBudgetComputationInput,
  type FinanceBudgetState,
} from "../../domain/finance/budget";
import {
  computeFinanceCashFlow,
  type FinanceCashFlowComputationInput,
  type FinanceCashFlowSummary,
} from "../../domain/finance/cash-flow";
import {
  buildFinanceNetWorthHistory,
  computeFinanceNetWorth,
  type FinanceNetWorthComputationInput,
  type FinanceNetWorthHistoryPoint,
  type FinanceNetWorthSnapshot,
} from "../../domain/finance/net-worth";
import { getMonthEndDate, getMonthKey } from "../../domain/monthly-review";
import {
  buildFinanceAlerts,
  computeFinanceForecast,
  type FinanceAlert,
  type FinanceForecast,
  type FinanceSnapshot,
} from "../../domain/finance/forecast";
import {
  computeFinanceCategorySpend,
  computeFinanceMerchantSpend,
  computeFinanceMonthOverMonth,
  computeFinancePersonSpend,
  computeFinanceTrend,
  listFinanceCategorySpendDrilldown,
  type FinanceCategorySpendRow,
  type FinanceDateRange,
  type FinanceMerchantSpendRow,
  type FinanceMonthOverMonthRow,
  type FinancePersonSpendRow,
  type FinanceReportComputationInput,
  type FinanceReportGroupBy,
  type FinanceReportLine,
  type FinanceTrendGranularity,
  type FinanceTrendPoint,
} from "../../domain/finance/reports";
import type { Database } from "./email-triage-sqlite-db";
import { getTodayDate } from "../date";
import {
  classifyTransaction,
  UNCATEGORIZED_CATEGORY_ID,
  type ClassificationOutcome,
} from "../finance/classify";
import { DEFAULT_FINANCE_CATEGORIES } from "../finance/default-categories";
import {
  isSuggestionDismissed,
  type DismissedSuggestionPair,
} from "../finance/dismissed-suggestions";
import {
  dedupeHash as computeDedupeHash,
  assignOccurrenceIndices,
} from "../finance/import-profile";
import { applyMerchantMemoryCorrection } from "../finance/memory";
import { findNearDuplicates } from "../finance/near-duplicates";
import {
  detectFinanceRecurringSeries,
  type RecurringDetectionExistingSeriesInput,
  type RecurringDetectionTransactionInput,
} from "../finance/recurring-detection";
import { detectTransfers, type TransferCandidateTransaction } from "../finance/transfers";
import { createEntityId, nowIso } from "../gtd/shared";

interface PersonRow {
  id: string;
  display_name: string;
  color: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

const mapPerson = (row: PersonRow): FinancePerson => ({
  id: row.id,
  displayName: row.display_name,
  color: row.color,
  archived: Boolean(row.archived),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface AccountRow {
  id: string;
  name: string;
  institution: string | null;
  type: FinanceAccount["type"];
  currency: string;
  owner_person_id: string | null;
  ownership: FinanceAccount["ownership"];
  on_budget: number;
  closed: number;
  opening_balance_minor: number;
  current_balance_minor: number | null;
  balance_as_of: string | null;
  external_key: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const mapAccount = (row: AccountRow): FinanceAccount => ({
  id: row.id,
  name: row.name,
  institution: row.institution,
  type: row.type,
  currency: row.currency,
  ownerPersonId: row.owner_person_id,
  ownership: row.ownership,
  onBudget: Boolean(row.on_budget),
  closed: Boolean(row.closed),
  openingBalanceMinor: row.opening_balance_minor,
  currentBalanceMinor: row.current_balance_minor,
  balanceAsOf: row.balance_as_of,
  externalKey: row.external_key,
  notes: row.notes,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  kind: FinanceCategory["kind"];
  archived: number;
  is_system: number;
  defers_to_next_month: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const mapCategory = (row: CategoryRow): FinanceCategory => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
  kind: row.kind,
  archived: Boolean(row.archived),
  isSystem: Boolean(row.is_system),
  defersToNextMonth: Boolean(row.defers_to_next_month),
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface TransactionRow {
  id: string;
  account_id: string;
  posted_date: string;
  amount_minor: number;
  currency: string;
  description_raw: string;
  description_original: string | null;
  merchant_key: string;
  merchant_display: string | null;
  category_id: string | null;
  category_source: FinanceTransaction["categorySource"];
  category_confidence: number | null;
  categorized_at: string | null;
  person_id: string | null;
  notes: string | null;
  labels_json: string | null;
  pending: number;
  is_transfer: number;
  transfer_group_id: string | null;
  excluded_from_budget: number;
  excluded_from_reports: number;
  has_splits: number;
  import_batch_id: string | null;
  dedupe_hash: string;
  source_row_json: string | null;
  created_at: string;
  updated_at: string;
}

const mapTransaction = (row: TransactionRow): FinanceTransaction => ({
  id: row.id,
  accountId: row.account_id,
  postedDate: row.posted_date,
  amountMinor: row.amount_minor,
  currency: row.currency,
  descriptionRaw: row.description_raw,
  descriptionOriginal: row.description_original,
  merchantKey: row.merchant_key,
  merchantDisplay: row.merchant_display,
  categoryId: row.category_id,
  categorySource: row.category_source,
  categoryConfidence: row.category_confidence,
  categorizedAt: row.categorized_at,
  personId: row.person_id,
  notes: row.notes,
  labelsJson: row.labels_json,
  pending: Boolean(row.pending),
  isTransfer: Boolean(row.is_transfer),
  transferGroupId: row.transfer_group_id,
  excludedFromBudget: Boolean(row.excluded_from_budget),
  excludedFromReports: Boolean(row.excluded_from_reports),
  hasSplits: Boolean(row.has_splits),
  importBatchId: row.import_batch_id,
  dedupeHash: row.dedupe_hash,
  sourceRowJson: row.source_row_json,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface SplitRow {
  id: string;
  transaction_id: string;
  amount_minor: number;
  category_id: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
}

const mapSplit = (row: SplitRow): FinanceTransactionSplit => ({
  id: row.id,
  transactionId: row.transaction_id,
  amountMinor: row.amount_minor,
  categoryId: row.category_id,
  notes: row.notes,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
});

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  enabled: number;
  matcher_json: string;
  actions_json: string;
  created_at: string;
  updated_at: string;
  last_applied_at: string | null;
  applied_count: number;
}

const mapRule = (row: RuleRow): FinanceRule => ({
  id: row.id,
  name: row.name,
  priority: row.priority,
  enabled: Boolean(row.enabled),
  matcher: JSON.parse(row.matcher_json),
  actions: JSON.parse(row.actions_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastAppliedAt: row.last_applied_at,
  appliedCount: row.applied_count,
});

interface MemoryRow {
  merchant_key: string;
  account_id: string;
  sign: number;
  category_id: string;
  hit_count: number;
  correction_count: number;
  confidence: number;
  source: FinanceMerchantMemoryEntry["source"];
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapMemory = (row: MemoryRow): FinanceMerchantMemoryEntry => ({
  merchantKey: row.merchant_key,
  accountId: row.account_id,
  sign: row.sign as -1 | 0 | 1,
  categoryId: row.category_id,
  hitCount: row.hit_count,
  correctionCount: row.correction_count,
  confidence: row.confidence,
  source: row.source,
  lastAppliedAt: row.last_applied_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface SuggestionRow {
  id: string;
  transaction_id: string;
  merchant_key: string;
  suggested_category_id: string;
  confidence: number;
  origin: FinanceCategorySuggestion["origin"];
  rationale: string | null;
  model: string | null;
  prompt_version: string | null;
  status: FinanceCategorySuggestion["status"];
  decided_at: string | null;
  created_at: string;
}

const mapSuggestion = (row: SuggestionRow): FinanceCategorySuggestion => ({
  id: row.id,
  transactionId: row.transaction_id,
  merchantKey: row.merchant_key,
  suggestedCategoryId: row.suggested_category_id,
  confidence: row.confidence,
  origin: row.origin,
  rationale: row.rationale,
  model: row.model,
  promptVersion: row.prompt_version,
  status: row.status,
  decidedAt: row.decided_at,
  createdAt: row.created_at,
});

interface RecurringSeriesRow {
  id: string;
  merchant_key: string;
  account_id: string;
  category_id: string | null;
  cadence: FinanceRecurringSeries["cadence"];
  expected_amount_minor: number;
  amount_tolerance_minor: number;
  day_of_month: number | null;
  last_seen_date: string;
  next_expected_date: string;
  occurrence_count: number;
  status: FinanceRecurringSeries["status"];
  confirmed_by_user: number;
  created_at: string;
  updated_at: string;
}

const mapRecurringSeries = (row: RecurringSeriesRow): FinanceRecurringSeries => ({
  id: row.id,
  merchantKey: row.merchant_key,
  accountId: row.account_id,
  categoryId: row.category_id,
  cadence: row.cadence,
  expectedAmountMinor: row.expected_amount_minor,
  amountToleranceMinor: row.amount_tolerance_minor,
  dayOfMonth: row.day_of_month,
  lastSeenDate: row.last_seen_date,
  nextExpectedDate: row.next_expected_date,
  occurrenceCount: row.occurrence_count,
  status: row.status,
  confirmedByUser: Boolean(row.confirmed_by_user),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface BalanceSnapshotRow {
  account_id: string;
  as_of_date: string;
  balance_minor: number;
  source: FinanceAccountBalanceSnapshot["source"];
  created_at: string;
}

const mapBalanceSnapshot = (row: BalanceSnapshotRow): FinanceAccountBalanceSnapshot => ({
  accountId: row.account_id,
  asOfDate: row.as_of_date,
  balanceMinor: row.balance_minor,
  source: row.source,
  createdAt: row.created_at,
});

interface ImportProfileRow {
  id: string;
  name: string;
  signature: string;
  column_map_json: string;
  date_format: FinanceImportProfile["dateFormat"];
  amount_mode: FinanceImportProfile["amountMode"];
  sign_convention: string | null;
  default_account_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const mapImportProfile = (row: ImportProfileRow): FinanceImportProfile => ({
  id: row.id,
  name: row.name,
  signature: row.signature,
  columnMap: JSON.parse(row.column_map_json),
  dateFormat: row.date_format,
  amountMode: row.amount_mode,
  signConvention: row.sign_convention,
  defaultAccountId: row.default_account_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastUsedAt: row.last_used_at,
});

interface ImportBatchRow {
  id: string;
  profile_id: string | null;
  file_name: string;
  file_hash: string;
  account_id: string | null;
  row_count: number;
  imported_count: number;
  duplicate_count: number;
  skipped_count: number;
  error_count: number;
  status: FinanceImportBatch["status"];
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

const mapImportBatch = (row: ImportBatchRow): FinanceImportBatch => ({
  id: row.id,
  profileId: row.profile_id,
  fileName: row.file_name,
  fileHash: row.file_hash,
  accountId: row.account_id,
  rowCount: row.row_count,
  importedCount: row.imported_count,
  duplicateCount: row.duplicate_count,
  skippedCount: row.skipped_count,
  errorCount: row.error_count,
  status: row.status,
  errorSummary: row.error_summary,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

interface BudgetEntryRow {
  month_key: string;
  category_id: string;
  assigned_minor: number;
  overspend_policy: FinanceOverspendPolicy;
  note: string | null;
  updated_at: string;
}

const mapBudgetEntry = (row: BudgetEntryRow): FinanceBudgetEntry => ({
  monthKey: row.month_key,
  categoryId: row.category_id,
  assignedMinor: row.assigned_minor,
  overspendPolicy: row.overspend_policy,
  note: row.note,
  updatedAt: row.updated_at,
});

interface BudgetMonthRow {
  month_key: string;
  ready_to_assign_note: string | null;
  closed_at: string | null;
  updated_at: string;
}

const mapBudgetMonth = (row: BudgetMonthRow): FinanceBudgetMonth => ({
  monthKey: row.month_key,
  readyToAssignNote: row.ready_to_assign_note,
  closedAt: row.closed_at,
  updatedAt: row.updated_at,
});

/** Chunk size for multi-row INSERTs, staying well under SQLite's parameter limit. */
const IMPORT_CHUNK_SIZE = 200;

export class FinanceSqliteStore {
  constructor(private readonly getDb: () => Promise<Database>) {}

  // --- people -------------------------------------------------------------

  async listPeople(): Promise<FinancePerson[]> {
    const db = await this.getDb();
    const rows = await db.select<PersonRow[]>("SELECT * FROM finance_people ORDER BY display_name");
    return rows.map(mapPerson);
  }

  async savePerson(person: FinancePerson): Promise<FinancePerson> {
    const db = await this.getDb();
    const now = nowIso();
    const id = person.id || createEntityId("finance-person");
    await db.execute(
      `INSERT INTO finance_people (id, display_name, color, archived, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         color = excluded.color,
         archived = excluded.archived,
         updated_at = excluded.updated_at`,
      [id, person.displayName, person.color, person.archived ? 1 : 0, person.createdAt || now, now],
    );
    const rows = await db.select<PersonRow[]>("SELECT * FROM finance_people WHERE id = $1", [id]);
    return mapPerson(rows[0]);
  }

  // --- accounts -------------------------------------------------------------

  async listAccounts(filters?: FinanceAccountFilters): Promise<FinanceAccount[]> {
    const db = await this.getDb();
    const rows = await db.select<AccountRow[]>(
      "SELECT * FROM finance_accounts ORDER BY sort_order, name",
    );
    let accounts = rows.map(mapAccount);
    if (filters?.includeClosed !== true) {
      accounts = accounts.filter((account) => !account.closed);
    }
    if (filters?.onBudgetOnly) {
      accounts = accounts.filter((account) => account.onBudget);
    }
    if (filters?.ownerPersonId) {
      accounts = accounts.filter((account) => account.ownerPersonId === filters.ownerPersonId);
    }
    return accounts;
  }

  async saveAccount(account: FinanceAccount): Promise<FinanceAccount> {
    const db = await this.getDb();
    const now = nowIso();
    const id = account.id || createEntityId("finance-account");
    await db.execute(
      `INSERT INTO finance_accounts (
        id, name, institution, type, currency, owner_person_id, ownership, on_budget, closed,
        opening_balance_minor, current_balance_minor, balance_as_of, external_key, notes,
        sort_order, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        institution = excluded.institution,
        type = excluded.type,
        currency = excluded.currency,
        owner_person_id = excluded.owner_person_id,
        ownership = excluded.ownership,
        on_budget = excluded.on_budget,
        closed = excluded.closed,
        opening_balance_minor = excluded.opening_balance_minor,
        current_balance_minor = excluded.current_balance_minor,
        balance_as_of = excluded.balance_as_of,
        external_key = excluded.external_key,
        notes = excluded.notes,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
      [
        id,
        account.name,
        account.institution,
        account.type,
        account.currency,
        account.ownerPersonId,
        account.ownership,
        account.onBudget ? 1 : 0,
        account.closed ? 1 : 0,
        account.openingBalanceMinor,
        account.currentBalanceMinor,
        account.balanceAsOf,
        account.externalKey,
        account.notes,
        account.sortOrder,
        account.createdAt || now,
        now,
      ],
    );
    const rows = await db.select<AccountRow[]>("SELECT * FROM finance_accounts WHERE id = $1", [
      id,
    ]);
    return mapAccount(rows[0]);
  }

  async closeAccount(id: string): Promise<FinanceAccount> {
    const db = await this.getDb();
    await db.execute("UPDATE finance_accounts SET closed = 1, updated_at = $2 WHERE id = $1", [
      id,
      nowIso(),
    ]);
    const rows = await db.select<AccountRow[]>("SELECT * FROM finance_accounts WHERE id = $1", [
      id,
    ]);
    if (!rows[0]) {
      throw new Error(`finance account not found: ${id}`);
    }
    return mapAccount(rows[0]);
  }

  // --- categories -------------------------------------------------------------

  async listCategories(includeArchived?: boolean): Promise<FinanceCategory[]> {
    const db = await this.getDb();
    const rows = await db.select<CategoryRow[]>(
      "SELECT * FROM finance_categories ORDER BY sort_order, name",
    );
    const categories = rows.map(mapCategory);
    return includeArchived ? categories : categories.filter((category) => !category.archived);
  }

  async saveCategory(category: FinanceCategory): Promise<FinanceCategory> {
    const db = await this.getDb();
    const now = nowIso();
    const id = category.id || createEntityId("fincat");
    await db.execute(
      `INSERT INTO finance_categories (
        id, name, parent_id, kind, archived, is_system, defers_to_next_month, sort_order, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        parent_id = excluded.parent_id,
        kind = excluded.kind,
        archived = excluded.archived,
        defers_to_next_month = excluded.defers_to_next_month,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
      [
        id,
        category.name,
        category.parentId,
        category.kind,
        category.archived ? 1 : 0,
        category.isSystem ? 1 : 0,
        category.defersToNextMonth ? 1 : 0,
        category.sortOrder,
        category.createdAt || now,
        now,
      ],
    );
    const rows = await db.select<CategoryRow[]>("SELECT * FROM finance_categories WHERE id = $1", [
      id,
    ]);
    return mapCategory(rows[0]);
  }

  async archiveCategory(id: string, reassignToId: string): Promise<number> {
    const db = await this.getDb();
    const now = nowIso();
    const result = await db.execute(
      "UPDATE finance_transactions SET category_id = $2, updated_at = $3 WHERE category_id = $1",
      [id, reassignToId, now],
    );
    await db.execute("UPDATE finance_categories SET archived = 1, updated_at = $2 WHERE id = $1", [
      id,
      now,
    ]);
    return result.rowsAffected;
  }

  /** Idempotent INSERT OR IGNORE seed of the default French taxonomy. Returns rows newly inserted. */
  async seedDefaultCategories(): Promise<number> {
    const db = await this.getDb();
    const now = nowIso();
    let inserted = 0;
    for (const seed of DEFAULT_FINANCE_CATEGORIES) {
      const result = await db.execute(
        `INSERT OR IGNORE INTO finance_categories (
          id, name, parent_id, kind, archived, is_system, defers_to_next_month, sort_order, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,0,0,0,$5,$6,$6)`,
        [seed.id, seed.name, seed.parentId, seed.kind, seed.sortOrder, now],
      );
      inserted += result.rowsAffected;
    }
    return inserted;
  }

  // --- rules -------------------------------------------------------------

  async listRules(): Promise<FinanceRule[]> {
    const db = await this.getDb();
    const rows = await db.select<RuleRow[]>("SELECT * FROM finance_rules ORDER BY priority, id");
    return rows.map(mapRule);
  }

  async saveRule(rule: FinanceRule): Promise<FinanceRule> {
    const db = await this.getDb();
    const now = nowIso();
    const id = rule.id || createEntityId("finance-rule");
    await db.execute(
      `INSERT INTO finance_rules (
        id, name, priority, enabled, matcher_json, actions_json, created_at, updated_at,
        last_applied_at, applied_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        priority = excluded.priority,
        enabled = excluded.enabled,
        matcher_json = excluded.matcher_json,
        actions_json = excluded.actions_json,
        updated_at = excluded.updated_at,
        last_applied_at = excluded.last_applied_at,
        applied_count = excluded.applied_count`,
      [
        id,
        rule.name,
        rule.priority,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.matcher),
        JSON.stringify(rule.actions),
        rule.createdAt || now,
        now,
        rule.lastAppliedAt,
        rule.appliedCount,
      ],
    );
    const rows = await db.select<RuleRow[]>("SELECT * FROM finance_rules WHERE id = $1", [id]);
    return mapRule(rows[0]);
  }

  async deleteRule(id: string): Promise<void> {
    const db = await this.getDb();
    await db.execute("DELETE FROM finance_rules WHERE id = $1", [id]);
  }

  // --- merchant memory -----------------------------------------------------

  async listMerchantMemory(
    filters?: FinanceMerchantMemoryFilters,
  ): Promise<FinanceMerchantMemoryEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<MemoryRow[]>(
      "SELECT * FROM finance_merchant_memory ORDER BY merchant_key, account_id, sign",
    );
    let entries = rows.map(mapMemory);
    if (filters?.merchantKey) {
      entries = entries.filter((entry) => entry.merchantKey === filters.merchantKey);
    }
    if (filters?.accountId !== undefined) {
      entries = entries.filter((entry) => entry.accountId === filters.accountId);
    }
    return entries;
  }

  async getMerchantMemory(
    merchantKey: string,
    accountId: string,
    sign: -1 | 0 | 1,
  ): Promise<FinanceMerchantMemoryEntry | null> {
    const db = await this.getDb();
    const rows = await db.select<MemoryRow[]>(
      "SELECT * FROM finance_merchant_memory WHERE merchant_key = $1 AND account_id = $2 AND sign = $3",
      [merchantKey, accountId, sign],
    );
    return rows[0] ? mapMemory(rows[0]) : null;
  }

  async upsertMerchantMemory(
    entry: FinanceMerchantMemoryEntry,
  ): Promise<FinanceMerchantMemoryEntry> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO finance_merchant_memory (
        merchant_key, account_id, sign, category_id, hit_count, correction_count, confidence,
        source, last_applied_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(merchant_key, account_id, sign) DO UPDATE SET
        category_id = excluded.category_id,
        hit_count = excluded.hit_count,
        correction_count = excluded.correction_count,
        confidence = excluded.confidence,
        source = excluded.source,
        last_applied_at = excluded.last_applied_at,
        updated_at = excluded.updated_at`,
      [
        entry.merchantKey,
        entry.accountId,
        entry.sign,
        entry.categoryId,
        entry.hitCount,
        entry.correctionCount,
        entry.confidence,
        entry.source,
        entry.lastAppliedAt,
        entry.createdAt,
        entry.updatedAt,
      ],
    );
    return entry;
  }

  async forgetMerchantMemory(
    merchantKey: string,
    accountId: string,
    sign: -1 | 0 | 1,
  ): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      "DELETE FROM finance_merchant_memory WHERE merchant_key = $1 AND account_id = $2 AND sign = $3",
      [merchantKey, accountId, sign],
    );
  }

  // --- transactions -------------------------------------------------------------

  async listTransactions(filters: FinanceTransactionFilters = {}): Promise<FinanceTransaction[]> {
    const db = await this.getDb();
    const rows = await db.select<TransactionRow[]>(
      "SELECT * FROM finance_transactions ORDER BY posted_date DESC, id DESC",
    );
    let transactions = rows.map(mapTransaction);

    if (filters.dateFrom) {
      transactions = transactions.filter((txn) => txn.postedDate >= filters.dateFrom!);
    }
    if (filters.dateTo) {
      transactions = transactions.filter((txn) => txn.postedDate <= filters.dateTo!);
    }
    if (filters.accountIds && filters.accountIds.length > 0) {
      const set = new Set(filters.accountIds);
      transactions = transactions.filter((txn) => set.has(txn.accountId));
    }
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      const set = new Set(filters.categoryIds);
      transactions = transactions.filter(
        (txn) => txn.categoryId !== null && set.has(txn.categoryId),
      );
    }
    if (filters.personIds && filters.personIds.length > 0) {
      const set = new Set(filters.personIds);
      transactions = transactions.filter((txn) => txn.personId !== null && set.has(txn.personId));
    }
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      transactions = transactions.filter(
        (txn) =>
          txn.descriptionRaw.toLowerCase().includes(needle) ||
          (txn.merchantDisplay ?? "").toLowerCase().includes(needle),
      );
    }
    if (filters.uncategorizedOnly) {
      transactions = transactions.filter(
        (txn) => txn.categoryId === null || txn.categoryId === "fincat:non-categorise",
      );
    }
    if (filters.includeTransfers === false) {
      transactions = transactions.filter((txn) => !txn.isTransfer);
    }
    if (filters.offset) {
      transactions = transactions.slice(filters.offset);
    }
    if (filters.limit !== undefined) {
      transactions = transactions.slice(0, filters.limit);
    }
    return transactions;
  }

  async countTransactions(filters: FinanceTransactionFilters = {}): Promise<number> {
    const { limit, offset, ...rest } = filters;
    const transactions = await this.listTransactions(rest);
    return transactions.length;
  }

  async getTransaction(id: string): Promise<FinanceTransaction | null> {
    const db = await this.getDb();
    const rows = await db.select<TransactionRow[]>(
      "SELECT * FROM finance_transactions WHERE id = $1",
      [id],
    );
    return rows[0] ? mapTransaction(rows[0]) : null;
  }

  async saveTransaction(txn: FinanceTransaction): Promise<FinanceTransaction> {
    const db = await this.getDb();
    const now = nowIso();
    const id = txn.id || createEntityId("finance-txn");
    await db.execute(
      `INSERT INTO finance_transactions (
        id, account_id, posted_date, amount_minor, currency, description_raw, description_original,
        merchant_key, merchant_display, category_id, category_source, category_confidence,
        categorized_at, person_id, notes, labels_json, pending, is_transfer, transfer_group_id,
        excluded_from_budget, excluded_from_reports, has_splits, import_batch_id, dedupe_hash,
        source_row_json, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      )
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        posted_date = excluded.posted_date,
        amount_minor = excluded.amount_minor,
        currency = excluded.currency,
        description_raw = excluded.description_raw,
        description_original = excluded.description_original,
        merchant_key = excluded.merchant_key,
        merchant_display = excluded.merchant_display,
        category_id = excluded.category_id,
        category_source = excluded.category_source,
        category_confidence = excluded.category_confidence,
        categorized_at = excluded.categorized_at,
        person_id = excluded.person_id,
        notes = excluded.notes,
        labels_json = excluded.labels_json,
        pending = excluded.pending,
        is_transfer = excluded.is_transfer,
        transfer_group_id = excluded.transfer_group_id,
        excluded_from_budget = excluded.excluded_from_budget,
        excluded_from_reports = excluded.excluded_from_reports,
        has_splits = excluded.has_splits,
        import_batch_id = excluded.import_batch_id,
        dedupe_hash = excluded.dedupe_hash,
        source_row_json = excluded.source_row_json,
        updated_at = excluded.updated_at`,
      [
        id,
        txn.accountId,
        txn.postedDate,
        txn.amountMinor,
        txn.currency,
        txn.descriptionRaw,
        txn.descriptionOriginal,
        txn.merchantKey,
        txn.merchantDisplay,
        txn.categoryId,
        txn.categorySource,
        txn.categoryConfidence,
        txn.categorizedAt,
        txn.personId,
        txn.notes,
        txn.labelsJson,
        txn.pending ? 1 : 0,
        txn.isTransfer ? 1 : 0,
        txn.transferGroupId,
        txn.excludedFromBudget ? 1 : 0,
        txn.excludedFromReports ? 1 : 0,
        txn.hasSplits ? 1 : 0,
        txn.importBatchId,
        txn.dedupeHash,
        txn.sourceRowJson,
        txn.createdAt || now,
        now,
      ],
    );
    const rows = await db.select<TransactionRow[]>(
      "SELECT * FROM finance_transactions WHERE id = $1",
      [id],
    );
    return mapTransaction(rows[0]);
  }

  async setTransactionCategory(
    input: SetFinanceTransactionCategoryInput,
  ): Promise<SetFinanceTransactionCategoryResult> {
    if (!input.categoryId) {
      throw new Error("setFinanceTransactionCategory requires a non-empty categoryId");
    }
    const db = await this.getDb();
    const now = nowIso();
    const txn = await this.getTransaction(input.transactionId);
    if (!txn) {
      throw new Error(`finance transaction not found: ${input.transactionId}`);
    }

    await db.execute(
      "UPDATE finance_transactions SET category_id = $2, category_source = 'user', category_confidence = NULL, categorized_at = $3, updated_at = $3 WHERE id = $1",
      [input.transactionId, input.categoryId, now],
    );

    let updated = 1;
    const backfill: FinanceCategoryBackfillEntry[] = [];
    if (input.scope === "all_matching") {
      const matchingRows = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions WHERE merchant_key = $1 AND category_source != 'user' AND id != $2",
        [txn.merchantKey, input.transactionId],
      );
      for (const row of matchingRows) {
        backfill.push({
          transactionId: row.id,
          categoryId: row.category_id,
          categorySource: row.category_source,
          categoryConfidence: row.category_confidence,
          categorizedAt: row.categorized_at,
          appliedCategoryId: input.categoryId,
        });
      }
      const result = await db.execute(
        "UPDATE finance_transactions SET category_id = $2, category_confidence = NULL, categorized_at = $3, updated_at = $3 WHERE merchant_key = $1 AND category_source != 'user' AND id != $4",
        [txn.merchantKey, input.categoryId, now, input.transactionId],
      );
      updated += result.rowsAffected;
    }

    const sign: -1 | 0 | 1 = txn.amountMinor > 0 ? 1 : txn.amountMinor < 0 ? -1 : 0;
    const existingMemory = await this.getMerchantMemory(txn.merchantKey, txn.accountId, sign);
    const memory = applyMerchantMemoryCorrection({
      existing: existingMemory,
      merchantKey: txn.merchantKey,
      accountId: txn.accountId,
      sign,
      categoryId: input.categoryId,
      source: "user_correction",
      now,
    });
    await this.upsertMerchantMemory(memory);

    return { updated, memory, backfill };
  }

  /**
   * Reverts the `backfill` entries from a `scope: "all_matching"` call — a
   * single undo, one `BEGIN IMMEDIATE`/`COMMIT`. Skips (and does not count)
   * a row whose `category_source` is now `"user"` or whose current
   * `category_id` no longer equals `entry.appliedCategoryId` — either means
   * something else touched the row after the bulk edit, and an undo of the
   * older edit must not clobber it.
   */
  async revertCategoryBackfill(entries: FinanceCategoryBackfillEntry[]): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }
    const db = await this.getDb();
    const now = nowIso();

    await db.execute("BEGIN IMMEDIATE");
    try {
      let reverted = 0;
      for (const entry of entries) {
        const result = await db.execute(
          `UPDATE finance_transactions SET
            category_id = $2, category_source = $3, category_confidence = $4,
            categorized_at = $5, updated_at = $6
          WHERE id = $1 AND category_source != 'user' AND category_id = $7`,
          [
            entry.transactionId,
            entry.categoryId,
            entry.categorySource,
            entry.categoryConfidence,
            entry.categorizedAt,
            now,
            entry.appliedCategoryId,
          ],
        );
        reverted += result.rowsAffected;
      }
      await db.execute("COMMIT");
      return reverted;
    } catch (error) {
      await this.rollbackQuietly(db);
      throw error;
    }
  }

  async bulkUpdateTransactions(
    ids: string[],
    patch: BulkUpdateFinanceTransactionsPatch,
  ): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const db = await this.getDb();
    const now = nowIso();
    let updated = 0;
    for (const id of ids) {
      const sets: string[] = [];
      const params: unknown[] = [];
      let index = 2;
      if (patch.categoryId !== undefined) {
        sets.push(`category_id = $${index}`);
        params.push(patch.categoryId);
        index += 1;
        sets.push("category_source = 'user'");
        sets.push(`categorized_at = $${index}`);
        params.push(now);
        index += 1;
      }
      if (patch.personId !== undefined) {
        sets.push(`person_id = $${index}`);
        params.push(patch.personId);
        index += 1;
      }
      if (patch.excludedFromBudget !== undefined) {
        sets.push(`excluded_from_budget = $${index}`);
        params.push(patch.excludedFromBudget ? 1 : 0);
        index += 1;
      }
      if (patch.excludedFromReports !== undefined) {
        sets.push(`excluded_from_reports = $${index}`);
        params.push(patch.excludedFromReports ? 1 : 0);
        index += 1;
      }
      if (sets.length === 0) {
        continue;
      }
      sets.push(`updated_at = $${index}`);
      params.push(now);
      const result = await db.execute(
        `UPDATE finance_transactions SET ${sets.join(", ")} WHERE id = $1`,
        [id, ...params],
      );
      updated += result.rowsAffected;
    }
    return updated;
  }

  async saveTransactionSplits(
    transactionId: string,
    splits: FinanceTransactionSplit[],
  ): Promise<FinanceTransaction> {
    const db = await this.getDb();
    const now = nowIso();
    await db.execute("DELETE FROM finance_transaction_splits WHERE transaction_id = $1", [
      transactionId,
    ]);

    for (const [index, split] of splits.entries()) {
      const id = split.id || createEntityId("finance-split");
      await db.execute(
        `INSERT INTO finance_transaction_splits (
          id, transaction_id, amount_minor, category_id, notes, sort_order, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, transactionId, split.amountMinor, split.categoryId, split.notes, index, now],
      );
    }

    await db.execute(
      `UPDATE finance_transactions SET
        has_splits = $2,
        category_id = CASE WHEN $2 = 1 THEN 'fincat:split' ELSE category_id END,
        category_source = CASE WHEN $2 = 1 THEN 'user' ELSE category_source END,
        updated_at = $3
      WHERE id = $1`,
      [transactionId, splits.length > 0 ? 1 : 0, now],
    );

    const txn = await this.getTransaction(transactionId);
    if (!txn) {
      throw new Error(`finance transaction not found: ${transactionId}`);
    }
    return txn;
  }

  async listTransactionSplits(transactionId: string): Promise<FinanceTransactionSplit[]> {
    const db = await this.getDb();
    const rows = await db.select<SplitRow[]>(
      "SELECT * FROM finance_transaction_splits WHERE transaction_id = $1 ORDER BY sort_order",
      [transactionId],
    );
    return rows.map(mapSplit);
  }

  async setTransfer(pair: SetFinanceTransferPair | null, groupId?: string): Promise<void> {
    const db = await this.getDb();
    const now = nowIso();

    if (pair === null) {
      return;
    }

    const resolvedGroupId =
      groupId ?? `transfer:${[pair.transactionIdA, pair.transactionIdB].sort().join(":")}`;

    for (const id of [pair.transactionIdA, pair.transactionIdB]) {
      await db.execute(
        `UPDATE finance_transactions SET
          is_transfer = 1,
          transfer_group_id = $2,
          category_id = 'fincat:transfert',
          category_source = 'rule',
          excluded_from_budget = 1,
          updated_at = $3
        WHERE id = $1`,
        [id, resolvedGroupId, now],
      );
    }
  }

  async clearTransfer(transactionId: string): Promise<void> {
    const db = await this.getDb();
    const now = nowIso();
    await db.execute(
      `UPDATE finance_transactions SET
        is_transfer = 0,
        transfer_group_id = NULL,
        category_id = 'fincat:non-categorise',
        category_source = 'default',
        excluded_from_budget = 0,
        updated_at = $2
      WHERE id = $1`,
      [transactionId, now],
    );
  }

  // --- import profiles -------------------------------------------------------------

  async listImportProfiles(): Promise<FinanceImportProfile[]> {
    const db = await this.getDb();
    const rows = await db.select<ImportProfileRow[]>(
      "SELECT * FROM finance_import_profiles ORDER BY name",
    );
    return rows.map(mapImportProfile);
  }

  async saveImportProfile(profile: FinanceImportProfile): Promise<FinanceImportProfile> {
    const db = await this.getDb();
    const now = nowIso();
    const id = profile.id || createEntityId("finance-import-profile");
    await db.execute(
      `INSERT INTO finance_import_profiles (
        id, name, signature, column_map_json, date_format, amount_mode, sign_convention,
        default_account_id, created_at, updated_at, last_used_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        signature = excluded.signature,
        column_map_json = excluded.column_map_json,
        date_format = excluded.date_format,
        amount_mode = excluded.amount_mode,
        sign_convention = excluded.sign_convention,
        default_account_id = excluded.default_account_id,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at`,
      [
        id,
        profile.name,
        profile.signature,
        JSON.stringify(profile.columnMap),
        profile.dateFormat,
        profile.amountMode,
        profile.signConvention,
        profile.defaultAccountId,
        profile.createdAt || now,
        now,
        profile.lastUsedAt,
      ],
    );
    const rows = await db.select<ImportProfileRow[]>(
      "SELECT * FROM finance_import_profiles WHERE id = $1",
      [id],
    );
    return mapImportProfile(rows[0]);
  }

  async findImportProfileBySignature(signature: string): Promise<FinanceImportProfile | null> {
    const db = await this.getDb();
    const rows = await db.select<ImportProfileRow[]>(
      "SELECT * FROM finance_import_profiles WHERE signature = $1",
      [signature],
    );
    return rows[0] ? mapImportProfile(rows[0]) : null;
  }

  // --- import batches -------------------------------------------------------------

  async listImportBatches(limit?: number): Promise<FinanceImportBatch[]> {
    const db = await this.getDb();
    const rows = await db.select<ImportBatchRow[]>(
      "SELECT * FROM finance_import_batches ORDER BY started_at DESC",
    );
    const batches = rows.map(mapImportBatch);
    return limit !== undefined ? batches.slice(0, limit) : batches;
  }

  // --- import (single transaction; see specs/done/finance.md "Write-path discipline") --------

  /**
   * Inserts `input.rows` as one batch: chunked multi-row INSERTs with
   * `ON CONFLICT(account_id, dedupe_hash) DO NOTHING`, near-duplicate detection
   * against existing rows, transfer detection across the whole history, and a
   * written `finance_import_batches` row. Called from
   * `TauriSqliteRepository.importFinanceTransactions`, already inside one
   * `runExclusive` block — this method issues its own `BEGIN IMMEDIATE`/`COMMIT`
   * and must never call another queue-taking repository method.
   */
  async importTransactions(input: FinanceImportRequest): Promise<FinanceImportSummary> {
    const db = await this.getDb();
    const now = nowIso();
    const batchId = createEntityId("finance-import-batch");

    await db.execute("BEGIN IMMEDIATE");
    try {
      await db.execute(
        `INSERT INTO finance_import_batches (
          id, profile_id, file_name, file_hash, account_id, row_count, imported_count,
          duplicate_count, skipped_count, error_count, status, error_summary, started_at, finished_at
        ) VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,'running',NULL,$7,NULL)`,
        [
          batchId,
          input.profileId,
          input.fileName,
          input.fileHash,
          input.accountId,
          input.rows.length,
          now,
        ],
      );

      const occurrenceIndices = assignOccurrenceIndices(input.rows);
      const prepared = input.rows.map((row, index) => ({
        row,
        occurrenceIndex: occurrenceIndices[index],
        dedupeHash: computeDedupeHash({
          accountId: row.accountId,
          postedDate: row.postedDate,
          amountMinor: row.amountMinor,
          currency: row.currency,
          descriptionRaw: row.descriptionRaw,
          occurrenceIndex: occurrenceIndices[index],
        }),
        id: createEntityId("finance-txn"),
      }));

      let imported = 0;
      let duplicates = 0;
      const warnings: string[] = [];

      for (let start = 0; start < prepared.length; start += IMPORT_CHUNK_SIZE) {
        const chunk = prepared.slice(start, start + IMPORT_CHUNK_SIZE);
        const valuesSql: string[] = [];
        const params: unknown[] = [];
        let paramIndex = 1;

        for (const item of chunk) {
          const placeholders = Array.from({ length: 18 }, () => `$${paramIndex++}`).join(",");
          valuesSql.push(`(${placeholders})`);
          params.push(
            item.id,
            item.row.accountId,
            item.row.postedDate,
            item.row.amountMinor,
            item.row.currency,
            item.row.descriptionRaw,
            item.row.descriptionOriginal,
            item.row.merchantKey,
            "fincat:non-categorise",
            "default",
            item.row.personId,
            item.row.notes,
            item.row.labelsJson,
            batchId,
            item.dedupeHash,
            item.row.sourceRowJson,
            now,
            now,
          );
        }

        const beforeCount = (
          await db.select<Array<{ count: number }>>(
            "SELECT COUNT(*) as count FROM finance_transactions WHERE import_batch_id = $1",
            [batchId],
          )
        )[0].count;

        await db.execute(
          `INSERT INTO finance_transactions (
            id, account_id, posted_date, amount_minor, currency, description_raw,
            description_original, merchant_key, category_id, category_source, person_id,
            notes, labels_json, import_batch_id, dedupe_hash, source_row_json, created_at, updated_at
          ) VALUES ${valuesSql.join(",")}
          ON CONFLICT(account_id, dedupe_hash) DO NOTHING`,
          params,
        );

        const afterCount = (
          await db.select<Array<{ count: number }>>(
            "SELECT COUNT(*) as count FROM finance_transactions WHERE import_batch_id = $1",
            [batchId],
          )
        )[0].count;

        const insertedThisChunk = afterCount - beforeCount;
        imported += insertedThisChunk;
        duplicates += chunk.length - insertedThisChunk;
      }

      // Near-duplicate pass: compare this batch's newly inserted rows against
      // everything else in the same accounts (excluding this batch itself).
      const insertedRows = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions WHERE import_batch_id = $1",
        [batchId],
      );
      const accountIds = [...new Set(insertedRows.map((row) => row.account_id))];
      const existingCandidates: TransactionRow[] =
        accountIds.length > 0
          ? await db.select<TransactionRow[]>(
              `SELECT * FROM finance_transactions
               WHERE (import_batch_id IS NULL OR import_batch_id != $1)
                 AND account_id IN (${accountIds.map((_, index) => `$${index + 2}`).join(",")})`,
              [batchId, ...accountIds],
            )
          : [];

      const nearDuplicateMatches = findNearDuplicates(
        insertedRows.map((row) => ({
          id: row.id,
          accountId: row.account_id,
          postedDate: row.posted_date,
          amountMinor: row.amount_minor,
          descriptionRaw: row.description_raw,
        })),
        existingCandidates.map((row) => ({
          id: row.id,
          accountId: row.account_id,
          postedDate: row.posted_date,
          amountMinor: row.amount_minor,
          descriptionRaw: row.description_raw,
        })),
      );

      if (nearDuplicateMatches.length > 0) {
        warnings.push(
          `${nearDuplicateMatches.length} transaction(s) look like a near-duplicate of an existing row (pending/posted drift) and were kept for review.`,
        );
      }

      // Transfer detection across the whole history, not just this batch.
      const accountOnBudgetByAccountId = new Map<string, boolean>();
      const allAccounts = await db.select<Array<{ id: string; on_budget: number }>>(
        "SELECT id, on_budget FROM finance_accounts",
      );
      for (const account of allAccounts) {
        accountOnBudgetByAccountId.set(account.id, Boolean(account.on_budget));
      }

      const allTransactions = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions",
      );
      // A user-categorized row is never re-categorized by any automatic stage, including
      // transfer detection — exclude it from the candidate set entirely so it can neither be
      // paired nor relabeled (see specs/done/finance.md "Classification order").
      const candidates: TransferCandidateTransaction[] = allTransactions
        .filter((row) => row.category_source !== "user")
        .map((row) => ({
          id: row.id,
          accountId: row.account_id,
          amountMinor: row.amount_minor,
          currency: row.currency,
          postedDate: row.posted_date,
          descriptionRaw: row.description_raw,
          isTransfer: Boolean(row.is_transfer),
          excludedFromBudget: Boolean(row.excluded_from_budget),
          accountOnBudget: accountOnBudgetByAccountId.get(row.account_id) ?? true,
        }));

      const transferActions = detectTransfers(candidates);
      let transfersDetected = 0;
      let pendingSuggestions = 0;

      for (const action of transferActions) {
        if (action.type === "matched_pair") {
          transfersDetected += 1;
          for (const leg of [action.legA, action.legB]) {
            await db.execute(
              `UPDATE finance_transactions SET
                is_transfer = 1,
                transfer_group_id = $2,
                category_id = $3,
                category_source = $4,
                excluded_from_budget = $5,
                updated_at = $6
              WHERE id = $1`,
              [
                leg.transactionId,
                action.transferGroupId,
                leg.outcome.categoryId,
                leg.outcome.categorySource,
                leg.outcome.excludedFromBudget ? 1 : 0,
                now,
              ],
            );
            if (leg.outcome.pendingSuggestion) {
              pendingSuggestions += 1;
              await this.insertPendingSuggestionWithDb(db, {
                transactionId: leg.transactionId,
                suggestedCategoryId: leg.outcome.categoryId,
                origin: "memory",
                now,
              });
            }
          }
        } else {
          await db.execute(
            `UPDATE finance_transactions SET
              is_transfer = 1,
              category_id = $2,
              category_source = $3,
              excluded_from_budget = $4,
              updated_at = $5
            WHERE id = $1`,
            [
              action.transactionId,
              action.outcome.categoryId,
              action.outcome.categorySource,
              action.outcome.excludedFromBudget ? 1 : 0,
              now,
            ],
          );
          if (action.outcome.pendingSuggestion) {
            pendingSuggestions += 1;
            await this.insertPendingSuggestionWithDb(db, {
              transactionId: action.transactionId,
              suggestedCategoryId: action.outcome.categoryId,
              origin: "memory",
              now,
            });
          }
        }
      }

      // Classification (rules -> learned memory -> seed heuristics; no AI —
      // see specs/done/finance.md "Classification pipeline"). Only the rows
      // this batch inserted that transfer detection left untouched are
      // eligible; transfer detection already decided a final category for
      // the rest.
      const classificationRules = await this.listRules();
      const classificationMemory = await this.listMerchantMemory();
      const dismissed = await this.buildDismissedPairsWithDb(db);
      const today = getTodayDate();
      const insertedForClassification = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions WHERE import_batch_id = $1 AND is_transfer = 0",
        [batchId],
      );
      for (const row of insertedForClassification) {
        const outcome = classifyTransaction(
          {
            categoryId: row.category_id,
            categorySource: row.category_source,
            accountId: row.account_id,
            amountMinor: row.amount_minor,
            merchantKey: row.merchant_key,
            personId: row.person_id,
          },
          {
            rules: classificationRules,
            memory: classificationMemory,
            dismissed,
            today,
          },
        );
        const { suggestionCreated } = await this.applyClassificationOutcomeWithDb(
          db,
          row.id,
          outcome,
          now,
        );
        if (suggestionCreated) {
          pendingSuggestions += 1;
        }
      }

      // Recurring-bill detection runs after every import, over the whole
      // history, inside the same transaction — see specs/done/finance.md
      // "Recurring bills".
      await this.detectRecurringSeriesWithDb(db, today);

      const skipped = 0;
      const errors = 0;

      await db.execute(
        `UPDATE finance_import_batches SET
          imported_count = $2,
          duplicate_count = $3,
          skipped_count = $4,
          error_count = $5,
          status = 'completed',
          finished_at = $6
        WHERE id = $1`,
        [batchId, imported, duplicates, skipped, errors, now],
      );

      await db.execute("COMMIT");

      return {
        batchId,
        rowCount: input.rows.length,
        imported,
        duplicates,
        skipped,
        errors,
        newAccounts: 0,
        transfersDetected,
        pendingSuggestions,
        warnings,
        nearDuplicates: nearDuplicateMatches.map((match) => ({
          transactionId: match.candidateId,
          existingTransactionId: match.existingId,
          similarity: match.similarity,
          dateDiffDays: match.dateDiffDays,
        })),
      };
    } catch (error) {
      await this.rollbackQuietly(db);
      throw error;
    }
  }

  private async insertPendingSuggestionWithDb(
    db: Database,
    input: {
      transactionId: string;
      suggestedCategoryId: string;
      origin: "memory" | "seed" | "ai";
      now: string;
      confidence?: number;
    },
  ): Promise<boolean> {
    const txnRows = await db.select<Array<{ merchant_key: string }>>(
      "SELECT merchant_key FROM finance_transactions WHERE id = $1",
      [input.transactionId],
    );
    const merchantKey = txnRows[0]?.merchant_key ?? "";
    const existingPending = await db.select<Array<{ id: string }>>(
      "SELECT id FROM finance_category_suggestions WHERE transaction_id = $1 AND status = 'pending'",
      [input.transactionId],
    );
    if (existingPending.length > 0) {
      return false;
    }
    await db.execute(
      `INSERT INTO finance_category_suggestions (
        id, transaction_id, merchant_key, suggested_category_id, confidence, origin, rationale,
        model, prompt_version, status, decided_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,'pending',NULL,$7)`,
      [
        createEntityId("finance-suggestion"),
        input.transactionId,
        merchantKey,
        input.suggestedCategoryId,
        input.confidence ?? 0.5,
        input.origin,
        input.now,
      ],
    );
    return true;
  }

  /** `finance_category_suggestions` rows with `status = 'dismissed'`, as the pure 90-day window input. */
  private async buildDismissedPairsWithDb(db: Database): Promise<DismissedSuggestionPair[]> {
    const rows = await db.select<
      Array<{
        merchant_key: string;
        suggested_category_id: string;
        decided_at: string | null;
        created_at: string;
      }>
    >(
      "SELECT merchant_key, suggested_category_id, decided_at, created_at FROM finance_category_suggestions WHERE status = 'dismissed'",
    );
    return rows.map((row) => ({
      merchantKey: row.merchant_key,
      categoryId: row.suggested_category_id,
      dismissedAt: row.decided_at ?? row.created_at,
    }));
  }

  /** Applies every side-effect action from matching rules besides the category decision itself. */
  private applyRuleActionsSql(
    row: TransactionRow,
    actions: FinanceRuleActions | null | undefined,
  ): {
    merchantDisplay: string | null;
    personId: string | null;
    excludedFromBudget: boolean;
    excludedFromReports: boolean;
    isTransfer: boolean;
    labelsJson: string | null;
  } {
    if (!actions) {
      return {
        merchantDisplay: row.merchant_display,
        personId: row.person_id,
        excludedFromBudget: Boolean(row.excluded_from_budget),
        excludedFromReports: Boolean(row.excluded_from_reports),
        isTransfer: Boolean(row.is_transfer),
        labelsJson: row.labels_json,
      };
    }
    let labelsJson = row.labels_json;
    if (actions.addLabels && actions.addLabels.length > 0) {
      const existing: string[] = labelsJson ? JSON.parse(labelsJson) : [];
      labelsJson = JSON.stringify([...new Set([...existing, ...actions.addLabels])]);
    }
    return {
      merchantDisplay: actions.merchantDisplay ?? row.merchant_display,
      personId: actions.personId ?? row.person_id,
      excludedFromBudget: actions.excludeFromBudget ?? Boolean(row.excluded_from_budget),
      excludedFromReports: actions.excludeFromReports ?? Boolean(row.excluded_from_reports),
      isTransfer: actions.markTransfer ?? Boolean(row.is_transfer),
      labelsJson,
    };
  }

  /** Writes a `ClassificationOutcome` to the transaction (and a suggestion when owed). */
  private async applyClassificationOutcomeWithDb(
    db: Database,
    transactionId: string,
    outcome: ClassificationOutcome,
    now: string,
  ): Promise<{ suggestionCreated: boolean; categoryChanged: boolean }> {
    const rows = await db.select<TransactionRow[]>(
      "SELECT * FROM finance_transactions WHERE id = $1",
      [transactionId],
    );
    const row = rows[0];
    if (!row) {
      return { suggestionCreated: false, categoryChanged: false };
    }
    const actions = this.applyRuleActionsSql(row, outcome.ruleActions);
    // A "default" outcome means this pass only produced a suggestion, not a
    // category decision (stages 2-5 all failed to decide). If the row
    // already carries a real category — including one written by an
    // `all_matching` backfill, which keeps the backfilled row's original
    // `category_source` (see `setTransactionCategory`) — reclassification
    // must not reset it back to Uncategorized; only the suggestion is new.
    const keepExistingCategory =
      outcome.categorySource === "default" &&
      row.category_id !== null &&
      row.category_id !== UNCATEGORIZED_CATEGORY_ID;
    const finalCategoryId = keepExistingCategory ? row.category_id : outcome.categoryId;
    const finalCategorySource = keepExistingCategory ? row.category_source : outcome.categorySource;
    const finalCategoryConfidence = keepExistingCategory
      ? row.category_confidence
      : outcome.categoryConfidence;
    const categoryChanged =
      !keepExistingCategory &&
      (row.category_id !== outcome.categoryId || row.category_source !== outcome.categorySource);
    await db.execute(
      `UPDATE finance_transactions SET
        category_id = $2, category_source = $3, category_confidence = $4,
        categorized_at = CASE WHEN $5 = 1 THEN $6 ELSE categorized_at END,
        merchant_display = $7, person_id = $8, excluded_from_budget = $9,
        excluded_from_reports = $10, is_transfer = $11, labels_json = $12, updated_at = $6
      WHERE id = $1`,
      [
        transactionId,
        finalCategoryId,
        finalCategorySource,
        finalCategoryConfidence,
        categoryChanged && outcome.categorySource !== "default" ? 1 : 0,
        now,
        actions.merchantDisplay,
        actions.personId,
        actions.excludedFromBudget ? 1 : 0,
        actions.excludedFromReports ? 1 : 0,
        actions.isTransfer ? 1 : 0,
        actions.labelsJson,
      ],
    );
    if (outcome.matchedRule) {
      await db.execute(
        "UPDATE finance_rules SET applied_count = applied_count + 1, last_applied_at = $2 WHERE id = $1",
        [outcome.matchedRule.id, now],
      );
    }
    const suggestionCreated = outcome.suggestion
      ? await this.insertPendingSuggestionWithDb(db, {
          transactionId,
          suggestedCategoryId: outcome.suggestion.categoryId,
          origin: outcome.suggestion.origin,
          confidence: outcome.suggestion.confidence,
          now,
        })
      : false;
    return { suggestionCreated, categoryChanged };
  }

  /**
   * Re-runs classification (rules, memory, seeds — no AI, no transfer
   * re-detection) over every non-`user` transaction. Used after a rule is
   * created/edited and by the "Réappliquer les règles" action on
   * `/finances/review`. One `runExclusive` block / one `BEGIN IMMEDIATE`.
   */
  async reclassifyPending(): Promise<ReclassifyFinancePendingResult> {
    const db = await this.getDb();
    const now = nowIso();
    const today = getTodayDate();

    await db.execute("BEGIN IMMEDIATE");
    try {
      const rules = await this.listRules();
      const memory = await this.listMerchantMemory();
      const dismissed = await this.buildDismissedPairsWithDb(db);

      const rows = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions WHERE category_source != 'user' AND is_transfer = 0",
      );

      let reclassified = 0;
      let suggestionsCreated = 0;

      for (const row of rows) {
        const outcome = classifyTransaction(
          {
            categoryId: row.category_id,
            categorySource: row.category_source,
            accountId: row.account_id,
            amountMinor: row.amount_minor,
            merchantKey: row.merchant_key,
            personId: row.person_id,
          },
          { rules, memory, dismissed, today },
        );
        const { suggestionCreated, categoryChanged } = await this.applyClassificationOutcomeWithDb(
          db,
          row.id,
          outcome,
          now,
        );
        if (suggestionCreated) {
          suggestionsCreated += 1;
        }
        if (categoryChanged) {
          reclassified += 1;
        }
      }

      await db.execute("COMMIT");
      return { reclassified, suggestionsCreated };
    } catch (error) {
      await this.rollbackQuietly(db);
      throw error;
    }
  }

  // --- AI categorization (Phase 8) ---------------------------------------------------

  /** Most frequent value in `values`; ties resolve to whichever value sorts first. */
  private static modeOf<T extends string | number>(values: T[], fallback: T): T {
    if (values.length === 0) {
      return fallback;
    }
    const counts = new Map<T, number>();
    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best = fallback;
    let bestCount = -1;
    for (const [value, count] of [...counts.entries()].sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])),
    )) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }

  /** Median of absolute values, integer-only (no float division). */
  private static medianAbs(values: number[]): number {
    const sorted = [...values].map((value) => Math.abs(value)).sort((a, b) => a - b);
    if (sorted.length === 0) {
      return 0;
    }
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * Merchant-level groups of currently unknown transactions — see
   * `FinanceUnknownMerchantGroup` and specs/done/finance.md "AI stage". Plain read, no
   * `BEGIN IMMEDIATE` — safe to call outside any exclusive block, which is what lets the
   * caller run the AI request between this call and `applyCategorizationResults` without
   * holding the writer slot across the network round-trip.
   */
  async listUnknownMerchants(limit = 40): Promise<FinanceUnknownMerchantGroup[]> {
    const db = await this.getDb();
    const pendingRows = await db.select<Array<{ transaction_id: string }>>(
      "SELECT transaction_id FROM finance_category_suggestions WHERE status = 'pending'",
    );
    const pendingTransactionIds = new Set(pendingRows.map((row) => row.transaction_id));

    const rows = await db.select<TransactionRow[]>(
      `SELECT * FROM finance_transactions
       WHERE category_source != 'user' AND is_transfer = 0 AND category_id = $1`,
      [UNCATEGORIZED_CATEGORY_ID],
    );
    const eligible = rows.filter((row) => !pendingTransactionIds.has(row.id));

    const accountRows = await db.select<Array<{ id: string; type: FinanceAccountType }>>(
      "SELECT id, type FROM finance_accounts",
    );
    const accountTypeById = new Map(accountRows.map((row) => [row.id, row.type]));

    const groups = new Map<string, TransactionRow[]>();
    for (const row of eligible) {
      const bucket = groups.get(row.merchant_key);
      if (bucket) {
        bucket.push(row);
      } else {
        groups.set(row.merchant_key, [row]);
      }
    }

    const result: FinanceUnknownMerchantGroup[] = [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([merchantKey, txns]) => ({
        merchantKey,
        sign: FinanceSqliteStore.modeOf(
          txns.map((txn): -1 | 0 | 1 => (txn.amount_minor > 0 ? 1 : txn.amount_minor < 0 ? -1 : 0)),
          0,
        ),
        occurrenceCount: txns.length,
        amountMinorSample: FinanceSqliteStore.medianAbs(txns.map((txn) => txn.amount_minor)),
        accountType: FinanceSqliteStore.modeOf(
          txns.map((txn): FinanceAccountType => accountTypeById.get(txn.account_id) ?? "other"),
          "other",
        ),
        transactionIds: txns.map((txn) => txn.id),
      }));

    return result.slice(0, limit);
  }

  /**
   * Applies AI categorization results — see `ApplyFinanceCategorizationResultsInput` and
   * specs/done/finance.md "AI stage". One `runExclusive` block / one `BEGIN IMMEDIATE`, called
   * only after the AI request itself has already completed (see `listUnknownMerchants`).
   */
  async applyCategorizationResults(
    input: ApplyFinanceCategorizationResultsInput,
  ): Promise<ApplyFinanceCategorizationResultsOutcome> {
    const db = await this.getDb();
    const now = nowIso();
    const today = input.today ?? getTodayDate();

    await db.execute("BEGIN IMMEDIATE");
    try {
      const dismissed = await this.buildDismissedPairsWithDb(db);

      let suggestionsCreated = 0;
      let autoApplied = 0;
      let suppressedDismissed = 0;

      for (const result of input.results) {
        const originalKeys = input.merchantKeyMap[result.merchantKey] ?? [result.merchantKey];
        for (const merchantKey of originalKeys) {
          if (isSuggestionDismissed(dismissed, merchantKey, result.categoryId, today)) {
            suppressedDismissed += 1;
            continue;
          }

          const targets = await db.select<TransactionRow[]>(
            `SELECT * FROM finance_transactions
             WHERE merchant_key = $1 AND category_source != 'user' AND is_transfer = 0
               AND category_id = $2`,
            [merchantKey, UNCATEGORIZED_CATEGORY_ID],
          );

          for (const txn of targets) {
            const autoApply = input.autoApply && result.confidence >= input.autoApplyMinConfidence;

            await db.execute(
              "DELETE FROM finance_category_suggestions WHERE transaction_id = $1 AND status = 'pending'",
              [txn.id],
            );

            await db.execute(
              `INSERT INTO finance_category_suggestions (
                id, transaction_id, merchant_key, suggested_category_id, confidence, origin,
                rationale, model, prompt_version, status, decided_at, created_at
              ) VALUES ($1,$2,$3,$4,$5,'ai',$6,$7,$8,$9,$10,$11)`,
              [
                createEntityId("finance-suggestion"),
                txn.id,
                merchantKey,
                result.categoryId,
                result.confidence,
                result.rationale,
                input.model,
                input.promptVersion,
                autoApply ? "accepted" : "pending",
                autoApply ? now : null,
                now,
              ],
            );
            suggestionsCreated += 1;

            if (autoApply) {
              await db.execute(
                `UPDATE finance_transactions SET
                  category_id = $2, category_source = 'ai', category_confidence = $3,
                  categorized_at = $4, updated_at = $4
                WHERE id = $1`,
                [txn.id, result.categoryId, result.confidence, now],
              );
              autoApplied += 1;
            }
          }
        }
      }

      await db.execute("COMMIT");
      return { suggestionsCreated, autoApplied, suppressedDismissed };
    } catch (error) {
      await this.rollbackQuietly(db);
      throw error;
    }
  }

  /**
   * Restricted to the most recent batch for the batch's account (see
   * specs/done/finance.md "Overlapping exports"). One `runExclusive` block at
   * the repository level; this method issues its own `BEGIN IMMEDIATE`/`COMMIT`.
   */
  async undoImportBatch(batchId: string): Promise<UndoFinanceImportBatchResult> {
    const db = await this.getDb();
    const now = nowIso();

    await db.execute("BEGIN IMMEDIATE");
    try {
      const batchRows = await db.select<ImportBatchRow[]>(
        "SELECT * FROM finance_import_batches WHERE id = $1",
        [batchId],
      );
      const batch = batchRows[0];
      if (!batch) {
        throw new Error(`finance import batch not found: ${batchId}`);
      }

      const mostRecentRows = await db.select<Array<{ id: string }>>(
        `SELECT id FROM finance_import_batches
         WHERE account_id = $1
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
        [batch.account_id],
      );
      if (mostRecentRows[0]?.id !== batchId) {
        throw new Error(
          `undoFinanceImportBatch is restricted to the most recent batch for account ${batch.account_id}`,
        );
      }

      const batchTransactionRows = await db.select<TransactionRow[]>(
        "SELECT * FROM finance_transactions WHERE import_batch_id = $1",
        [batchId],
      );

      let deleted = 0;
      let refusedUserCategorized = 0;

      for (const row of batchTransactionRows) {
        if (row.category_source === "user") {
          refusedUserCategorized += 1;
          continue;
        }

        await db.execute("DELETE FROM finance_transaction_splits WHERE transaction_id = $1", [
          row.id,
        ]);
        await db.execute("DELETE FROM finance_category_suggestions WHERE transaction_id = $1", [
          row.id,
        ]);

        if (row.transfer_group_id) {
          const partnerRows = await db.select<TransactionRow[]>(
            "SELECT * FROM finance_transactions WHERE transfer_group_id = $1 AND id != $2",
            [row.transfer_group_id, row.id],
          );
          for (const partner of partnerRows) {
            await db.execute(
              `UPDATE finance_transactions SET
                is_transfer = 0,
                transfer_group_id = NULL,
                category_id = 'fincat:non-categorise',
                category_source = 'default',
                excluded_from_budget = 0,
                updated_at = $2
              WHERE id = $1`,
              [partner.id, now],
            );
            // A partial unique index allows only one pending suggestion per transaction; clear
            // any stale one before restoring the pending suggestion this repair implies.
            await db.execute(
              "DELETE FROM finance_category_suggestions WHERE transaction_id = $1 AND status = 'pending'",
              [partner.id],
            );
            await db.execute(
              `INSERT INTO finance_category_suggestions (
                id, transaction_id, merchant_key, suggested_category_id, confidence, origin,
                rationale, model, prompt_version, status, decided_at, created_at
              ) VALUES ($1,$2,$3,'fincat:non-categorise',0.5,'memory',NULL,NULL,NULL,'pending',NULL,$4)`,
              [createEntityId("finance-suggestion"), partner.id, partner.merchant_key, now],
            );
          }
        }

        await db.execute("DELETE FROM finance_transactions WHERE id = $1", [row.id]);
        deleted += 1;
      }

      await db.execute("COMMIT");
      return { deleted, refusedUserCategorized };
    } catch (error) {
      await this.rollbackQuietly(db);
      throw error;
    }
  }

  // --- category suggestions -------------------------------------------------------------

  async listCategorySuggestions(
    status?: FinanceCategorySuggestion["status"],
    limit?: number,
  ): Promise<FinanceCategorySuggestion[]> {
    const db = await this.getDb();
    const rows = await db.select<SuggestionRow[]>(
      "SELECT * FROM finance_category_suggestions ORDER BY created_at DESC",
    );
    let suggestions = rows.map(mapSuggestion);
    if (status) {
      suggestions = suggestions.filter((suggestion) => suggestion.status === status);
    }
    return limit !== undefined ? suggestions.slice(0, limit) : suggestions;
  }

  async saveCategorySuggestions(
    suggestions: FinanceCategorySuggestion[],
  ): Promise<FinanceCategorySuggestion[]> {
    const db = await this.getDb();
    const now = nowIso();
    const saved: FinanceCategorySuggestion[] = [];
    for (const suggestion of suggestions) {
      const id = suggestion.id || createEntityId("finance-suggestion");
      await db.execute(
        `INSERT INTO finance_category_suggestions (
          id, transaction_id, merchant_key, suggested_category_id, confidence, origin, rationale,
          model, prompt_version, status, decided_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(id) DO UPDATE SET
          suggested_category_id = excluded.suggested_category_id,
          confidence = excluded.confidence,
          rationale = excluded.rationale,
          status = excluded.status,
          decided_at = excluded.decided_at`,
        [
          id,
          suggestion.transactionId,
          suggestion.merchantKey,
          suggestion.suggestedCategoryId,
          suggestion.confidence,
          suggestion.origin,
          suggestion.rationale,
          suggestion.model,
          suggestion.promptVersion,
          suggestion.status,
          suggestion.decidedAt,
          suggestion.createdAt || now,
        ],
      );
      const rows = await db.select<SuggestionRow[]>(
        "SELECT * FROM finance_category_suggestions WHERE id = $1",
        [id],
      );
      saved.push(mapSuggestion(rows[0]));
    }
    return saved;
  }

  async decideCategorySuggestion(
    id: string,
    decision: DecideFinanceCategorySuggestionInput,
  ): Promise<FinanceCategorySuggestion> {
    const db = await this.getDb();
    const now = nowIso();

    const beforeRows = await db.select<SuggestionRow[]>(
      "SELECT * FROM finance_category_suggestions WHERE id = $1",
      [id],
    );
    const before = beforeRows[0];
    if (!before) {
      throw new Error(`finance category suggestion not found: ${id}`);
    }

    await db.execute(
      "UPDATE finance_category_suggestions SET status = $2, decided_at = $3 WHERE id = $1",
      [id, decision.status, now],
    );

    if (decision.status === "accepted" || decision.status === "corrected") {
      await this.setTransactionCategory({
        transactionId: before.transaction_id,
        categoryId: decision.categoryId ?? before.suggested_category_id,
        scope: "this",
      });
    }

    return mapSuggestion({ ...before, status: decision.status, decided_at: now });
  }

  // --- budget (Phase 5) -------------------------------------------------------------

  async getBudgetMonth(monthKey: string): Promise<FinanceBudgetMonth> {
    const db = await this.getDb();
    const rows = await db.select<BudgetMonthRow[]>(
      "SELECT * FROM finance_budget_months WHERE month_key = $1",
      [monthKey],
    );
    if (rows[0]) {
      return mapBudgetMonth(rows[0]);
    }
    return { monthKey, readyToAssignNote: null, closedAt: null, updatedAt: "" };
  }

  async listBudgetEntries(): Promise<FinanceBudgetEntry[]> {
    const db = await this.getDb();
    const rows = await db.select<BudgetEntryRow[]>(
      "SELECT * FROM finance_budget_entries ORDER BY month_key, category_id",
    );
    return rows.map(mapBudgetEntry);
  }

  /** Rejects `kind = "income"` categories; assigning `0` deletes the row. */
  async setBudgetAssignment(
    monthKey: string,
    categoryId: string,
    assignedMinor: number,
  ): Promise<FinanceBudgetEntry | null> {
    const db = await this.getDb();
    const categoryRows = await db.select<CategoryRow[]>(
      "SELECT * FROM finance_categories WHERE id = $1",
      [categoryId],
    );
    const category = categoryRows[0];
    if (!category) {
      throw new Error(`finance category not found: ${categoryId}`);
    }
    assertFinanceCategoryAssignable(mapCategory(category));

    if (assignedMinor === 0) {
      await db.execute(
        "DELETE FROM finance_budget_entries WHERE month_key = $1 AND category_id = $2",
        [monthKey, categoryId],
      );
      return null;
    }

    const now = nowIso();
    const existingRows = await db.select<BudgetEntryRow[]>(
      "SELECT * FROM finance_budget_entries WHERE month_key = $1 AND category_id = $2",
      [monthKey, categoryId],
    );
    const policy = existingRows[0]?.overspend_policy ?? "reduce_next_ready_to_assign";
    const note = existingRows[0]?.note ?? null;

    await db.execute(
      `INSERT INTO finance_budget_entries (
        month_key, category_id, assigned_minor, overspend_policy, note, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(month_key, category_id) DO UPDATE SET
        assigned_minor = excluded.assigned_minor,
        updated_at = excluded.updated_at`,
      [monthKey, categoryId, assignedMinor, policy, note, now],
    );

    const rows = await db.select<BudgetEntryRow[]>(
      "SELECT * FROM finance_budget_entries WHERE month_key = $1 AND category_id = $2",
      [monthKey, categoryId],
    );
    return mapBudgetEntry(rows[0]);
  }

  /**
   * Writes the policy on the `(monthKey, categoryId)` entry — creating it with
   * `assigned_minor = 0` if it does not exist yet, so the policy has somewhere
   * to live — and on every *already-existing* later entry for that category;
   * it never creates a future entry just to carry the policy forward (`carryIn`
   * reads whatever policy the previous month's entry has, defaulting when absent).
   */
  async setCategoryOverspendPolicy(
    monthKey: string,
    categoryId: string,
    policy: FinanceOverspendPolicy,
  ): Promise<void> {
    const db = await this.getDb();
    const now = nowIso();

    const existingRows = await db.select<BudgetEntryRow[]>(
      "SELECT * FROM finance_budget_entries WHERE month_key = $1 AND category_id = $2",
      [monthKey, categoryId],
    );
    if (existingRows[0]) {
      await db.execute(
        "UPDATE finance_budget_entries SET overspend_policy = $3, updated_at = $4 WHERE month_key = $1 AND category_id = $2",
        [monthKey, categoryId, policy, now],
      );
    } else {
      await db.execute(
        `INSERT INTO finance_budget_entries (
          month_key, category_id, assigned_minor, overspend_policy, note, updated_at
        ) VALUES ($1,$2,0,$3,NULL,$4)`,
        [monthKey, categoryId, policy, now],
      );
    }

    await db.execute(
      "UPDATE finance_budget_entries SET overspend_policy = $3, updated_at = $4 WHERE category_id = $1 AND month_key > $2",
      [categoryId, monthKey, policy, now],
    );
  }

  async setBudgetMonthClosed(monthKey: string, closed: boolean): Promise<FinanceBudgetMonth> {
    const db = await this.getDb();
    const now = nowIso();
    const existing = await this.getBudgetMonth(monthKey);
    await db.execute(
      `INSERT INTO finance_budget_months (month_key, ready_to_assign_note, closed_at, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(month_key) DO UPDATE SET
         closed_at = excluded.closed_at,
         updated_at = excluded.updated_at`,
      [monthKey, existing.readyToAssignNote, closed ? now : null, now],
    );
    return this.getBudgetMonth(monthKey);
  }

  async setBudgetReadyToAssignNote(
    monthKey: string,
    note: string | null,
  ): Promise<FinanceBudgetMonth> {
    const db = await this.getDb();
    const now = nowIso();
    const existing = await this.getBudgetMonth(monthKey);
    await db.execute(
      `INSERT INTO finance_budget_months (month_key, ready_to_assign_note, closed_at, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(month_key) DO UPDATE SET
         ready_to_assign_note = excluded.ready_to_assign_note,
         updated_at = excluded.updated_at`,
      [monthKey, note, existing.closedAt, now],
    );
    return this.getBudgetMonth(monthKey);
  }

  /**
   * Loads the input shape `computeFinanceBudgetState` (and the other budget
   * pure functions) need: on-budget, non-excluded transactions (splits
   * expanded) through the end of `monthKey` for per-category `activity`;
   * **every** on-budget transaction through the end of `monthKey`,
   * regardless of `excluded_from_budget`, for `onBudgetBalance` (see
   * `balanceTransactions` on `FinanceBudgetComputationInput`); every budget
   * entry; and every category. See specs/done/finance.md "Computation shape".
   */
  private async buildBudgetComputationInput(
    monthKey: string,
  ): Promise<FinanceBudgetComputationInput> {
    const db = await this.getDb();
    const monthEnd = getMonthEndDate(monthKey);

    const accounts = (await this.listAccounts({ includeClosed: true })).filter(
      (account) => account.onBudget,
    );
    const onBudgetAccountIds = accounts.map((account) => account.id);
    const accountPlaceholders = onBudgetAccountIds.map((_, i) => `$${i + 2}`).join(",");

    const transactionRows =
      onBudgetAccountIds.length > 0
        ? await db.select<TransactionRow[]>(
            `SELECT * FROM finance_transactions
             WHERE excluded_from_budget = 0 AND posted_date <= $1
               AND account_id IN (${accountPlaceholders})`,
            [monthEnd, ...onBudgetAccountIds],
          )
        : [];

    const balanceTransactionRows =
      onBudgetAccountIds.length > 0
        ? await db.select<TransactionRow[]>(
            `SELECT * FROM finance_transactions
             WHERE posted_date <= $1 AND account_id IN (${accountPlaceholders})`,
            [monthEnd, ...onBudgetAccountIds],
          )
        : [];

    const splitTransactionIds = transactionRows
      .filter((row) => row.has_splits)
      .map((row) => row.id);
    const splitRows =
      splitTransactionIds.length > 0
        ? await db.select<SplitRow[]>(
            `SELECT * FROM finance_transaction_splits
             WHERE transaction_id IN (${splitTransactionIds.map((_, i) => `$${i + 1}`).join(",")})`,
            splitTransactionIds,
          )
        : [];

    const categories = await this.listCategories(true);
    const entries = await this.listBudgetEntries();

    return {
      monthKey,
      accounts: accounts.map((account) => ({
        id: account.id,
        onBudget: account.onBudget,
        openingBalanceMinor: account.openingBalanceMinor,
      })),
      transactions: transactionRows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
        categoryId: row.category_id,
        hasSplits: Boolean(row.has_splits),
      })),
      balanceTransactions: balanceTransactionRows.map((row) => ({
        accountId: row.account_id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
      })),
      splits: splitRows.map((row) => ({
        transactionId: row.transaction_id,
        amountMinor: row.amount_minor,
        categoryId: row.category_id,
      })),
      entries,
      categories: categories.map((category) => ({
        id: category.id,
        kind: category.kind,
        defersToNextMonth: category.defersToNextMonth,
      })),
    };
  }

  async computeBudgetState(monthKey: string): Promise<FinanceBudgetState> {
    const input = await this.buildBudgetComputationInput(monthKey);
    return computeFinanceBudgetState(input);
  }

  /** Delegates to the pure `computeCoverOverspending` — see `AppRepository.computeFinanceCoverOverspending`. */
  async computeCoverOverspending(
    monthKey: string,
    fromCategoryId: string,
    toCategoryId: string,
  ): Promise<CoverOverspendingResult> {
    const input = await this.buildBudgetComputationInput(monthKey);
    return computeCoverOverspending(fromCategoryId, toCategoryId, monthKey, input);
  }

  private async rollbackQuietly(db: Database): Promise<void> {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // Best effort; the original error is what the caller surfaces.
    }
  }

  // --- net worth / cash flow / reports / recurring (Phase 6) -----------------------------

  /**
   * Every transaction on every account regardless of `excluded_from_budget`/
   * `excluded_from_reports`/`on_budget` — the net-worth balance rule (see
   * AGENTS.md "Repository parity"). Mirrors `FinanceMemoryStore`'s loader.
   */
  private async buildNetWorthComputationInput(
    asOfDate: string,
    baseCurrency: string,
  ): Promise<FinanceNetWorthComputationInput> {
    const db = await this.getDb();
    const accountRows = await db.select<AccountRow[]>("SELECT * FROM finance_accounts");
    const transactionRows = await db.select<TransactionRow[]>(
      "SELECT account_id, posted_date, amount_minor FROM finance_transactions WHERE posted_date <= $1",
      [asOfDate],
    );
    return {
      asOfDate,
      baseCurrency,
      accounts: accountRows.map((row) => ({
        id: row.id,
        type: row.type,
        currency: row.currency,
        closed: Boolean(row.closed),
        openingBalanceMinor: row.opening_balance_minor,
      })),
      transactions: transactionRows.map((row) => ({
        accountId: row.account_id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
      })),
    };
  }

  async computeNetWorth(asOfDate: string, baseCurrency: string): Promise<FinanceNetWorthSnapshot> {
    return computeFinanceNetWorth(await this.buildNetWorthComputationInput(asOfDate, baseCurrency));
  }

  async listNetWorthHistory(baseCurrency: string): Promise<FinanceNetWorthHistoryPoint[]> {
    const db = await this.getDb();
    const snapshotRows = await db.select<BalanceSnapshotRow[]>(
      "SELECT * FROM finance_account_balance_snapshots",
    );
    const accountRows = await db.select<AccountRow[]>("SELECT * FROM finance_accounts");
    return buildFinanceNetWorthHistory(
      snapshotRows.map(mapBalanceSnapshot),
      accountRows.map((row) => ({
        id: row.id,
        type: row.type,
        currency: row.currency,
        closed: Boolean(row.closed),
        openingBalanceMinor: row.opening_balance_minor,
      })),
      baseCurrency,
    );
  }

  private async buildCashFlowComputationInput(
    monthKey: string,
    baseCurrency: string,
  ): Promise<FinanceCashFlowComputationInput> {
    const db = await this.getDb();
    const transactionRows = await db.select<TransactionRow[]>("SELECT * FROM finance_transactions");
    const splitRows = await db.select<SplitRow[]>("SELECT * FROM finance_transaction_splits");
    return {
      monthKey,
      baseCurrency,
      transactions: transactionRows.map((row) => ({
        id: row.id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
        currency: row.currency,
        isTransfer: Boolean(row.is_transfer),
        excludedFromReports: Boolean(row.excluded_from_reports),
        hasSplits: Boolean(row.has_splits),
      })),
      splits: splitRows.map((row) => ({
        transactionId: row.transaction_id,
        amountMinor: row.amount_minor,
      })),
    };
  }

  async computeCashFlow(monthKey: string, baseCurrency: string): Promise<FinanceCashFlowSummary> {
    return computeFinanceCashFlow(await this.buildCashFlowComputationInput(monthKey, baseCurrency));
  }

  private async buildReportComputationInput(
    baseCurrency: string,
  ): Promise<FinanceReportComputationInput> {
    const db = await this.getDb();
    const transactionRows = await db.select<TransactionRow[]>("SELECT * FROM finance_transactions");
    const splitRows = await db.select<SplitRow[]>("SELECT * FROM finance_transaction_splits");
    const categoryRows = await db.select<CategoryRow[]>("SELECT * FROM finance_categories");
    return {
      baseCurrency,
      transactions: transactionRows.map((row) => ({
        id: row.id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
        currency: row.currency,
        categoryId: row.category_id,
        merchantKey: row.merchant_key,
        merchantDisplay: row.merchant_display,
        personId: row.person_id,
        isTransfer: Boolean(row.is_transfer),
        excludedFromReports: Boolean(row.excluded_from_reports),
        hasSplits: Boolean(row.has_splits),
      })),
      splits: splitRows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        amountMinor: row.amount_minor,
        categoryId: row.category_id,
      })),
      categories: categoryRows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        name: row.name,
      })),
    };
  }

  async computeCategorySpend(
    range: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
    baseCurrency: string,
  ): Promise<FinanceCategorySpendRow[]> {
    return computeFinanceCategorySpend(
      await this.buildReportComputationInput(baseCurrency),
      range,
      groupBy,
    );
  }

  async listCategorySpendDrilldown(
    range: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
    key: string,
    baseCurrency: string,
  ): Promise<FinanceReportLine[]> {
    return listFinanceCategorySpendDrilldown(
      await this.buildReportComputationInput(baseCurrency),
      range,
      groupBy,
      key,
    );
  }

  async computeMerchantSpend(
    range: FinanceDateRange,
    limit: number,
    baseCurrency: string,
  ): Promise<FinanceMerchantSpendRow[]> {
    return computeFinanceMerchantSpend(
      await this.buildReportComputationInput(baseCurrency),
      range,
      limit,
    );
  }

  async computePersonSpend(
    range: FinanceDateRange,
    baseCurrency: string,
  ): Promise<FinancePersonSpendRow[]> {
    return computeFinancePersonSpend(await this.buildReportComputationInput(baseCurrency), range);
  }

  async computeTrend(
    range: FinanceDateRange,
    granularity: FinanceTrendGranularity,
    baseCurrency: string,
  ): Promise<FinanceTrendPoint[]> {
    return computeFinanceTrend(
      await this.buildReportComputationInput(baseCurrency),
      range,
      granularity,
    );
  }

  async computeMonthOverMonth(
    currentRange: FinanceDateRange,
    previousRange: FinanceDateRange,
    groupBy: FinanceReportGroupBy,
    baseCurrency: string,
  ): Promise<FinanceMonthOverMonthRow[]> {
    return computeFinanceMonthOverMonth(
      await this.buildReportComputationInput(baseCurrency),
      currentRange,
      previousRange,
      groupBy,
    );
  }

  // --- recurring series (Phase 6) ---------------------------------------------------------

  async listRecurringSeries(
    status?: FinanceRecurringSeries["status"],
  ): Promise<FinanceRecurringSeries[]> {
    const db = await this.getDb();
    const rows = status
      ? await db.select<RecurringSeriesRow[]>(
          "SELECT * FROM finance_recurring_series WHERE status = $1",
          [status],
        )
      : await db.select<RecurringSeriesRow[]>("SELECT * FROM finance_recurring_series");
    return rows
      .map(mapRecurringSeries)
      .sort(
        (a, b) =>
          a.merchantKey.localeCompare(b.merchantKey) || a.accountId.localeCompare(b.accountId),
      );
  }

  async saveRecurringSeries(series: FinanceRecurringSeries): Promise<FinanceRecurringSeries> {
    const db = await this.getDb();
    const now = nowIso();
    const id = series.id || createEntityId("finance-recurring");
    const existingRows = await db.select<RecurringSeriesRow[]>(
      "SELECT created_at FROM finance_recurring_series WHERE id = $1",
      [id],
    );
    const createdAt = existingRows[0]?.created_at ?? series.createdAt ?? now;
    await db.execute(
      `INSERT INTO finance_recurring_series (
        id, merchant_key, account_id, category_id, cadence, expected_amount_minor,
        amount_tolerance_minor, day_of_month, last_seen_date, next_expected_date,
        occurrence_count, status, confirmed_by_user, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(id) DO UPDATE SET
        merchant_key = excluded.merchant_key,
        account_id = excluded.account_id,
        category_id = excluded.category_id,
        cadence = excluded.cadence,
        expected_amount_minor = excluded.expected_amount_minor,
        amount_tolerance_minor = excluded.amount_tolerance_minor,
        day_of_month = excluded.day_of_month,
        last_seen_date = excluded.last_seen_date,
        next_expected_date = excluded.next_expected_date,
        occurrence_count = excluded.occurrence_count,
        status = excluded.status,
        confirmed_by_user = excluded.confirmed_by_user,
        updated_at = excluded.updated_at`,
      [
        id,
        series.merchantKey,
        series.accountId,
        series.categoryId,
        series.cadence,
        series.expectedAmountMinor,
        series.amountToleranceMinor,
        series.dayOfMonth,
        series.lastSeenDate,
        series.nextExpectedDate,
        series.occurrenceCount,
        series.status,
        series.confirmedByUser ? 1 : 0,
        createdAt,
        now,
      ],
    );
    const rows = await db.select<RecurringSeriesRow[]>(
      "SELECT * FROM finance_recurring_series WHERE id = $1",
      [id],
    );
    return mapRecurringSeries(rows[0]);
  }

  /** Public, on-demand entry point (not inside an import transaction). */
  async detectRecurringSeries(today: string): Promise<{ created: number; updated: number }> {
    const db = await this.getDb();
    return this.detectRecurringSeriesWithDb(db, today);
  }

  /**
   * Re-runs detection over the full history and upserts every result,
   * preserving `confirmed_by_user` series — see `AppRepository`'s
   * `detectFinanceRecurringSeries` contract. Callable from inside an
   * existing transaction (`importTransactions`) or standalone.
   */
  private async detectRecurringSeriesWithDb(
    db: Database,
    today: string,
  ): Promise<{ created: number; updated: number }> {
    const transactionRows = await db.select<
      Array<{
        merchant_key: string;
        account_id: string;
        category_id: string | null;
        amount_minor: number;
        posted_date: string;
      }>
    >(
      "SELECT merchant_key, account_id, category_id, amount_minor, posted_date FROM finance_transactions",
    );
    const seriesRows = await db.select<RecurringSeriesRow[]>(
      "SELECT * FROM finance_recurring_series",
    );

    const transactions: RecurringDetectionTransactionInput[] = transactionRows.map((row) => ({
      merchantKey: row.merchant_key,
      accountId: row.account_id,
      categoryId: row.category_id,
      amountMinor: row.amount_minor,
      postedDate: row.posted_date,
    }));
    const existing: RecurringDetectionExistingSeriesInput[] = seriesRows.map((row) => {
      const mapped = mapRecurringSeries(row);
      return {
        id: mapped.id,
        merchantKey: mapped.merchantKey,
        accountId: mapped.accountId,
        categoryId: mapped.categoryId,
        cadence: mapped.cadence,
        expectedAmountMinor: mapped.expectedAmountMinor,
        amountToleranceMinor: mapped.amountToleranceMinor,
        dayOfMonth: mapped.dayOfMonth,
        lastSeenDate: mapped.lastSeenDate,
        nextExpectedDate: mapped.nextExpectedDate,
        occurrenceCount: mapped.occurrenceCount,
        status: mapped.status,
        confirmedByUser: mapped.confirmedByUser,
      };
    });

    const detected = detectFinanceRecurringSeries(transactions, existing, today);
    let created = 0;
    let updated = 0;
    const now = nowIso();

    for (const item of detected) {
      const isNew = item.id === "";
      const id = isNew ? createEntityId("finance-recurring") : item.id;
      const existingRows = isNew
        ? []
        : await db.select<Array<{ created_at: string }>>(
            "SELECT created_at FROM finance_recurring_series WHERE id = $1",
            [id],
          );
      const createdAt = existingRows[0]?.created_at ?? now;

      await db.execute(
        `INSERT INTO finance_recurring_series (
          id, merchant_key, account_id, category_id, cadence, expected_amount_minor,
          amount_tolerance_minor, day_of_month, last_seen_date, next_expected_date,
          occurrence_count, status, confirmed_by_user, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(id) DO UPDATE SET
          merchant_key = excluded.merchant_key,
          account_id = excluded.account_id,
          category_id = excluded.category_id,
          cadence = excluded.cadence,
          expected_amount_minor = excluded.expected_amount_minor,
          amount_tolerance_minor = excluded.amount_tolerance_minor,
          day_of_month = excluded.day_of_month,
          last_seen_date = excluded.last_seen_date,
          next_expected_date = excluded.next_expected_date,
          occurrence_count = excluded.occurrence_count,
          status = excluded.status,
          confirmed_by_user = excluded.confirmed_by_user,
          updated_at = excluded.updated_at`,
        [
          id,
          item.merchantKey,
          item.accountId,
          item.categoryId,
          item.cadence,
          item.expectedAmountMinor,
          item.amountToleranceMinor,
          item.dayOfMonth,
          item.lastSeenDate,
          item.nextExpectedDate,
          item.occurrenceCount,
          item.status,
          item.confirmedByUser ? 1 : 0,
          createdAt,
          now,
        ],
      );
      if (isNew) {
        created += 1;
      } else {
        updated += 1;
      }
    }

    return { created, updated };
  }

  // --- balance snapshots (Phase 6) ----------------------------------------------------------

  /** Idempotent per day: upserts one row per account for `asOfDate`. Returns the account count. */
  async snapshotAccountBalances(asOfDate: string): Promise<number> {
    const db = await this.getDb();
    const now = nowIso();
    const accountRows = await db.select<AccountRow[]>("SELECT * FROM finance_accounts");
    const transactionRows = await db.select<TransactionRow[]>(
      "SELECT account_id, posted_date, amount_minor FROM finance_transactions WHERE posted_date <= $1",
      [asOfDate],
    );
    const balanceByAccountId = new Map<string, number>();
    for (const account of accountRows) {
      balanceByAccountId.set(account.id, account.opening_balance_minor);
    }
    for (const row of transactionRows) {
      balanceByAccountId.set(
        row.account_id,
        (balanceByAccountId.get(row.account_id) ?? 0) + row.amount_minor,
      );
    }

    for (const account of accountRows) {
      await db.execute(
        `INSERT INTO finance_account_balance_snapshots (
          account_id, as_of_date, balance_minor, source, created_at
        ) VALUES ($1,$2,$3,'derived',$4)
        ON CONFLICT(account_id, as_of_date) DO UPDATE SET
          balance_minor = excluded.balance_minor`,
        [account.id, asOfDate, balanceByAccountId.get(account.id) ?? 0, now],
      );
    }
    return accountRows.length;
  }

  async listAccountBalanceSnapshots(accountId: string): Promise<FinanceAccountBalanceSnapshot[]> {
    const db = await this.getDb();
    const rows = await db.select<BalanceSnapshotRow[]>(
      "SELECT * FROM finance_account_balance_snapshots WHERE account_id = $1 ORDER BY as_of_date",
      [accountId],
    );
    return rows.map(mapBalanceSnapshot);
  }

  // --- Forecasting and alerts (Phase 7) ---------------------------------------------------

  /**
   * The forecast/alert input bundle for `AppRepository.buildFinanceSnapshot`.
   * `paceTransactions`/`paceSplits` reuse the same on-budget,
   * `excluded_from_budget = 0` filter `budget.ts`'s `activity` uses (via
   * `buildBudgetComputationInput`), so pace math and envelope activity agree
   * on what counts as spending. `budgetState` is `computeFinanceBudgetState`
   * — reused, never recomputed, for `envelope`/`available`/`activity`.
   */
  async buildSnapshot(today: string, safetyBufferMinor: number): Promise<FinanceSnapshot> {
    const db = await this.getDb();
    const monthKey = getMonthKey(today);
    const monthEnd = getMonthEndDate(monthKey);

    const budgetInput = await this.buildBudgetComputationInput(monthKey);
    const budgetState = computeFinanceBudgetState(budgetInput);

    const onBudgetAccountIds = budgetInput.accounts.map((account) => account.id);
    const accountPlaceholders = onBudgetAccountIds.map((_, i) => `$${i + 2}`).join(",");
    const transactionRows =
      onBudgetAccountIds.length > 0
        ? await db.select<TransactionRow[]>(
            `SELECT * FROM finance_transactions
             WHERE excluded_from_budget = 0 AND posted_date <= $1
               AND account_id IN (${accountPlaceholders})`,
            [monthEnd, ...onBudgetAccountIds],
          )
        : [];
    const splitTransactionIds = transactionRows
      .filter((row) => row.has_splits)
      .map((row) => row.id);
    const splitRows =
      splitTransactionIds.length > 0
        ? await db.select<SplitRow[]>(
            `SELECT * FROM finance_transaction_splits
             WHERE transaction_id IN (${splitTransactionIds.map((_, i) => `$${i + 1}`).join(",")})`,
            splitTransactionIds,
          )
        : [];

    const activeSeriesRows = await db.select<RecurringSeriesRow[]>(
      "SELECT * FROM finance_recurring_series WHERE status = 'active'",
    );

    let firstActivityMonthKey: string | null = null;
    for (const row of transactionRows) {
      const month = getMonthKey(row.posted_date);
      if (firstActivityMonthKey === null || month < firstActivityMonthKey) {
        firstActivityMonthKey = month;
      }
    }

    return {
      today,
      monthKey,
      safetyBufferMinor,
      accounts: budgetInput.accounts,
      balanceTransactions: budgetInput.balanceTransactions,
      budgetState,
      paceTransactions: transactionRows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        postedDate: row.posted_date,
        amountMinor: row.amount_minor,
        categoryId: row.category_id,
        merchantKey: row.merchant_key,
        hasSplits: Boolean(row.has_splits),
        isTransfer: Boolean(row.is_transfer),
      })),
      paceSplits: splitRows.map((row) => ({
        transactionId: row.transaction_id,
        amountMinor: row.amount_minor,
        categoryId: row.category_id,
      })),
      firstActivityMonthKey,
      recurringSeries: activeSeriesRows.map(mapRecurringSeries).map((series) => ({
        merchantKey: series.merchantKey,
        accountId: series.accountId,
        categoryId: series.categoryId,
        cadence: series.cadence,
        expectedAmountMinor: series.expectedAmountMinor,
        nextExpectedDate: series.nextExpectedDate,
      })),
    };
  }

  async computeForecast(
    today: string,
    safetyBufferMinor: number,
  ): Promise<{ forecast: FinanceForecast; alerts: FinanceAlert[] }> {
    const snapshot = await this.buildSnapshot(today, safetyBufferMinor);
    const forecast = computeFinanceForecast(snapshot);
    const alerts = buildFinanceAlerts(forecast, { financeSafetyBufferMinor: safetyBufferMinor });
    return { forecast, alerts };
  }

  // --- Alert notification ledger (Phase 7) ------------------------------------------------

  /** Alert keys already notified on `onDate` — the once-per-day-per-key rate limit. */
  async listNotifiedFinanceAlertKeys(onDate: string): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.select<Array<{ alert_key: string }>>(
      "SELECT alert_key FROM finance_alert_notifications WHERE notified_on_date = $1",
      [onDate],
    );
    return rows.map((row) => row.alert_key);
  }

  async recordFinanceAlertNotifications(onDate: string, alertKeys: string[]): Promise<void> {
    if (alertKeys.length === 0) {
      return;
    }
    const db = await this.getDb();
    const now = nowIso();
    for (const alertKey of alertKeys) {
      await db.execute(
        `INSERT INTO finance_alert_notifications (alert_key, notified_on_date, notified_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(alert_key, notified_on_date) DO NOTHING`,
        [alertKey, onDate, now],
      );
    }
  }
}
