import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { useLatestRequest } from "../app/use-latest-request";
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
import type { FinanceForecast } from "../domain/finance/forecast";
import { getMonthKey, getMonthEndDate, listMonthDates } from "../domain/monthly-review";
import {
  currencyExponent,
  formatMoney,
  minorToInputString,
  parseAmountToMinor,
} from "../lib/finance/money";
import { formatDateShort, getTodayDate } from "../lib/date";
import { createSerialQueue } from "../lib/serial-queue";

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
  const [cardBalances, setCardBalances] = useState<
    Record<string, { name: string; minor: number; currency: string }>
  >({});
  const [excludedCurrencies, setExcludedCurrencies] = useState<string[]>([]);
  const [assignDrafts, setAssignDrafts] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState("");
  const [coverFromByCategory, setCoverFromByCategory] = useState<Record<string, string>>({});
  const [forecast, setForecast] = useState<FinanceForecast | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [loadedMonthKey, setLoadedMonthKey] = useState<string | null>(null);
  const latestLoad = useLatestRequest();
  const selectedMonthRef = useRef(monthKey);
  selectedMonthRef.current = monthKey;
  const dirtyAssignmentsRef = useRef(new Map<string, Map<string, number>>());
  const dirtyNotesRef = useRef(new Map<string, number>());
  const pendingAssignmentsRef = useRef(new Map<string, Map<string, number>>());
  const assignmentDraftValuesRef = useRef(new Map<string, Record<string, string>>());
  const noteDraftValuesRef = useRef(new Map<string, string>());
  const draftVersionRef = useRef(0);
  // Every write runs through this chain so overlapping clicks execute one at a time; each
  // task re-reads fresh state from the repository instead of trusting the rendered snapshot.
  const queueRef = useRef(createSerialQueue());

  const load = useCallback(
    async (requestedMonthKey: string) => {
      await latestLoad.run(async (signal) => {
        try {
          const isCurrentMonth = requestedMonthKey === getMonthKey(today);
          const [nextMonth, nextState, nextCategories, accounts, forecastResult] =
            await Promise.all([
              repository.getFinanceBudgetMonth(requestedMonthKey),
              repository.computeFinanceBudgetState(requestedMonthKey, baseCurrency),
              repository.listFinanceCategories(),
              repository.listFinanceAccounts({ includeClosed: true, onBudgetOnly: true }),
              // Forecasts are relative to today, so only show them for today's month.
              isCurrentMonth ? repository.computeFinanceForecast(today) : Promise.resolve(null),
            ]);
          if (!signal.isLatest() || selectedMonthRef.current !== requestedMonthKey) {
            return;
          }
          setBudgetMonth(nextMonth);
          setState(nextState);
          setCategories(nextCategories);
          setForecast(forecastResult?.forecast ?? null);
          setExcludedCurrencies(
            [
              ...new Set(
                accounts
                  .filter((account) => account.currency !== baseCurrency)
                  .map((account) => account.currency),
              ),
            ].sort(),
          );
          setNoteDraft((current) =>
            dirtyNotesRef.current.has(requestedMonthKey)
              ? (noteDraftValuesRef.current.get(requestedMonthKey) ?? current)
              : (nextMonth.readyToAssignNote ?? ""),
          );
          setAssignDrafts((current) => {
            const refreshed = { ...current };
            for (const category of nextState.categories) {
              if (!dirtyAssignmentsRef.current.get(requestedMonthKey)?.has(category.categoryId)) {
                refreshed[category.categoryId] = minorToInputString(
                  category.assignedMinor,
                  exponent,
                );
              } else {
                refreshed[category.categoryId] =
                  assignmentDraftValuesRef.current.get(requestedMonthKey)?.[category.categoryId] ??
                  refreshed[category.categoryId] ??
                  "";
              }
            }
            return refreshed;
          });

          const creditCardAccounts = accounts.filter((account) => account.type === "credit_card");
          const balances: Record<string, { name: string; minor: number; currency: string }> = {};
          for (const account of creditCardAccounts) {
            const transactions = await repository.listFinanceTransactions({
              accountIds: [account.id],
            });
            balances[account.id] = {
              name: account.name,
              minor: computeDerivedBalanceMinor(account, transactions),
              currency: account.currency,
            };
          }
          if (signal.isLatest() && selectedMonthRef.current === requestedMonthKey) {
            setCardBalances(balances);
            setLoadedMonthKey(requestedMonthKey);
            setError(null);
          }
        } catch (loadError) {
          if (signal.isLatest() && selectedMonthRef.current === requestedMonthKey) {
            setError(errorMessage(loadError));
          }
        }
      });
    },
    [repository, baseCurrency, exponent, latestLoad, today],
  );

  useEffect(() => {
    setError(null);
    void load(monthKey);
  }, [load, monthKey]);

  const changeMonth = (offset: number) => {
    // A previously loaded month must not make its controls writable while a new
    // request for that same month is still in flight (for example A → B → A).
    setLoadedMonthKey(null);
    setMonthKey((current) => addMonthsToMonthKey(current, offset));
  };

  const enqueue = (targetMonthKey: string, task: () => Promise<void>, onSuccess?: () => void) => {
    return queueRef.current.run(async () => {
      try {
        await task();
        onSuccess?.();
        if (selectedMonthRef.current === targetMonthKey) {
          await load(targetMonthKey);
        }
      } catch (taskError) {
        if (selectedMonthRef.current === targetMonthKey) setError(errorMessage(taskError));
      }
    });
  };

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const groups = useMemo(() => buildGroups(categories), [categories]);
  const monthLoaded = loadedMonthKey === monthKey;
  const closed = monthLoaded && budgetMonth?.closedAt != null;
  const mutationsDisabled = !monthLoaded || closed;

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
    const pending = pendingAssignmentsRef.current.get(monthKey)?.get(categoryId) ?? 0;
    if (
      pending === 0 &&
      parsed.amountMinor === (stateCategoryById.get(categoryId)?.assignedMinor ?? 0)
    ) {
      return;
    }
    const targetMonthKey = monthKey;
    const draftVersion = dirtyAssignmentsRef.current.get(targetMonthKey)?.get(categoryId);
    const pendingForMonth =
      pendingAssignmentsRef.current.get(targetMonthKey) ?? new Map<string, number>();
    pendingForMonth.set(categoryId, (pendingForMonth.get(categoryId) ?? 0) + 1);
    pendingAssignmentsRef.current.set(targetMonthKey, pendingForMonth);
    return enqueue(
      targetMonthKey,
      async () => {
        await repository.setFinanceBudgetAssignment(targetMonthKey, categoryId, parsed.amountMinor);
      },
      () => {
        const dirty = dirtyAssignmentsRef.current.get(targetMonthKey);
        if (dirty && dirty.get(categoryId) === draftVersion) dirty.delete(categoryId);
      },
    ).finally(() => {
      const counts = pendingAssignmentsRef.current.get(targetMonthKey);
      const remaining = (counts?.get(categoryId) ?? 1) - 1;
      if (remaining > 0) counts?.set(categoryId, remaining);
      else counts?.delete(categoryId);
    });
  };

  const changePolicy = (categoryId: string, policy: FinanceOverspendPolicy) =>
    enqueue(monthKey, async () => {
      await repository.setFinanceCategoryOverspendPolicy(monthKey, categoryId, policy);
    });

  const saveNote = () => {
    const targetMonthKey = monthKey;
    const draftVersion = dirtyNotesRef.current.get(targetMonthKey);
    return enqueue(
      targetMonthKey,
      async () => {
        await repository.setFinanceBudgetReadyToAssignNote(targetMonthKey, noteDraft || null);
      },
      () => {
        if (dirtyNotesRef.current.get(targetMonthKey) === draftVersion) {
          dirtyNotesRef.current.delete(targetMonthKey);
        }
      },
    );
  };

  const toggleClosed = () =>
    enqueue(monthKey, async () => {
      await repository.setFinanceBudgetMonthClosed(monthKey, budgetMonth?.closedAt == null);
    });

  // Quick-action amounts come from a fresh `computeFinanceBudgetState` read inside the queued
  // task (never the rendered snapshot), so overlapping clicks cannot reuse a stale Ready to Assign.
  const assignFromFreshState = (
    categoryId: string,
    pick: (row: FinanceBudgetState["categories"][number]) => number,
  ) =>
    enqueue(monthKey, async () => {
      const fresh = await repository.computeFinanceBudgetState(monthKey, baseCurrency);
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
    return enqueue(monthKey, async () => {
      await repository.applyFinanceCoverOverspending(
        monthKey,
        baseCurrency,
        fromCategoryId,
        toCategoryId,
      );
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
    const envelopeForecast =
      forecast?.envelopes.find((entry) => entry.categoryId === category.id) ?? null;
    return (
      <div key={category.id} className="inline-form" data-testid={`budget-row-${category.id}`}>
        <span>{category.name}</span>
        <label>
          <span>{t("budget.fields.assigned")}</span>
          <input
            type="text"
            value={assignDrafts[category.id] ?? ""}
            disabled={mutationsDisabled}
            onChange={(event) => {
              setAssignDrafts((current) => ({ ...current, [category.id]: event.target.value }));
              const dirty = dirtyAssignmentsRef.current.get(monthKey) ?? new Map<string, number>();
              dirty.set(category.id, ++draftVersionRef.current);
              dirtyAssignmentsRef.current.set(monthKey, dirty);
              const values = assignmentDraftValuesRef.current.get(monthKey) ?? {};
              values[category.id] = event.target.value;
              assignmentDraftValuesRef.current.set(monthKey, values);
            }}
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
          disabled={mutationsDisabled}
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
          disabled={mutationsDisabled}
          onClick={() => void assignLastMonth(category.id)}
        >
          {t("budget.quickActions.lastMonth")}
        </button>
        <button
          type="button"
          className="button"
          disabled={mutationsDisabled}
          onClick={() => void assignAverageLast3Months(category.id)}
        >
          {t("budget.quickActions.average3Months")}
        </button>
        <button
          type="button"
          className="button"
          disabled={mutationsDisabled}
          onClick={() => void assignAllReadyToAssign(category.id)}
        >
          {t("budget.quickActions.assignAllReadyToAssign")}
        </button>
        {row.availableMinor < 0 ? (
          <>
            <select
              value={coverFromByCategory[category.id] ?? ""}
              disabled={mutationsDisabled}
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
              disabled={mutationsDisabled}
              onClick={() => void coverOverspending(category.id)}
            >
              {t("budget.quickActions.coverOverspending")}
            </button>
          </>
        ) : null}
        <span data-testid={`pace-${category.id}`}>
          {t("budget.pace", { percent: Math.round(pace.fractionSpent * 100) })}
        </span>
        {envelopeForecast ? (
          <span data-testid={`forecast-${category.id}`}>
            {envelopeForecast.lowConfidence ? `${t("budget.lowConfidence")} ` : ""}
            {envelopeForecast.runoutDate
              ? t("budget.runoutDate", {
                  date: formatDateShort(envelopeForecast.runoutDate),
                })
              : t(`budget.forecastStatus.${envelopeForecast.status}`)}
          </span>
        ) : null}
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
      {excludedCurrencies.length > 0 ? (
        <p role="status" className="hero__copy">
          {t("overview.otherCurrenciesWarning", { currencies: excludedCurrencies.join(", ") })}
        </p>
      ) : null}

      <SectionCard title={t("budget.monthSelectorTitle")}>
        <div className="actions-row">
          <button type="button" className="button" onClick={() => changeMonth(-1)}>
            {t("budget.previousMonth")}
          </button>
          <span>{monthKey}</span>
          <button type="button" className="button" onClick={() => changeMonth(1)}>
            {t("budget.nextMonth")}
          </button>
          <button
            type="button"
            className="button"
            disabled={!monthLoaded}
            onClick={() => void toggleClosed()}
          >
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
            disabled={mutationsDisabled}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              dirtyNotesRef.current.set(monthKey, ++draftVersionRef.current);
              noteDraftValuesRef.current.set(monthKey, event.target.value);
            }}
            onBlur={() => void saveNote()}
          />
        </label>
      </SectionCard>

      {Object.keys(cardBalances).length > 0 ? (
        <SectionCard title={t("budget.cardBalancesTitle")}>
          <div className="stack">
            {Object.entries(cardBalances).map(([accountId, card]) => (
              <p key={accountId}>
                {card.name}: {formatMoney({ amountMinor: card.minor, currency: card.currency })}
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
                disabled={mutationsDisabled}
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
