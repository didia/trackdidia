import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  addMonthsToMonthKey,
  computeEnvelopePaceFromState,
  computeUnbudgetedAssignAmountMinor,
  selectUnbudgetedCategories,
  type FinanceBudgetState,
} from "../domain/finance/budget";
import { computeDerivedBalanceMinor } from "../domain/finance/account-balance";
import type {
  FinanceBudgetMonth,
  FinanceCategory,
  FinanceOverspendPolicy,
} from "../domain/finance";
import { getMonthKey, getMonthEndDate, listMonthDates } from "../domain/monthly-review";
import {
  currencyExponent,
  formatMoney,
  minorToInputString,
  parseAmountToMinor,
} from "../lib/finance/money";
import { getTodayDate } from "../lib/date";

const OVERSPEND_POLICIES: FinanceOverspendPolicy[] = [
  "reduce_next_ready_to_assign",
  "carry_negative",
];

interface CategoryGroup {
  group: FinanceCategory;
  leaves: FinanceCategory[];
}

const buildGroups = (categories: FinanceCategory[]): CategoryGroup[] => {
  const topLevel = categories.filter(
    (category) => category.parentId === null && category.kind === "expense",
  );
  return topLevel.map((group) => ({
    group,
    leaves: categories.filter(
      (category) => category.parentId === group.id && category.kind === "expense",
    ),
  }));
};

/** A parent category can receive spending directly; give it a row once it has any figure. */
const hasBudgetFigures = (row: FinanceBudgetState["categories"][number] | undefined): boolean =>
  row !== undefined &&
  (row.activityMinor !== 0 || row.assignedMinor !== 0 || row.availableMinor !== 0);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const FinanceBudgetPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const baseCurrency = settings.financeBaseCurrency;
  const exponent = currencyExponent(baseCurrency);
  const today = getTodayDate();

  const [monthKey, setMonthKey] = useState(() => getMonthKey(today));
  const [budgetMonth, setBudgetMonth] = useState<FinanceBudgetMonth | null>(null);
  const [state, setState] = useState<FinanceBudgetState | null>(null);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [cardBalances, setCardBalances] = useState<Record<string, { name: string; minor: number }>>(
    {},
  );
  const [assignDrafts, setAssignDrafts] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState("");
  const [coverFromByCategory, setCoverFromByCategory] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);
  const loadIdRef = useRef(0);
  // Every write runs through this chain so overlapping clicks execute one at a time; each
  // task re-reads fresh state from the repository instead of trusting the rendered snapshot.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const isStale = () => loadId !== loadIdRef.current;
    const [nextMonth, nextState, nextCategories, accounts] = await Promise.all([
      repository.getFinanceBudgetMonth(monthKey),
      repository.computeFinanceBudgetState(monthKey),
      repository.listFinanceCategories(),
      repository.listFinanceAccounts({ onBudgetOnly: true }),
    ]);
    if (isStale()) {
      return;
    }
    setBudgetMonth(nextMonth);
    setState(nextState);
    setCategories(nextCategories);
    setNoteDraft(nextMonth.readyToAssignNote ?? "");
    setAssignDrafts(
      Object.fromEntries(
        nextState.categories.map((category) => [
          category.categoryId,
          minorToInputString(category.assignedMinor, exponent),
        ]),
      ),
    );

    const creditCardAccounts = accounts.filter((account) => account.type === "credit_card");
    const balances: Record<string, { name: string; minor: number }> = {};
    for (const account of creditCardAccounts) {
      const transactions = await repository.listFinanceTransactions({ accountIds: [account.id] });
      balances[account.id] = {
        name: account.name,
        minor: computeDerivedBalanceMinor(account, transactions),
      };
    }
    if (!isStale()) {
      setCardBalances(balances);
    }
  }, [repository, monthKey, exponent]);

  useEffect(() => {
    setError(null);
    load().catch((loadError: unknown) => setError(errorMessage(loadError)));
  }, [load]);

  const enqueue = (task: () => Promise<void>) => {
    const run = queueRef.current.then(async () => {
      try {
        await task();
        await load();
        setError(null);
      } catch (taskError) {
        setError(errorMessage(taskError));
        await load().catch(() => undefined);
      }
    });
    queueRef.current = run;
    return run;
  };

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const groups = useMemo(() => buildGroups(categories), [categories]);
  const closed = budgetMonth?.closedAt != null;

  const stateCategoryById = useMemo(
    () => new Map((state?.categories ?? []).map((category) => [category.categoryId, category])),
    [state],
  );

  const elapsedAndTotalDays = useMemo(() => {
    const dates = listMonthDates(monthKey);
    const totalDays = dates.length;
    const monthEnd = getMonthEndDate(monthKey);
    if (today > monthEnd) {
      return { elapsedDays: totalDays, totalDays };
    }
    const elapsedDays = dates.filter((date) => date <= today).length;
    return { elapsedDays, totalDays };
  }, [monthKey, today]);

  const commitAssignment = (categoryId: string, text: string) => {
    const parsed = parseAmountToMinor(text || "0", { exponent });
    if (!parsed.ok) {
      return;
    }
    // An untouched field (e.g. a displayed 0.00) must not rewrite the row.
    if (parsed.amountMinor === (stateCategoryById.get(categoryId)?.assignedMinor ?? 0)) {
      return;
    }
    return enqueue(async () => {
      await repository.setFinanceBudgetAssignment(monthKey, categoryId, parsed.amountMinor);
    });
  };

  const changePolicy = (categoryId: string, policy: FinanceOverspendPolicy) =>
    enqueue(async () => {
      await repository.setFinanceCategoryOverspendPolicy(monthKey, categoryId, policy);
    });

  const saveNote = () =>
    enqueue(async () => {
      await repository.setFinanceBudgetReadyToAssignNote(monthKey, noteDraft || null);
    });

  const toggleClosed = () =>
    enqueue(async () => {
      await repository.setFinanceBudgetMonthClosed(monthKey, !closed);
    });

  // Quick-action amounts come from a fresh `computeFinanceBudgetState` read inside the queued
  // task (never the rendered snapshot), so overlapping clicks cannot reuse a stale Ready to Assign.
  const assignFromFreshState = (
    categoryId: string,
    pick: (row: FinanceBudgetState["categories"][number]) => number,
  ) =>
    enqueue(async () => {
      const fresh = await repository.computeFinanceBudgetState(monthKey);
      const row = fresh.categories.find((candidate) => candidate.categoryId === categoryId);
      await repository.setFinanceBudgetAssignment(monthKey, categoryId, row ? pick(row) : 0);
    });

  const assignLastMonth = (categoryId: string) =>
    assignFromFreshState(categoryId, (row) => row.lastMonthAssignedMinor);

  const assignAverageLast3Months = (categoryId: string) =>
    assignFromFreshState(categoryId, (row) => row.average3MonthsAssignedMinor);

  const assignAllReadyToAssign = (categoryId: string) =>
    assignFromFreshState(categoryId, (row) => row.assignAllReadyToAssignMinor);

  const coverOverspending = (toCategoryId: string) => {
    const fromCategoryId = coverFromByCategory[toCategoryId];
    if (!fromCategoryId) {
      return;
    }
    return enqueue(async () => {
      await repository.applyFinanceCoverOverspending(monthKey, fromCategoryId, toCategoryId);
    });
  };

  const assignUnbudgeted = (categoryId: string) =>
    assignFromFreshState(
      categoryId,
      (row) => row.assignedMinor + computeUnbudgetedAssignAmountMinor(row),
    );

  const renderCategoryRow = (category: FinanceCategory) => {
    const row = stateCategoryById.get(category.id);
    if (!row) {
      return null;
    }
    const pace = computeEnvelopePaceFromState(
      row,
      elapsedAndTotalDays.elapsedDays,
      elapsedAndTotalDays.totalDays,
    );
    return (
      <div key={category.id} className="inline-form" data-testid={`budget-row-${category.id}`}>
        <span>{category.name}</span>
        <label>
          <span>{t("budget.fields.assigned")}</span>
          <input
            type="text"
            value={assignDrafts[category.id] ?? ""}
            disabled={closed}
            onChange={(event) =>
              setAssignDrafts((current) => ({ ...current, [category.id]: event.target.value }))
            }
            onBlur={(event) => void commitAssignment(category.id, event.target.value)}
          />
        </label>
        <span>
          {t("budget.fields.activity")}:{" "}
          {formatMoney({ amountMinor: row.activityMinor, currency: baseCurrency })}
        </span>
        <span data-testid={`available-${category.id}`}>
          {t("budget.fields.available")}:{" "}
          {formatMoney({ amountMinor: row.availableMinor, currency: baseCurrency })}
        </span>
        <select
          value={row.overspendPolicy}
          disabled={closed}
          onChange={(event) =>
            void changePolicy(category.id, event.target.value as FinanceOverspendPolicy)
          }
        >
          {OVERSPEND_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {t(`budget.overspendPolicies.${policy}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button"
          disabled={closed}
          onClick={() => void assignLastMonth(category.id)}
        >
          {t("budget.quickActions.lastMonth")}
        </button>
        <button
          type="button"
          className="button"
          disabled={closed}
          onClick={() => void assignAverageLast3Months(category.id)}
        >
          {t("budget.quickActions.average3Months")}
        </button>
        <button
          type="button"
          className="button"
          disabled={closed}
          onClick={() => void assignAllReadyToAssign(category.id)}
        >
          {t("budget.quickActions.assignAllReadyToAssign")}
        </button>
        {row.availableMinor < 0 ? (
          <>
            <select
              value={coverFromByCategory[category.id] ?? ""}
              disabled={closed}
              onChange={(event) =>
                setCoverFromByCategory((current) => ({
                  ...current,
                  [category.id]: event.target.value,
                }))
              }
            >
              <option value="" disabled>
                {t("budget.quickActions.pickSourceCategory")}
              </option>
              {categories
                .filter((candidate) => candidate.kind === "expense" && candidate.id !== category.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="button"
              disabled={closed}
              onClick={() => void coverOverspending(category.id)}
            >
              {t("budget.quickActions.coverOverspending")}
            </button>
          </>
        ) : null}
        <span data-testid={`pace-${category.id}`}>
          {t("budget.pace", { percent: Math.round(pace.fractionSpent * 100) })}
        </span>
      </div>
    );
  };

  const unbudgeted = state ? selectUnbudgetedCategories(state) : [];

  return (
    <div className="page">
      <PageHeader eyebrow={t("budget.hero.eyebrow")} title={t("budget.hero.title")} />
      <FinanceTabs />

      {error ? (
        <p role="alert" className="hero__copy">
          {error}
        </p>
      ) : null}

      <SectionCard title={t("budget.monthSelectorTitle")}>
        <div className="actions-row">
          <button
            type="button"
            className="button"
            onClick={() => setMonthKey((current) => addMonthsToMonthKey(current, -1))}
          >
            {t("budget.previousMonth")}
          </button>
          <span>{monthKey}</span>
          <button
            type="button"
            className="button"
            onClick={() => setMonthKey((current) => addMonthsToMonthKey(current, 1))}
          >
            {t("budget.nextMonth")}
          </button>
          <button type="button" className="button" onClick={() => void toggleClosed()}>
            {closed ? t("budget.reopenMonth") : t("budget.closeMonth")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("budget.readyToAssignTitle")}>
        <p className="hero__copy" data-testid="ready-to-assign">
          {formatMoney({ amountMinor: state?.readyToAssignMinor ?? 0, currency: baseCurrency })}
        </p>
        <label>
          <span>{t("budget.readyToAssignNote")}</span>
          <input
            type="text"
            value={noteDraft}
            disabled={closed}
            onChange={(event) => setNoteDraft(event.target.value)}
            onBlur={() => void saveNote()}
          />
        </label>
      </SectionCard>

      {Object.keys(cardBalances).length > 0 ? (
        <SectionCard title={t("budget.cardBalancesTitle")}>
          <div className="stack">
            {Object.entries(cardBalances).map(([accountId, card]) => (
              <p key={accountId}>
                {card.name}: {formatMoney({ amountMinor: card.minor, currency: baseCurrency })}
              </p>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title={t("budget.envelopesTitle")}>
        <div className="stack">
          {groups.map(({ group, leaves }) => (
            <article key={group.id} className="list-card">
              <h3>{group.name}</h3>
              <div className="stack">
                {leaves.length === 0 || hasBudgetFigures(stateCategoryById.get(group.id))
                  ? renderCategoryRow(group)
                  : null}
                {leaves.map((leaf) => renderCategoryRow(leaf))}
              </div>
            </article>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("budget.unbudgetedTitle", { count: unbudgeted.length })}>
        {unbudgeted.length === 0 ? <p>{t("budget.noUnbudgeted")}</p> : null}
        <div className="stack">
          {unbudgeted.map((category) => (
            <div key={category.categoryId} className="inline-form">
              <span>{categoryNameById.get(category.categoryId) ?? category.categoryId}</span>
              <span>
                {formatMoney({ amountMinor: category.activityMinor, currency: baseCurrency })}
              </span>
              <button
                type="button"
                className="button"
                disabled={closed}
                onClick={() => void assignUnbudgeted(category.categoryId)}
              >
                {t("budget.unbudgetedAssign")}
              </button>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};
