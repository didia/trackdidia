import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type {
  FinanceAccount,
  FinanceCategory,
  FinancePerson,
  FinanceTransaction,
  FinanceTransactionCategoryScope,
  FinanceTransactionSplit,
} from "../domain/finance";
import { currencyExponent, formatMoney, parseAmountToMinor } from "../lib/finance/money";
import { createEntityId, nowIso } from "../lib/gtd/shared";

const PAGE_SIZE = 25;

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const setCategory = async (transaction: FinanceTransaction, categoryId: string) => {
    const scope = categoryScopeByTxnId[transaction.id] ?? "this";
    await repository.setFinanceTransactionCategory({
      transactionId: transaction.id,
      categoryId,
      scope,
    });
    await load();
  };

  const toggleTransfer = async (transaction: FinanceTransaction) => {
    if (transaction.isTransfer) {
      await repository.clearFinanceTransfer(transaction.id);
    } else {
      // Marking a single row as a transfer without a known partner is not
      // supported from this toolbar — only clearing is available here. A
      // paired set action belongs to a future phase's transfer-matching UI.
      return;
    }
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
    setSplitEditorTxnId(transaction.id);
    setSplitError("");
    void repository.listFinanceTransactionSplits(transaction.id).then((existing) => {
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

  const saveSplits = async (transaction: FinanceTransaction) => {
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
    if (sum !== transaction.amountMinor) {
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
    setSplitEditorTxnId(null);
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

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label>
            <span>{t("transactions.filters.dateTo")}</span>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          <label>
            <span>{t("transactions.filters.account")}</span>
            <select
              value={accountFilter}
              onChange={(event) => setAccountFilter(event.target.value)}
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
              onChange={(event) => setCategoryFilter(event.target.value)}
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
            <select value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}>
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
            <input value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={uncategorizedOnly}
              onChange={(event) => setUncategorizedOnly(event.target.checked)}
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
                  })}
                </p>
                <label>
                  <span>{t("transactions.category")}</span>
                  <select
                    value={transaction.categoryId ?? ""}
                    onChange={(event) => void setCategory(transaction, event.target.value)}
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
                  <button
                    type="button"
                    className="button"
                    onClick={() => void toggleTransfer(transaction)}
                  >
                    {transaction.isTransfer
                      ? t("transactions.unmarkTransfer")
                      : t("transactions.markTransfer")}
                  </button>
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
                        onClick={() => void saveSplits(transaction)}
                      >
                        {t("transactions.split.save")}
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={() => setSplitEditorTxnId(null)}
                      >
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
