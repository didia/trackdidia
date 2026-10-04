import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceCategoryBackfillEntry,
  FinancePerson,
  FinanceTransaction,
  FinanceTransactionCategoryScope,
  FinanceTransactionSplit,
} from "../domain/finance";
import { currencyExponent, formatMoney, parseAmountToMinor } from "../lib/finance/money";
import { createEntityId, nowIso } from "../lib/gtd/shared";

const PAGE_SIZE = 25;

// The system "Uncategorized" category id — see src/lib/finance/default-categories.ts
// and docs/finance.md "Data model". Transactions never carry a null categoryId
// in practice (import always defaults to this id), but the per-row select
// falls back to it rather than offering an empty "" option with no category
// behind it.
const UNCATEGORIZED_CATEGORY_ID = "fincat:non-categorise";

interface SplitDraftRow {
  id: string;
  amountText: string;
  categoryId: string;
}

export const FinanceTransactionsPage = () => {
  const { t } = useTranslation("finance");
  const { repository } = useAppContext();
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [people, setPeople] = useState<FinancePerson[]>([]);
  const [transactions, setTransactions] = useState<FinanceTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [personFilter, setPersonFilter] = useState("");
  const [search, setSearch] = useState("");
  const [uncategorizedOnly, setUncategorizedOnly] = useState(false);

  const [categoryScopeByTxnId, setCategoryScopeByTxnId] = useState<
    Record<string, FinanceTransactionCategoryScope>
  >({});
  const [splitEditorTxnId, setSplitEditorTxnId] = useState<string | null>(null);
  const [splitDrafts, setSplitDrafts] = useState<SplitDraftRow[]>([]);
  const [splitError, setSplitError] = useState("");
  // Transaction whose existing allocation has finished loading into `splitDrafts`; Save stays
  // disabled until it matches the open editor so stale drafts can never be written.
  const [splitLoadedTxnId, setSplitLoadedTxnId] = useState<string | null>(null);
  const splitRequestRef = useRef(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [transferPairWarning, setTransferPairWarning] = useState<string | null>(null);
  const [lastBackfill, setLastBackfill] = useState<{
    count: number;
    entries: FinanceCategoryBackfillEntry[];
  } | null>(null);

  const filters = useMemo(
    () => ({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      accountIds: accountFilter ? [accountFilter] : undefined,
      categoryIds: categoryFilter ? [categoryFilter] : undefined,
      personIds: personFilter ? [personFilter] : undefined,
      search: search || undefined,
      uncategorizedOnly: uncategorizedOnly || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [
      dateFrom,
      dateTo,
      accountFilter,
      categoryFilter,
      personFilter,
      search,
      uncategorizedOnly,
      page,
    ],
  );

  const load = useCallback(async () => {
    const [nextAccounts, nextCategories, nextPeople, nextTransactions, count] = await Promise.all([
      repository.listFinanceAccounts({ includeClosed: true }),
      repository.listFinanceCategories(),
      repository.listFinancePeople(),
      repository.listFinanceTransactions(filters),
      repository.countFinanceTransactions(filters),
    ]);
    setAccounts(nextAccounts);
    setCategories(nextCategories);
    setPeople(nextPeople);
    setTransactions(nextTransactions);
    setTotal(count);
    setSelectedIds(new Set());
  }, [repository, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Edits can shrink the result set below the current page; clamp back into range.
  useEffect(() => {
    if (page > 0 && page >= pageCount) {
      setPage(pageCount - 1);
    }
  }, [page, pageCount]);

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const setCategory = async (transaction: FinanceTransaction, categoryId: string) => {
    const scope = categoryScopeByTxnId[transaction.id] ?? "this";
    const result = await repository.setFinanceTransactionCategory({
      transactionId: transaction.id,
      categoryId,
      scope,
    });
    // Only a newer bulk edit replaces the undo handle; ordinary edits leave it intact.
    if (scope === "all_matching" && result.backfill.length > 0) {
      setLastBackfill({ count: result.backfill.length, entries: result.backfill });
    }
    await load();
  };

  const undoLastBackfill = async () => {
    if (!lastBackfill) {
      return;
    }
    await repository.revertFinanceCategoryBackfill(lastBackfill.entries);
    setLastBackfill(null);
    await load();
  };

  const unmarkTransfer = async (transaction: FinanceTransaction) => {
    await repository.clearFinanceTransfer(transaction.id);
    await load();
  };

  const markSelectedAsTransferPair = async () => {
    const selected = transactions.filter((transaction) => selectedIds.has(transaction.id));
    if (selected.length !== 2) {
      return;
    }
    const [first, second] = selected;
    setTransferPairWarning(
      first.accountId === second.accountId
        ? t("transactions.transferPair.sameAccountWarning")
        : Math.abs(first.amountMinor) !== Math.abs(second.amountMinor)
          ? t("transactions.transferPair.amountMismatchWarning")
          : null,
    );
    await repository.setFinanceTransfer({
      transactionIdA: first.id,
      transactionIdB: second.id,
    });
    await load();
  };

  const toggleExcluded = async (
    transaction: FinanceTransaction,
    field: "excludedFromBudget" | "excludedFromReports",
  ) => {
    await repository.bulkUpdateFinanceTransactions([transaction.id], {
      [field]: !transaction[field],
    });
    await load();
  };

  const openSplitEditor = (transaction: FinanceTransaction) => {
    const requestId = splitRequestRef.current + 1;
    splitRequestRef.current = requestId;
    setSplitEditorTxnId(transaction.id);
    setSplitLoadedTxnId(null);
    setSplitDrafts([]);
    setSplitError("");
    void repository.listFinanceTransactionSplits(transaction.id).then((existing) => {
      // A newer open/close superseded this read; its response must not touch the drafts.
      if (splitRequestRef.current !== requestId) {
        return;
      }
      setSplitLoadedTxnId(transaction.id);
      if (existing.length > 0) {
        setSplitDrafts(
          existing.map((split) => ({
            id: split.id,
            amountText: (split.amountMinor / 10 ** currencyExponent(transaction.currency)).toFixed(
              currencyExponent(transaction.currency),
            ),
            categoryId: split.categoryId ?? "",
          })),
        );
      } else {
        setSplitDrafts([
          {
            id: createEntityId("finance-split"),
            amountText: (
              transaction.amountMinor /
              10 ** currencyExponent(transaction.currency)
            ).toFixed(currencyExponent(transaction.currency)),
            categoryId: "",
          },
        ]);
      }
    });
  };

  const addSplitRow = () => {
    setSplitDrafts((current) => [
      ...current,
      { id: createEntityId("finance-split"), amountText: "0", categoryId: "" },
    ]);
  };

  const removeSplitRow = (id: string) => {
    setSplitDrafts((current) => current.filter((row) => row.id !== id));
  };

  const closeSplitEditor = () => {
    splitRequestRef.current += 1;
    setSplitEditorTxnId(null);
    setSplitLoadedTxnId(null);
    setSplitDrafts([]);
  };

  const saveSplits = async (transaction: FinanceTransaction) => {
    if (splitLoadedTxnId !== transaction.id) {
      return;
    }
    const exponent = currencyExponent(transaction.currency);
    const parsedAmounts = splitDrafts.map((row) =>
      parseAmountToMinor(row.amountText, { exponent }),
    );
    const invalidRow = parsedAmounts.find((parsed) => !parsed.ok);
    if (invalidRow) {
      setSplitError(t("transactions.split.invalidAmount"));
      return;
    }

    const sum = parsedAmounts.reduce(
      (total, parsed) => total + (parsed.ok ? parsed.amountMinor : 0),
      0,
    );
    // An empty allocation is an explicit "remove splits"; only non-empty ones must balance.
    if (splitDrafts.length > 0 && sum !== transaction.amountMinor) {
      setSplitError(t("transactions.split.sumMismatch"));
      return;
    }

    const splits: FinanceTransactionSplit[] = splitDrafts.map((row, index) => ({
      id: row.id,
      transactionId: transaction.id,
      amountMinor: parsedAmounts[index].ok ? parsedAmounts[index].amountMinor : 0,
      categoryId: row.categoryId || null,
      notes: null,
      sortOrder: index,
      createdAt: nowIso(),
    }));

    await repository.saveFinanceTransactionSplits(transaction.id, splits);
    closeSplitEditor();
    setSplitError("");
    await load();
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const bulkApplyCategory = async (categoryId: string) => {
    if (selectedIds.size === 0 || !categoryId) {
      return;
    }
    await repository.bulkUpdateFinanceTransactions([...selectedIds], { categoryId });
    await load();
  };

  const bulkExclude = async (field: "excludedFromBudget" | "excludedFromReports") => {
    if (selectedIds.size === 0) {
      return;
    }
    await repository.bulkUpdateFinanceTransactions([...selectedIds], { [field]: true });
    await load();
  };

  return (
    <div className="page">
      <PageHeader eyebrow={t("transactions.hero.eyebrow")} title={t("transactions.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("transactions.filtersTitle")}>
        <div className="form-grid">
          <label>
            <span>{t("transactions.filters.dateFrom")}</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            <span>{t("transactions.filters.dateTo")}</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            <span>{t("transactions.filters.account")}</span>
            <select
              value={accountFilter}
              onChange={(event) => {
                setAccountFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="">{t("transactions.filters.all")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("transactions.filters.category")}</span>
            <select
              value={categoryFilter}
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="">{t("transactions.filters.all")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("transactions.filters.person")}</span>
            <select
              value={personFilter}
              onChange={(event) => {
                setPersonFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="">{t("transactions.filters.all")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("transactions.filters.search")}</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={uncategorizedOnly}
              onChange={(event) => {
                setUncategorizedOnly(event.target.checked);
                setPage(0);
              }}
            />
            <span>{t("transactions.filters.uncategorizedOnly")}</span>
          </label>
        </div>
      </SectionCard>

      {selectedIds.size > 0 ? (
        <SectionCard title={t("transactions.bulkTitle", { count: selectedIds.size })}>
          <div className="actions-row">
            <select
              onChange={(event) => void bulkApplyCategory(event.target.value)}
              defaultValue=""
            >
              <option value="" disabled>
                {t("transactions.bulkApplyCategory")}
              </option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button"
              onClick={() => void bulkExclude("excludedFromBudget")}
            >
              {t("transactions.bulkExcludeBudget")}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void bulkExclude("excludedFromReports")}
            >
              {t("transactions.bulkExcludeReports")}
            </button>
            <button
              type="button"
              className="button"
              disabled={selectedIds.size !== 2}
              onClick={() => void markSelectedAsTransferPair()}
            >
              {t("transactions.markTransferPair")}
            </button>
          </div>
          {selectedIds.size !== 2 ? (
            <p className="field-card__helper">{t("transactions.transferPair.needsTwo")}</p>
          ) : null}
          {transferPairWarning ? <p className="banner">{transferPairWarning}</p> : null}
        </SectionCard>
      ) : null}

      {lastBackfill ? (
        <SectionCard title={t("transactions.backfill.title")}>
          <p>{t("transactions.backfill.message", { count: lastBackfill.count })}</p>
          <div className="actions-row">
            <button type="button" className="button" onClick={() => void undoLastBackfill()}>
              {t("transactions.backfill.undo")}
            </button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title={t("transactions.listTitle")}>
        {transactions.length === 0 ? <p>{t("transactions.noResults")}</p> : null}
        <div className="stack">
          {transactions.map((transaction) => {
            const account = accountById.get(transaction.accountId);
            return (
              <article key={transaction.id} className="list-card">
                <div className="inline-form">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(transaction.id)}
                    onChange={() => toggleSelected(transaction.id)}
                  />
                  <h3>{transaction.descriptionRaw}</h3>
                </div>
                <p>
                  {transaction.postedDate} · {account?.name ?? ""} ·{" "}
                  {formatMoney({
                    amountMinor: transaction.amountMinor,
                    currency: transaction.currency,
                  })}{" "}
                  ·{" "}
                  <span className="tag-chip">
                    {t(`transactions.categorySource.${transaction.categorySource}`)}
                  </span>
                </p>
                <label>
                  <span>{t("transactions.category")}</span>
                  <select
                    value={transaction.categoryId ?? UNCATEGORIZED_CATEGORY_ID}
                    onChange={(event) => void setCategory(transaction, event.target.value)}
                  >
                    <option value={UNCATEGORIZED_CATEGORY_ID}>
                      {t("transactions.uncategorized")}
                    </option>
                    {categories
                      .filter((category) => category.id !== UNCATEGORIZED_CATEGORY_ID)
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>{t("transactions.scope")}</span>
                  <select
                    value={categoryScopeByTxnId[transaction.id] ?? "this"}
                    onChange={(event) =>
                      setCategoryScopeByTxnId((current) => ({
                        ...current,
                        [transaction.id]: event.target.value as FinanceTransactionCategoryScope,
                      }))
                    }
                  >
                    <option value="this">{t("transactions.scopes.this")}</option>
                    <option value="this_and_future">
                      {t("transactions.scopes.this_and_future")}
                    </option>
                    <option value="all_matching">{t("transactions.scopes.all_matching")}</option>
                  </select>
                </label>
                <div className="actions-row">
                  {transaction.isTransfer ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => void unmarkTransfer(transaction)}
                    >
                      {t("transactions.unmarkTransfer")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    onClick={() => void toggleExcluded(transaction, "excludedFromBudget")}
                  >
                    {transaction.excludedFromBudget
                      ? t("transactions.includeInBudget")
                      : t("transactions.excludeFromBudget")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void toggleExcluded(transaction, "excludedFromReports")}
                  >
                    {transaction.excludedFromReports
                      ? t("transactions.includeInReports")
                      : t("transactions.excludeFromReports")}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => openSplitEditor(transaction)}
                  >
                    {t("transactions.editSplits")}
                  </button>
                </div>

                {splitEditorTxnId === transaction.id ? (
                  <div className="stack">
                    {splitDrafts.map((row) => (
                      <div key={row.id} className="inline-form">
                        <input
                          value={row.amountText}
                          onChange={(event) =>
                            setSplitDrafts((current) =>
                              current.map((item) =>
                                item.id === row.id
                                  ? { ...item, amountText: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                        <select
                          value={row.categoryId}
                          onChange={(event) =>
                            setSplitDrafts((current) =>
                              current.map((item) =>
                                item.id === row.id
                                  ? { ...item, categoryId: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="">{t("transactions.filters.all")}</option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="button"
                          onClick={() => removeSplitRow(row.id)}
                        >
                          {t("transactions.split.remove")}
                        </button>
                      </div>
                    ))}
                    {splitError ? <p className="field-error">{splitError}</p> : null}
                    <div className="actions-row">
                      <button type="button" className="button" onClick={addSplitRow}>
                        {t("transactions.split.addRow")}
                      </button>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={splitLoadedTxnId !== transaction.id}
                        onClick={() => void saveSplits(transaction)}
                      >
                        {t("transactions.split.save")}
                      </button>
                      <button type="button" className="button" onClick={closeSplitEditor}>
                        {t("transactions.split.cancel")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        <div className="actions-row">
          <button
            type="button"
            className="button"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            {t("transactions.previousPage")}
          </button>
          <span>{t("transactions.pageIndicator", { page: page + 1, pageCount })}</span>
          <button
            type="button"
            className="button"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("transactions.nextPage")}
          </button>
        </div>
      </SectionCard>
    </div>
  );
};
