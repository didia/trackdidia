import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  addMonthsToMonthKey,
  computeEnvelopePaceFromState,
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
import { formatMoney, parseAmountToMinor } from "../lib/finance/money";
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

export const FinanceBudgetPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const baseCurrency = settings.financeBaseCurrency;
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

  const load = useCallback(async () => {
    const [nextMonth, nextState, nextCategories, accounts] = await Promise.all([
      repository.getFinanceBudgetMonth(monthKey),
      repository.computeFinanceBudgetState(monthKey),
      repository.listFinanceCategories(),
      repository.listFinanceAccounts({ onBudgetOnly: true }),
    ]);
    setBudgetMonth(nextMonth);
    setState(nextState);
    setCategories(nextCategories);
    setNoteDraft(nextMonth.readyToAssignNote ?? "");
    setAssignDrafts(
      Object.fromEntries(
        nextState.categories.map((category) => [
          category.categoryId,
          String(category.assignedMinor / 100),
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
    setCardBalances(balances);
  }, [repository, monthKey]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const commitAssignment = async (categoryId: string, text: string) => {
    const parsed = parseAmountToMinor(text || "0", { exponent: 2 });
    if (!parsed.ok) {
      return;
    }
    await repository.setFinanceBudgetAssignment(monthKey, categoryId, parsed.amountMinor);
    await load();
  };

  const changePolicy = async (categoryId: string, policy: FinanceOverspendPolicy) => {
    await repository.setFinanceCategoryOverspendPolicy(monthKey, categoryId, policy);
    await load();
  };

  const saveNote = async () => {
    await repository.setFinanceBudgetReadyToAssignNote(monthKey, noteDraft || null);
    await load();
  };

  const toggleClosed = async () => {
    await repository.setFinanceBudgetMonthClosed(monthKey, !closed);
    await load();
  };

  const assignLastMonth = async (categoryId: string) => {
    const prevState = await repository.computeFinanceBudgetState(addMonthsToMonthKey(monthKey, -1));
    const prevAmount =
      prevState.categories.find((category) => category.categoryId === categoryId)?.assignedMinor ??
      0;
    await repository.setFinanceBudgetAssignment(monthKey, categoryId, prevAmount);
    await load();
  };

  const assignAverageLast3Months = async (categoryId: string) => {
    const prevStates = await Promise.all(
      [1, 2, 3].map((offset) =>
        repository.computeFinanceBudgetState(addMonthsToMonthKey(monthKey, -offset)),
      ),
    );
    const sum = prevStates.reduce(
      (total, prevState) =>
        total +
        (prevState.categories.find((category) => category.categoryId === categoryId)
          ?.assignedMinor ?? 0),
      0,
    );
    await repository.setFinanceBudgetAssignment(monthKey, categoryId, Math.round(sum / 3));
    await load();
  };

  const assignAllReadyToAssign = async (categoryId: string) => {
    if (!state) {
      return;
    }
    const current = stateCategoryById.get(categoryId)?.assignedMinor ?? 0;
    const nextAssigned = current + Math.max(0, state.readyToAssignMinor);
    await repository.setFinanceBudgetAssignment(monthKey, categoryId, nextAssigned);
    await load();
  };

  const coverOverspending = async (toCategoryId: string) => {
    const fromCategoryId = coverFromByCategory[toCategoryId];
    if (!fromCategoryId) {
      return;
    }
    const toCategory = stateCategoryById.get(toCategoryId);
    const fromCategory = stateCategoryById.get(fromCategoryId);
    if (!toCategory || !fromCategory) {
      return;
    }
    const deficit = toCategory.availableMinor < 0 ? -toCategory.availableMinor : 0;
    const amountMinor = Math.max(0, Math.min(deficit, fromCategory.availableMinor));
    if (amountMinor === 0) {
      return;
    }
    await repository.setFinanceBudgetAssignment(
      monthKey,
      fromCategoryId,
      fromCategory.assignedMinor - amountMinor,
    );
    await repository.setFinanceBudgetAssignment(
      monthKey,
      toCategoryId,
      toCategory.assignedMinor + amountMinor,
    );
    await load();
  };

  const assignUnbudgeted = async (categoryId: string) => {
    const category = stateCategoryById.get(categoryId);
    if (!category) {
      return;
    }
    await repository.setFinanceBudgetAssignment(
      monthKey,
      categoryId,
      Math.abs(category.activityMinor),
    );
    await load();
  };

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
                {leaves.length > 0
                  ? leaves.map((leaf) => renderCategoryRow(leaf))
                  : renderCategoryRow(group)}
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
