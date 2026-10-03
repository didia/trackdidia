// In-memory finance store for browser preview and the startup fallback.
// Mirrors `FinanceSqliteStore`'s behavior exactly (see docs/architecture.md
// "Repository parity") — the same business rules, over Maps instead of SQL.

import type {
  BulkUpdateFinanceTransactionsPatch,
  DecideFinanceCategorySuggestionInput,
  FinanceAccount,
  FinanceAccountFilters,
  FinanceCategory,
  FinanceCategoryBackfillEntry,
  FinanceCategorySuggestion,
  FinanceImportBatch,
  FinanceImportProfile,
  FinanceImportRequest,
  FinanceImportSummary,
  FinanceMerchantMemoryEntry,
  FinanceMerchantMemoryFilters,
  FinancePerson,
  FinanceRule,
  FinanceRuleActions,
  FinanceTransaction,
  FinanceTransactionFilters,
  FinanceTransactionSplit,
  ReclassifyFinancePendingResult,
  SetFinanceTransactionCategoryInput,
  SetFinanceTransactionCategoryResult,
  SetFinanceTransferPair,
  UndoFinanceImportBatchResult,
} from "../../domain/finance";
import { classifyTransaction, type ClassificationOutcome } from "../finance/classify";
import { DEFAULT_FINANCE_CATEGORIES } from "../finance/default-categories";
import type { DismissedSuggestionPair } from "../finance/dismissed-suggestions";
import {
  dedupeHash as computeDedupeHash,
  assignOccurrenceIndices,
} from "../finance/import-profile";
import { applyMerchantMemoryCorrection } from "../finance/memory";
import { findNearDuplicates } from "../finance/near-duplicates";
import { validateSplitTotal } from "../finance/splits";
import { detectTransfers, type TransferCandidateTransaction } from "../finance/transfers";
import { createEntityId, nowIso } from "../gtd/shared";

const localDate = (iso: string): string => iso.slice(0, 10);

const SYSTEM_CATEGORIES: FinanceCategory[] = [
  {
    id: "fincat:non-categorise",
    name: "Non catégorisé",
    parentId: null,
    kind: "expense",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "fincat:transfert",
    name: "Transfert",
    parentId: null,
    kind: "transfer",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "fincat:split",
    name: "Répartition",
    parentId: null,
    kind: "internal",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 2,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
];

const memoryKey = (merchantKey: string, accountId: string, sign: -1 | 0 | 1): string =>
  `${merchantKey}\u0000${accountId}\u0000${sign}`;

export class FinanceMemoryStore {
  people = new Map<string, FinancePerson>();
  accounts = new Map<string, FinanceAccount>();
  categories = new Map<string, FinanceCategory>(
    SYSTEM_CATEGORIES.map((category) => [category.id, category]),
  );
  transactions = new Map<string, FinanceTransaction>();
  splits = new Map<string, FinanceTransactionSplit>();
  rules = new Map<string, FinanceRule>();
  merchantMemory = new Map<string, FinanceMerchantMemoryEntry>();
  categorySuggestions = new Map<string, FinanceCategorySuggestion>();
  importProfiles = new Map<string, FinanceImportProfile>();
  importBatches = new Map<string, FinanceImportBatch>();

  // --- people -------------------------------------------------------------

  listPeople(): FinancePerson[] {
    return [...this.people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  savePerson(person: FinancePerson): FinancePerson {
    const now = nowIso();
    const id = person.id || createEntityId("finance-person");
    const saved: FinancePerson = {
      ...person,
      id,
      createdAt: person.createdAt || now,
      updatedAt: now,
    };
    this.people.set(id, saved);
    return saved;
  }

  // --- accounts -------------------------------------------------------------

  listAccounts(filters?: FinanceAccountFilters): FinanceAccount[] {
    let accounts = [...this.accounts.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
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

  saveAccount(account: FinanceAccount): FinanceAccount {
    const now = nowIso();
    const id = account.id || createEntityId("finance-account");
    const saved: FinanceAccount = {
      ...account,
      id,
      createdAt: account.createdAt || now,
      updatedAt: now,
    };
    this.accounts.set(id, saved);
    return saved;
  }

  closeAccount(id: string): FinanceAccount {
    const account = this.accounts.get(id);
    if (!account) {
      throw new Error(`finance account not found: ${id}`);
    }
    const updated: FinanceAccount = { ...account, closed: true, updatedAt: nowIso() };
    this.accounts.set(id, updated);
    return updated;
  }

  // --- categories -------------------------------------------------------------

  listCategories(includeArchived?: boolean): FinanceCategory[] {
    const categories = [...this.categories.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    return includeArchived ? categories : categories.filter((category) => !category.archived);
  }

  saveCategory(category: FinanceCategory): FinanceCategory {
    const now = nowIso();
    const id = category.id || createEntityId("fincat");
    const saved: FinanceCategory = {
      ...category,
      id,
      createdAt: category.createdAt || now,
      updatedAt: now,
    };
    this.categories.set(id, saved);
    return saved;
  }

  archiveCategory(id: string, reassignToId: string): number {
    let reassigned = 0;
    for (const txn of this.transactions.values()) {
      if (txn.categoryId === id) {
        this.transactions.set(txn.id, { ...txn, categoryId: reassignToId, updatedAt: nowIso() });
        reassigned += 1;
      }
    }
    for (const [splitId, split] of this.splits.entries()) {
      if (split.categoryId === id) {
        this.splits.set(splitId, { ...split, categoryId: reassignToId });
        reassigned += 1;
      }
    }
    for (const [key, entry] of this.merchantMemory.entries()) {
      if (entry.categoryId === id) {
        this.merchantMemory.set(key, { ...entry, categoryId: reassignToId, updatedAt: nowIso() });
      }
    }
    const category = this.categories.get(id);
    if (category) {
      this.categories.set(id, { ...category, archived: true, updatedAt: nowIso() });
    }
    return reassigned;
  }

  seedDefaultCategories(): number {
    const now = nowIso();
    let inserted = 0;
    for (const seed of DEFAULT_FINANCE_CATEGORIES) {
      if (this.categories.has(seed.id)) {
        continue;
      }
      this.categories.set(seed.id, {
        id: seed.id,
        name: seed.name,
        parentId: seed.parentId,
        kind: seed.kind,
        archived: false,
        isSystem: false,
        defersToNextMonth: false,
        sortOrder: seed.sortOrder,
        createdAt: now,
        updatedAt: now,
      });
      inserted += 1;
    }
    return inserted;
  }

  // --- rules -------------------------------------------------------------

  listRules(): FinanceRule[] {
    return [...this.rules.values()].sort(
      (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
    );
  }

  saveRule(rule: FinanceRule): FinanceRule {
    const now = nowIso();
    const id = rule.id || createEntityId("finance-rule");
    const saved: FinanceRule = { ...rule, id, createdAt: rule.createdAt || now, updatedAt: now };
    this.rules.set(id, saved);
    return saved;
  }

  deleteRule(id: string): void {
    this.rules.delete(id);
  }

  // --- merchant memory -----------------------------------------------------

  listMerchantMemory(filters?: FinanceMerchantMemoryFilters): FinanceMerchantMemoryEntry[] {
    let entries = [...this.merchantMemory.values()];
    if (filters?.merchantKey) {
      entries = entries.filter((entry) => entry.merchantKey === filters.merchantKey);
    }
    if (filters?.accountId !== undefined) {
      entries = entries.filter((entry) => entry.accountId === filters.accountId);
    }
    return entries.sort(
      (a, b) =>
        a.merchantKey.localeCompare(b.merchantKey) ||
        a.accountId.localeCompare(b.accountId) ||
        a.sign - b.sign,
    );
  }

  getMerchantMemory(
    merchantKey: string,
    accountId: string,
    sign: -1 | 0 | 1,
  ): FinanceMerchantMemoryEntry | null {
    return this.merchantMemory.get(memoryKey(merchantKey, accountId, sign)) ?? null;
  }

  upsertMerchantMemory(entry: FinanceMerchantMemoryEntry): FinanceMerchantMemoryEntry {
    this.merchantMemory.set(memoryKey(entry.merchantKey, entry.accountId, entry.sign), entry);
    return entry;
  }

  forgetMerchantMemory(merchantKey: string, accountId: string, sign: -1 | 0 | 1): void {
    this.merchantMemory.delete(memoryKey(merchantKey, accountId, sign));
  }

  // --- transactions -------------------------------------------------------------

  listTransactions(filters: FinanceTransactionFilters = {}): FinanceTransaction[] {
    let transactions = [...this.transactions.values()].sort(
      (a, b) => b.postedDate.localeCompare(a.postedDate) || b.id.localeCompare(a.id),
    );

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

  countTransactions(filters: FinanceTransactionFilters = {}): number {
    const { limit: _limit, offset: _offset, ...rest } = filters;
    return this.listTransactions(rest).length;
  }

  getTransaction(id: string): FinanceTransaction | null {
    return this.transactions.get(id) ?? null;
  }

  saveTransaction(txn: FinanceTransaction): FinanceTransaction {
    const now = nowIso();
    const id = txn.id || createEntityId("finance-txn");
    const saved: FinanceTransaction = {
      ...txn,
      id,
      createdAt: txn.createdAt || now,
      updatedAt: now,
    };
    this.transactions.set(id, saved);
    return saved;
  }

  setTransactionCategory(
    input: SetFinanceTransactionCategoryInput,
  ): SetFinanceTransactionCategoryResult {
    if (!input.categoryId) {
      throw new Error("setFinanceTransactionCategory requires a non-empty categoryId");
    }
    const now = nowIso();
    const txn = this.transactions.get(input.transactionId);
    if (!txn) {
      throw new Error(`finance transaction not found: ${input.transactionId}`);
    }

    this.transactions.set(txn.id, {
      ...txn,
      categoryId: input.categoryId,
      categorySource: "user",
      categoryConfidence: null,
      categorizedAt: now,
      updatedAt: now,
    });

    let updated = 1;
    const backfill: FinanceCategoryBackfillEntry[] = [];
    if (input.scope === "all_matching") {
      for (const candidate of this.transactions.values()) {
        if (
          candidate.id !== txn.id &&
          candidate.merchantKey === txn.merchantKey &&
          candidate.categorySource !== "user"
        ) {
          backfill.push({
            transactionId: candidate.id,
            categoryId: candidate.categoryId,
            categorySource: candidate.categorySource,
            categoryConfidence: candidate.categoryConfidence,
            categorizedAt: candidate.categorizedAt,
          });
          this.transactions.set(candidate.id, {
            ...candidate,
            categoryId: input.categoryId,
            categorySource: "user",
            categoryConfidence: null,
            categorizedAt: now,
            updatedAt: now,
          });
          updated += 1;
        }
      }
    }

    const sign: -1 | 0 | 1 = txn.amountMinor > 0 ? 1 : txn.amountMinor < 0 ? -1 : 0;
    const existingMemory = this.getMerchantMemory(txn.merchantKey, txn.accountId, sign);
    const memory = applyMerchantMemoryCorrection({
      existing: existingMemory,
      merchantKey: txn.merchantKey,
      accountId: txn.accountId,
      sign,
      categoryId: input.categoryId,
      source: "user_correction",
      now,
    });
    this.upsertMerchantMemory(memory);

    return { updated, memory, backfill };
  }

  /** Reverts the `backfill` entries from a `scope: "all_matching"` call — a single undo. */
  revertCategoryBackfill(entries: FinanceCategoryBackfillEntry[]): number {
    const now = nowIso();
    let reverted = 0;
    for (const entry of entries) {
      const txn = this.transactions.get(entry.transactionId);
      if (!txn) {
        continue;
      }
      this.transactions.set(entry.transactionId, {
        ...txn,
        categoryId: entry.categoryId,
        categorySource: entry.categorySource,
        categoryConfidence: entry.categoryConfidence,
        categorizedAt: entry.categorizedAt,
        updatedAt: now,
      });
      reverted += 1;
    }
    return reverted;
  }

  bulkUpdateTransactions(ids: string[], patch: BulkUpdateFinanceTransactionsPatch): number {
    const now = nowIso();
    let updated = 0;
    for (const id of ids) {
      const txn = this.transactions.get(id);
      if (!txn) {
        continue;
      }
      const next: FinanceTransaction = { ...txn, updatedAt: now };
      let changed = false;
      if (patch.categoryId !== undefined) {
        next.categoryId = patch.categoryId;
        next.categorySource = "user";
        next.categorizedAt = now;
        changed = true;
      }
      if (patch.personId !== undefined) {
        next.personId = patch.personId;
        changed = true;
      }
      if (patch.excludedFromBudget !== undefined) {
        next.excludedFromBudget = patch.excludedFromBudget;
        changed = true;
      }
      if (patch.excludedFromReports !== undefined) {
        next.excludedFromReports = patch.excludedFromReports;
        changed = true;
      }
      if (changed) {
        this.transactions.set(id, next);
        updated += 1;
      }
    }
    return updated;
  }

  saveTransactionSplits(
    transactionId: string,
    splits: FinanceTransactionSplit[],
  ): FinanceTransaction {
    const now = nowIso();
    const txn = this.transactions.get(transactionId);
    if (!txn) {
      throw new Error(`finance transaction not found: ${transactionId}`);
    }
    // Validate everything before mutating so a rejected edit leaves the old allocation intact.
    validateSplitTotal(txn.amountMinor, splits);
    for (const [splitId, split] of [...this.splits.entries()]) {
      if (split.transactionId === transactionId) {
        this.splits.delete(splitId);
      }
    }

    splits.forEach((split, index) => {
      const id = split.id || createEntityId("finance-split");
      this.splits.set(id, { ...split, id, transactionId, sortOrder: index, createdAt: now });
    });

    const hasSplits = splits.length > 0;
    const clearedSplitCategory = !hasSplits && txn.categoryId === "fincat:split";
    const updated: FinanceTransaction = {
      ...txn,
      hasSplits,
      categoryId: hasSplits
        ? "fincat:split"
        : clearedSplitCategory
          ? "fincat:non-categorise"
          : txn.categoryId,
      categorySource: hasSplits ? "user" : clearedSplitCategory ? "default" : txn.categorySource,
      categoryConfidence: hasSplits || clearedSplitCategory ? null : txn.categoryConfidence,
      updatedAt: now,
    };
    this.transactions.set(transactionId, updated);
    return updated;
  }

  listTransactionSplits(transactionId: string): FinanceTransactionSplit[] {
    return [...this.splits.values()]
      .filter((split) => split.transactionId === transactionId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  setTransfer(pair: SetFinanceTransferPair | null, groupId?: string): void {
    if (pair === null) {
      return;
    }
    const now = nowIso();
    const resolvedGroupId =
      groupId ?? `transfer:${[pair.transactionIdA, pair.transactionIdB].sort().join(":")}`;

    for (const id of [pair.transactionIdA, pair.transactionIdB]) {
      const txn = this.transactions.get(id);
      if (!txn) {
        continue;
      }
      this.transactions.set(id, {
        ...txn,
        isTransfer: true,
        transferGroupId: resolvedGroupId,
        categoryId: "fincat:transfert",
        categorySource: "rule",
        excludedFromBudget: true,
        updatedAt: now,
      });
    }
  }

  clearTransfer(transactionId: string): void {
    const txn = this.transactions.get(transactionId);
    if (!txn) {
      return;
    }
    this.transactions.set(transactionId, {
      ...txn,
      isTransfer: false,
      transferGroupId: null,
      categoryId: "fincat:non-categorise",
      categorySource: "default",
      excludedFromBudget: false,
      updatedAt: nowIso(),
    });
  }

  // --- import profiles -------------------------------------------------------------

  listImportProfiles(): FinanceImportProfile[] {
    return [...this.importProfiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  saveImportProfile(profile: FinanceImportProfile): FinanceImportProfile {
    const now = nowIso();
    const id = profile.id || createEntityId("finance-import-profile");
    // Mirrors uniq_finance_profile_signature on the SQLite side: a header
    // signature identifies one profile, so saving a different id with a
    // signature already used by another profile must fail the same way here
    // as it does against the real database.
    const conflicting = [...this.importProfiles.values()].find(
      (existing) => existing.id !== id && existing.signature === profile.signature,
    );
    if (conflicting) {
      throw new Error(
        `UNIQUE constraint failed: finance_import_profiles.signature (existing profile ${conflicting.id})`,
      );
    }
    const saved: FinanceImportProfile = {
      ...profile,
      id,
      createdAt: profile.createdAt || now,
      updatedAt: now,
    };
    this.importProfiles.set(id, saved);
    return saved;
  }

  findImportProfileBySignature(signature: string): FinanceImportProfile | null {
    return (
      [...this.importProfiles.values()].find((profile) => profile.signature === signature) ?? null
    );
  }

  // --- import batches -------------------------------------------------------------

  listImportBatches(limit?: number): FinanceImportBatch[] {
    const batches = [...this.importBatches.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    return limit !== undefined ? batches.slice(0, limit) : batches;
  }

  // --- import -------------------------------------------------------------

  importTransactions(input: FinanceImportRequest): FinanceImportSummary {
    const now = nowIso();
    const batchId = createEntityId("finance-import-batch");

    const occurrenceIndices = assignOccurrenceIndices(input.rows);
    const prepared = input.rows.map((row, index) => ({
      row,
      dedupeHash: computeDedupeHash({
        accountId: row.accountId,
        postedDate: row.postedDate,
        amountMinor: row.amountMinor,
        currency: row.currency,
        descriptionRaw: row.descriptionRaw,
        occurrenceIndex: occurrenceIndices[index],
      }),
    }));

    const existingByAccountDedupe = new Set(
      [...this.transactions.values()].map((txn) => `${txn.accountId}\u0000${txn.dedupeHash}`),
    );

    let imported = 0;
    let duplicates = 0;
    const insertedIds: string[] = [];

    for (const item of prepared) {
      const key = `${item.row.accountId}\u0000${item.dedupeHash}`;
      if (existingByAccountDedupe.has(key)) {
        duplicates += 1;
        continue;
      }
      existingByAccountDedupe.add(key);
      const id = createEntityId("finance-txn");
      const txn: FinanceTransaction = {
        id,
        accountId: item.row.accountId,
        postedDate: item.row.postedDate,
        amountMinor: item.row.amountMinor,
        currency: item.row.currency,
        descriptionRaw: item.row.descriptionRaw,
        descriptionOriginal: item.row.descriptionOriginal,
        merchantKey: item.row.merchantKey,
        merchantDisplay: null,
        categoryId: "fincat:non-categorise",
        categorySource: "default",
        categoryConfidence: null,
        categorizedAt: null,
        personId: item.row.personId,
        notes: item.row.notes,
        labelsJson: item.row.labelsJson,
        pending: false,
        isTransfer: false,
        transferGroupId: null,
        excludedFromBudget: false,
        excludedFromReports: false,
        hasSplits: false,
        importBatchId: batchId,
        dedupeHash: item.dedupeHash,
        sourceRowJson: item.row.sourceRowJson,
        createdAt: now,
        updatedAt: now,
      };
      this.transactions.set(id, txn);
      insertedIds.push(id);
      imported += 1;
    }

    const insertedRows = insertedIds.map((id) => this.transactions.get(id)!);
    const existingCandidates = [...this.transactions.values()].filter(
      (txn) => txn.importBatchId !== batchId,
    );

    const nearDuplicateMatches = findNearDuplicates(
      insertedRows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        postedDate: row.postedDate,
        amountMinor: row.amountMinor,
        descriptionRaw: row.descriptionRaw,
      })),
      existingCandidates.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        postedDate: row.postedDate,
        amountMinor: row.amountMinor,
        descriptionRaw: row.descriptionRaw,
      })),
    );

    const warnings: string[] = [];
    if (nearDuplicateMatches.length > 0) {
      warnings.push(
        `${nearDuplicateMatches.length} transaction(s) look like a near-duplicate of an existing row (pending/posted drift) and were kept for review.`,
      );
    }

    // A user-categorized row is never re-categorized by any automatic stage, including
    // transfer detection — exclude it from the candidate set entirely so it can neither be
    // paired nor relabeled (see specs/todo/finance.md "Classification order").
    const candidates: TransferCandidateTransaction[] = [...this.transactions.values()]
      .filter((txn) => txn.categorySource !== "user")
      .map((txn) => ({
        id: txn.id,
        accountId: txn.accountId,
        amountMinor: txn.amountMinor,
        currency: txn.currency,
        postedDate: txn.postedDate,
        descriptionRaw: txn.descriptionRaw,
        isTransfer: txn.isTransfer,
        transferGroupId: txn.transferGroupId,
        excludedFromBudget: txn.excludedFromBudget,
        accountOnBudget: this.accounts.get(txn.accountId)?.onBudget ?? true,
      }));

    const transferActions = detectTransfers(candidates);
    let transfersDetected = 0;
    let pendingSuggestions = 0;

    for (const action of transferActions) {
      if (action.type === "matched_pair") {
        transfersDetected += 1;
        for (const leg of [action.legA, action.legB]) {
          const txn = this.transactions.get(leg.transactionId);
          if (!txn) {
            continue;
          }
          this.transactions.set(leg.transactionId, {
            ...txn,
            isTransfer: true,
            transferGroupId: action.transferGroupId,
            categoryId: leg.outcome.categoryId,
            categorySource: leg.outcome.categorySource,
            excludedFromBudget: leg.outcome.excludedFromBudget,
            updatedAt: now,
          });
          if (leg.outcome.pendingSuggestion) {
            pendingSuggestions += 1;
            this.insertPendingSuggestion(leg.transactionId, leg.outcome.categoryId);
          }
        }
      } else {
        const txn = this.transactions.get(action.transactionId);
        if (txn) {
          this.transactions.set(action.transactionId, {
            ...txn,
            isTransfer: true,
            categoryId: action.outcome.categoryId,
            categorySource: action.outcome.categorySource,
            excludedFromBudget: action.outcome.excludedFromBudget,
            updatedAt: now,
          });
          if (action.outcome.pendingSuggestion) {
            pendingSuggestions += 1;
            this.insertPendingSuggestion(action.transactionId, action.outcome.categoryId);
          }
        }
      }
    }

    // Classification (rules -> learned memory -> seed heuristics; no AI — see
    // specs/todo/finance.md "Classification pipeline"). Only the rows this
    // batch inserted that transfer detection left untouched are eligible;
    // transfer detection already decided a final category for the rest.
    const classificationRules = [...this.rules.values()];
    const classificationMemory = [...this.merchantMemory.values()];
    const dismissed = this.buildDismissedPairs();
    const today = localDate(now);
    for (const id of insertedIds) {
      const txn = this.transactions.get(id);
      if (!txn || txn.isTransfer) {
        continue;
      }
      const outcome = classifyTransaction(
        {
          categoryId: txn.categoryId,
          categorySource: txn.categorySource,
          accountId: txn.accountId,
          amountMinor: txn.amountMinor,
          merchantKey: txn.merchantKey,
          personId: txn.personId,
        },
        { rules: classificationRules, memory: classificationMemory, dismissed, today },
      );
      const suggestionCreated = this.applyClassificationOutcome(txn.id, outcome, now);
      if (suggestionCreated) {
        pendingSuggestions += 1;
      }
    }

    const skipped = input.rejected?.skipped ?? 0;
    const errors = input.rejected?.errors ?? 0;
    warnings.push(...(input.rejected?.warnings ?? []));
    const batch: FinanceImportBatch = {
      id: batchId,
      profileId: input.profileId,
      fileName: input.fileName,
      fileHash: input.fileHash,
      accountId: input.accountId,
      rowCount: input.rows.length + skipped + errors,
      importedCount: imported,
      duplicateCount: duplicates,
      skippedCount: skipped,
      errorCount: errors,
      status: "completed",
      errorSummary: input.rejected?.warnings.length
        ? input.rejected.warnings.slice(0, 20).join("\n")
        : null,
      startedAt: now,
      finishedAt: now,
    };
    this.importBatches.set(batchId, batch);

    return {
      batchId,
      rowCount: input.rows.length + skipped + errors,
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
  }

  private insertPendingSuggestion(
    transactionId: string,
    suggestedCategoryId: string,
    origin: FinanceCategorySuggestion["origin"] = "memory",
    confidence = 0.5,
  ): boolean {
    const existingPending = [...this.categorySuggestions.values()].some(
      (suggestion) => suggestion.transactionId === transactionId && suggestion.status === "pending",
    );
    if (existingPending) {
      return false;
    }
    const txn = this.transactions.get(transactionId);
    const id = createEntityId("finance-suggestion");
    this.categorySuggestions.set(id, {
      id,
      transactionId,
      merchantKey: txn?.merchantKey ?? "",
      suggestedCategoryId,
      confidence,
      origin,
      rationale: null,
      model: null,
      promptVersion: null,
      status: "pending",
      decidedAt: null,
      createdAt: nowIso(),
    });
    return true;
  }

  /** `finance_category_suggestions` rows with `status = 'dismissed'`, as the pure 90-day window input. */
  private buildDismissedPairs(): DismissedSuggestionPair[] {
    return [...this.categorySuggestions.values()]
      .filter((suggestion) => suggestion.status === "dismissed")
      .map((suggestion) => ({
        merchantKey: suggestion.merchantKey,
        categoryId: suggestion.suggestedCategoryId,
        dismissedAt: suggestion.decidedAt ?? suggestion.createdAt,
      }));
  }

  /** Applies every side-effect action from matching rules besides the category decision itself. */
  private applyRuleActions(
    txn: FinanceTransaction,
    actions: FinanceRuleActions | null | undefined,
    now: string,
  ): FinanceTransaction {
    if (!actions) {
      return txn;
    }
    let labelsJson = txn.labelsJson;
    if (actions.addLabels && actions.addLabels.length > 0) {
      const existing: string[] = labelsJson ? JSON.parse(labelsJson) : [];
      labelsJson = JSON.stringify([...new Set([...existing, ...actions.addLabels])]);
    }
    return {
      ...txn,
      merchantDisplay: actions.merchantDisplay ?? txn.merchantDisplay,
      personId: actions.personId ?? txn.personId,
      excludedFromBudget: actions.excludeFromBudget ?? txn.excludedFromBudget,
      excludedFromReports: actions.excludeFromReports ?? txn.excludedFromReports,
      isTransfer: actions.markTransfer ?? txn.isTransfer,
      labelsJson,
      updatedAt: now,
    };
  }

  /** Writes a `ClassificationOutcome` to the transaction (and a suggestion when owed). Returns whether a suggestion was created. */
  private applyClassificationOutcome(
    transactionId: string,
    outcome: ClassificationOutcome,
    now: string,
  ): boolean {
    const txn = this.transactions.get(transactionId);
    if (!txn) {
      return false;
    }
    const withActions = this.applyRuleActions(txn, outcome.ruleActions, now);
    const categoryChanged =
      withActions.categoryId !== outcome.categoryId ||
      withActions.categorySource !== outcome.categorySource;
    this.transactions.set(transactionId, {
      ...withActions,
      categoryId: outcome.categoryId,
      categorySource: outcome.categorySource,
      categoryConfidence: outcome.categoryConfidence,
      categorizedAt:
        categoryChanged && outcome.categorySource !== "default" ? now : withActions.categorizedAt,
      updatedAt: now,
    });
    if (outcome.matchedRule) {
      const rule = this.rules.get(outcome.matchedRule.id);
      if (rule) {
        this.rules.set(rule.id, {
          ...rule,
          appliedCount: rule.appliedCount + 1,
          lastAppliedAt: now,
        });
      }
    }
    if (outcome.suggestion) {
      return this.insertPendingSuggestion(
        transactionId,
        outcome.suggestion.categoryId,
        outcome.suggestion.origin,
        outcome.suggestion.confidence,
      );
    }
    return false;
  }

  /**
   * Re-runs classification (rules, memory, seeds — no AI, no transfer
   * re-detection) over every non-`user` transaction. Used after a rule is
   * created/edited and by the "Réappliquer les règles" action on
   * `/finances/review`.
   */
  reclassifyPending(): ReclassifyFinancePendingResult {
    const now = nowIso();
    const today = localDate(now);
    const rules = [...this.rules.values()];
    const memory = [...this.merchantMemory.values()];
    const dismissed = this.buildDismissedPairs();

    let reclassified = 0;
    let suggestionsCreated = 0;

    for (const txn of [...this.transactions.values()]) {
      if (txn.categorySource === "user" || txn.isTransfer) {
        continue;
      }
      const before = { categoryId: txn.categoryId, categorySource: txn.categorySource };
      const outcome = classifyTransaction(
        {
          categoryId: txn.categoryId,
          categorySource: txn.categorySource,
          accountId: txn.accountId,
          amountMinor: txn.amountMinor,
          merchantKey: txn.merchantKey,
          personId: txn.personId,
        },
        { rules, memory, dismissed, today },
      );
      const suggestionCreated = this.applyClassificationOutcome(txn.id, outcome, now);
      if (suggestionCreated) {
        suggestionsCreated += 1;
      }
      if (
        before.categoryId !== outcome.categoryId ||
        before.categorySource !== outcome.categorySource
      ) {
        reclassified += 1;
      }
    }

    return { reclassified, suggestionsCreated };
  }

  undoImportBatch(batchId: string): UndoFinanceImportBatchResult {
    const batch = this.importBatches.get(batchId);
    if (!batch) {
      throw new Error(`finance import batch not found: ${batchId}`);
    }

    const rowsInBatch = [...this.transactions.values()].filter(
      (txn) => txn.importBatchId === batchId,
    );
    // Every account the batch touched must have this batch as its newest one. Map insertion
    // order breaks equal-timestamp ties (later insert wins), mirroring SQLite's rowid.
    const accountIds = new Set<string>(rowsInBatch.map((txn) => txn.accountId));
    if (batch.accountId) {
      accountIds.add(batch.accountId);
    }
    const orderedBatches = [...this.importBatches.values()].map((item, index) => ({ item, index }));
    for (const accountId of accountIds) {
      const mostRecent = orderedBatches
        .filter(({ item }) => item.accountId === accountId)
        .sort((a, b) => b.item.startedAt.localeCompare(a.item.startedAt) || b.index - a.index)[0];
      if (mostRecent && mostRecent.item.id !== batchId) {
        throw new Error(
          `undoFinanceImportBatch is restricted to the most recent batch for account ${accountId}`,
        );
      }
    }

    const now = nowIso();

    let deleted = 0;
    let refusedUserCategorized = 0;

    for (const row of rowsInBatch) {
      if (row.categorySource === "user") {
        refusedUserCategorized += 1;
        continue;
      }

      for (const [splitId, split] of [...this.splits.entries()]) {
        if (split.transactionId === row.id) {
          this.splits.delete(splitId);
        }
      }
      for (const [suggestionId, suggestion] of [...this.categorySuggestions.entries()]) {
        if (suggestion.transactionId === row.id) {
          this.categorySuggestions.delete(suggestionId);
        }
      }

      if (row.transferGroupId) {
        for (const partner of [...this.transactions.values()]) {
          if (partner.transferGroupId === row.transferGroupId && partner.id !== row.id) {
            if (partner.categorySource === "user") {
              // Keep the user's category, provenance, and exclusions; only drop the dead link.
              this.transactions.set(partner.id, {
                ...partner,
                isTransfer: false,
                transferGroupId: null,
                updatedAt: now,
              });
              continue;
            }
            this.transactions.set(partner.id, {
              ...partner,
              isTransfer: false,
              transferGroupId: null,
              categoryId: "fincat:non-categorise",
              categorySource: "default",
              excludedFromBudget: false,
              updatedAt: now,
            });
            for (const [suggestionId, suggestion] of [...this.categorySuggestions.entries()]) {
              if (suggestion.transactionId === partner.id && suggestion.status === "pending") {
                this.categorySuggestions.delete(suggestionId);
              }
            }
            this.insertPendingSuggestion(partner.id, "fincat:non-categorise");
          }
        }
      }

      this.transactions.delete(row.id);
      deleted += 1;
    }

    return { deleted, refusedUserCategorized };
  }

  // --- category suggestions -------------------------------------------------------------

  listCategorySuggestions(
    status?: FinanceCategorySuggestion["status"],
    limit?: number,
  ): FinanceCategorySuggestion[] {
    let suggestions = [...this.categorySuggestions.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    if (status) {
      suggestions = suggestions.filter((suggestion) => suggestion.status === status);
    }
    return limit !== undefined ? suggestions.slice(0, limit) : suggestions;
  }

  saveCategorySuggestions(suggestions: FinanceCategorySuggestion[]): FinanceCategorySuggestion[] {
    const now = nowIso();
    return suggestions.map((suggestion) => {
      const id = suggestion.id || createEntityId("finance-suggestion");
      const saved: FinanceCategorySuggestion = {
        ...suggestion,
        id,
        createdAt: suggestion.createdAt || now,
      };
      this.categorySuggestions.set(id, saved);
      return saved;
    });
  }

  decideCategorySuggestion(
    id: string,
    decision: DecideFinanceCategorySuggestionInput,
  ): FinanceCategorySuggestion {
    const now = nowIso();
    const suggestion = this.categorySuggestions.get(id);
    if (!suggestion) {
      throw new Error(`finance category suggestion not found: ${id}`);
    }

    const updated: FinanceCategorySuggestion = {
      ...suggestion,
      status: decision.status,
      decidedAt: now,
    };
    this.categorySuggestions.set(id, updated);

    if (decision.status === "accepted" || decision.status === "corrected") {
      this.setTransactionCategory({
        transactionId: suggestion.transactionId,
        categoryId: decision.categoryId ?? suggestion.suggestedCategoryId,
        scope: "this",
      });
    }

    return updated;
  }
}
