import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { useAsyncResource } from "../app/use-latest-request";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { addMonthsToMonthKey } from "../domain/finance/budget";
import type { FinanceAccount, FinanceCategory, FinanceRecurringSeries } from "../domain/finance";
import type { FinanceCashFlowSummary } from "../domain/finance/cash-flow";
import type { FinanceAlert, FinanceAlertSeverity } from "../domain/finance/forecast";
import type { FinanceNetWorthSnapshot } from "../domain/finance/net-worth";
import type { FinanceCategorySpendRow, FinanceTrendPoint } from "../domain/finance/reports";
import { getMonthEndDate, getMonthKey, getMonthStartDate } from "../domain/monthly-review";
import { formatDateShort, getTodayDate } from "../lib/date";
import { loadFinanceAccountFreshness } from "../lib/finance/account-freshness-loader";
import { formatMoney } from "../lib/finance/money";

const ALERT_SEVERITY_ORDER: FinanceAlertSeverity[] = ["critical", "warning", "info"];

const TOP_CATEGORY_COUNT = 5;
const TREND_MONTHS = 6;
const UPCOMING_RECURRING_COUNT = 5;

const accountInitial = (name: string): string => Array.from(name.trim())[0] ?? "?";

export const FinanceOverviewPage = () => {
  const { t, i18n } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const baseCurrency = settings.financeBaseCurrency;
  const today = getTodayDate();
  const monthKey = getMonthKey(today);

  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [netWorth, setNetWorth] = useState<FinanceNetWorthSnapshot | null>(null);
  const [cashFlow, setCashFlow] = useState<FinanceCashFlowSummary | null>(null);
  const [trend, setTrend] = useState<FinanceTrendPoint[]>([]);
  const [topCategories, setTopCategories] = useState<FinanceCategorySpendRow[]>([]);
  const [recurringSeries, setRecurringSeries] = useState<FinanceRecurringSeries[]>([]);
  const [alerts, setAlerts] = useState<FinanceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // Re-detect first so missed/ended series and dates reflect today, not the last import.
      await repository.detectFinanceRecurringSeries().catch(() => undefined);
      const trendFromMonthKey = addMonthsToMonthKey(monthKey, -(TREND_MONTHS - 1));
      const [
        nextAccounts,
        nextCategories,
        nextNetWorth,
        nextCashFlow,
        nextTrend,
        nextTopCategories,
        nextRecurringSeries,
        nextForecast,
      ] = await Promise.all([
        repository.listFinanceAccounts({ includeClosed: true }),
        repository.listFinanceCategories(),
        repository.computeFinanceNetWorth(today),
        repository.computeFinanceCashFlow(monthKey),
        repository.computeFinanceTrend(
          { from: getMonthStartDate(trendFromMonthKey), to: getMonthEndDate(monthKey) },
          "month",
        ),
        repository.computeFinanceCategorySpend(
          { from: getMonthStartDate(monthKey), to: getMonthEndDate(monthKey) },
          "category",
        ),
        repository.listFinanceRecurringSeries("active"),
        repository.computeFinanceForecast(today),
      ]);
      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setNetWorth(nextNetWorth);
      setCashFlow(nextCashFlow);
      setTrend(nextTrend);
      setTopCategories(nextTopCategories.slice(0, TOP_CATEGORY_COUNT));
      setRecurringSeries(nextRecurringSeries);
      setAlerts(nextForecast.alerts);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [repository, today, monthKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // A discreet hint on the account rows. It has its own latest-response guard so a slow load from
  // before a local-day rollover cannot erase the badges the new day computed, and a failure just
  // leaves the badges out instead of breaking the overview.
  const freshnessKey = useMemo(() => ({ repository, today }), [repository, today]);
  const freshness = useAsyncResource(
    freshnessKey,
    ({ repository: currentRepository, today: currentToday }) =>
      loadFinanceAccountFreshness(currentRepository, currentToday),
    { refreshing: true },
  );
  const accountsToUpdate = useMemo(
    () =>
      new Set(
        (freshness.data ?? []).filter((row) => row.status !== "fresh").map((row) => row.accountId),
      ),
    [freshness.data],
  );

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const upcomingRecurring = useMemo(
    () =>
      [...recurringSeries]
        .sort((a, b) => a.nextExpectedDate.localeCompare(b.nextExpectedDate))
        .slice(0, UPCOMING_RECURRING_COUNT),
    [recurringSeries],
  );

  // One column per month of the six-month span, zero when the month has no spending.
  const trendColumns = useMemo(() => {
    const expenseByPeriod = new Map(trend.map((point) => [point.periodKey, point.expenseMinor]));
    return Array.from({ length: TREND_MONTHS }, (_, index) => {
      const periodKey = addMonthsToMonthKey(monthKey, index - (TREND_MONTHS - 1));
      return { periodKey, expenseMinor: expenseByPeriod.get(periodKey) ?? 0 };
    });
  }, [trend, monthKey]);

  const maxTrendExpenseMinor = useMemo(
    () => Math.max(1, ...trendColumns.map((column) => column.expenseMinor)),
    [trendColumns],
  );

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const sortedAlerts = useMemo(
    () =>
      [...alerts].sort(
        (left, right) =>
          ALERT_SEVERITY_ORDER.indexOf(left.severity) -
          ALERT_SEVERITY_ORDER.indexOf(right.severity),
      ),
    [alerts],
  );

  const formatMonthShort = (periodKey: string): string => {
    const [year, month] = periodKey.split("-").map(Number);
    return new Intl.DateTimeFormat(i18n.language, { month: "short" })
      .format(new Date(year, month - 1, 1))
      .replace(".", "");
  };

  const describeAlert = (alert: FinanceAlert): string => {
    const categoryName = alert.categoryId ? (categoryNameById.get(alert.categoryId) ?? "") : "";
    switch (alert.kind) {
      case "cash_runout":
        return t("alerts.cashRunout", { date: formatDateShort(alert.runoutDate ?? "") });
      case "envelope_exhausted":
        return t("alerts.envelopeExhausted", { category: categoryName });
      case "envelope_will_run_out":
        return t("alerts.envelopeWillRunOut", {
          category: categoryName,
          date: formatDateShort(alert.runoutDate ?? ""),
        });
      default:
        return t("alerts.envelopeWatch", { category: categoryName });
    }
  };

  const confirmRecurring = async (series: FinanceRecurringSeries) => {
    await repository.saveFinanceRecurringSeries({ ...series, confirmedByUser: true });
    await load();
  };

  const pauseRecurring = async (series: FinanceRecurringSeries) => {
    await repository.saveFinanceRecurringSeries({
      ...series,
      status: "paused",
      confirmedByUser: true,
    });
    await load();
  };

  const endRecurring = async (series: FinanceRecurringSeries) => {
    await repository.saveFinanceRecurringSeries({
      ...series,
      status: "ended",
      confirmedByUser: true,
    });
    await load();
  };

  const netWorthMagnitude = netWorth
    ? netWorth.assetsMinor + Math.abs(netWorth.liabilitiesMinor)
    : 0;
  const assetsShare =
    netWorth && netWorthMagnitude > 0 ? (netWorth.assetsMinor / netWorthMagnitude) * 100 : 0;
  const liabilitiesShare = netWorth && netWorthMagnitude > 0 ? 100 - assetsShare : 0;
  const spentPercent =
    cashFlow && cashFlow.incomeMinor > 0
      ? Math.round((cashFlow.expenseMinor / cashFlow.incomeMinor) * 100)
      : null;
  // Short-term debt as a share of liquid cash; null when there is no positive cash to compare against.
  const debtCoveragePercent =
    netWorth && netWorth.liquidAssetsMinor > 0
      ? Math.round((netWorth.shortTermDebtMinor / netWorth.liquidAssetsMinor) * 100)
      : null;
  const maxCategoryMinor = Math.max(1, ...topCategories.map((row) => row.totalMinor));

  return (
    <div className="page finance-page">
      <PageHeader eyebrow={t("overview.hero.eyebrow")} title={t("overview.hero.title")} />
      <FinanceTabs />

      <div className="finance-summary">
        <section className="finance-networth" aria-labelledby="finance-networth-title">
          <h2 id="finance-networth-title" className="finance-networth__label">
            {t("overview.netWorthTitle")}
          </h2>
          <p
            className={`finance-networth__value${
              netWorth && netWorth.netWorthMinor < 0 ? " finance-networth__value--negative" : ""
            }`}
          >
            {netWorth
              ? formatMoney({ amountMinor: netWorth.netWorthMinor, currency: baseCurrency })
              : "—"}
          </p>
          {netWorth ? (
            <>
              <div
                className="finance-networth__bar"
                role="img"
                aria-label={t("overview.assetsLiabilitiesBar")}
              >
                {netWorthMagnitude > 0 ? (
                  <>
                    <span
                      className="finance-networth__bar-assets"
                      style={{ flexBasis: `${assetsShare}%` }}
                    />
                    {liabilitiesShare > 0 ? (
                      <span
                        className="finance-networth__bar-liabilities"
                        style={{ flexBasis: `${liabilitiesShare}%` }}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
              <dl className="finance-networth__split">
                <div>
                  <dt>{t("overview.assetsLabel")}</dt>
                  <dd>
                    {formatMoney({ amountMinor: netWorth.assetsMinor, currency: baseCurrency })}
                  </dd>
                </div>
                <div>
                  <dt>{t("overview.liabilitiesLabel")}</dt>
                  <dd>
                    {formatMoney({
                      amountMinor: netWorth.liabilitiesMinor,
                      currency: baseCurrency,
                    })}
                  </dd>
                </div>
              </dl>
              {netWorth.excludedCurrencies.length > 0 ? (
                <p className="banner">
                  {t("overview.otherCurrenciesWarning", {
                    currencies: netWorth.excludedCurrencies.join(", "),
                  })}
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        <SectionCard title={t("overview.cashFlowTitle")} subtitle={t("overview.cashFlowSubtitle")}>
          {cashFlow ? (
            <>
              <div className="finance-stats">
                <div className="finance-stat finance-stat--income">
                  <span className="finance-stat__label">
                    <span className="finance-stat__icon" aria-hidden="true">
                      ↓
                    </span>
                    {t("overview.incomeLabel")}
                  </span>
                  <span className="finance-stat__value">
                    {formatMoney({ amountMinor: cashFlow.incomeMinor, currency: baseCurrency })}
                  </span>
                </div>
                <div className="finance-stat finance-stat--expense">
                  <span className="finance-stat__label">
                    <span className="finance-stat__icon" aria-hidden="true">
                      ↑
                    </span>
                    {t("overview.expenseLabel")}
                  </span>
                  <span className="finance-stat__value">
                    {formatMoney({ amountMinor: cashFlow.expenseMinor, currency: baseCurrency })}
                  </span>
                </div>
                <div
                  className={`finance-stat finance-stat--net${
                    cashFlow.netMinor > 0
                      ? " finance-stat--positive"
                      : cashFlow.netMinor < 0
                        ? " finance-stat--negative"
                        : ""
                  }`}
                >
                  <span className="finance-stat__label">
                    <span className="finance-stat__icon" aria-hidden="true">
                      =
                    </span>
                    {t("overview.netLabel")}
                  </span>
                  <span className="finance-stat__value">
                    {formatMoney({ amountMinor: cashFlow.netMinor, currency: baseCurrency })}
                  </span>
                </div>
              </div>
              <div className="finance-meter">
                <div className="finance-meter__caption">
                  <span>
                    {spentPercent === null
                      ? t("overview.noIncomeYet")
                      : t("overview.spentShare", { percent: spentPercent })}
                  </span>
                </div>
                <div className="finance-meter__track">
                  <div
                    className={`finance-meter__fill${
                      spentPercent !== null && spentPercent > 100
                        ? " finance-meter__fill--over"
                        : ""
                    }`}
                    style={{ width: `${Math.min(100, spentPercent ?? 0)}%` }}
                  />
                </div>
              </div>
            </>
          ) : null}
        </SectionCard>
      </div>

      <SectionCard title={t("overview.liquidityTitle")} subtitle={t("overview.liquiditySubtitle")}>
        {netWorth ? (
          <>
            <div className="finance-stats">
              <div className="finance-stat finance-stat--income">
                <span className="finance-stat__label">
                  <span className="finance-stat__icon" aria-hidden="true">
                    ↓
                  </span>
                  {t("overview.liquidCashLabel")}
                </span>
                <span className="finance-stat__value">
                  {formatMoney({ amountMinor: netWorth.liquidAssetsMinor, currency: baseCurrency })}
                </span>
              </div>
              <div className="finance-stat finance-stat--expense">
                <span className="finance-stat__label">
                  <span className="finance-stat__icon" aria-hidden="true">
                    ↑
                  </span>
                  {t("overview.shortTermDebtLabel")}
                </span>
                <span className="finance-stat__value">
                  {formatMoney({
                    amountMinor: netWorth.shortTermDebtMinor,
                    currency: baseCurrency,
                  })}
                </span>
              </div>
              <div
                className={`finance-stat finance-stat--net${
                  netWorth.netLiquidityMinor > 0
                    ? " finance-stat--positive"
                    : netWorth.netLiquidityMinor < 0
                      ? " finance-stat--negative"
                      : ""
                }`}
                data-testid="finance-net-liquidity"
              >
                <span className="finance-stat__label">
                  <span className="finance-stat__icon" aria-hidden="true">
                    =
                  </span>
                  {t("overview.netLiquidityLabel")}
                </span>
                <span className="finance-stat__value">
                  {formatMoney({ amountMinor: netWorth.netLiquidityMinor, currency: baseCurrency })}
                </span>
              </div>
            </div>
            <div className="finance-meter">
              <div className="finance-meter__caption">
                <span>
                  {debtCoveragePercent === null
                    ? netWorth.shortTermDebtMinor > 0
                      ? t("overview.noLiquidCash")
                      : t("overview.noShortTermDebt")
                    : t("overview.debtShareOfCash", { percent: debtCoveragePercent })}
                </span>
              </div>
              <div className="finance-meter__track">
                <div
                  className={`finance-meter__fill${
                    netWorth.netLiquidityMinor < 0 ? " finance-meter__fill--over" : ""
                  }`}
                  style={{ width: `${Math.min(100, debtCoveragePercent ?? 0)}%` }}
                />
              </div>
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard title={t("alerts.title")} subtitle={t("alerts.subtitle")}>
        {alerts.length === 0 ? (
          <p className="finance-empty">
            <span className="finance-empty__icon" aria-hidden="true">
              ✓
            </span>
            <span className="empty-copy">{t("alerts.none")}</span>
          </p>
        ) : (
          <ul className="finance-alerts-list">
            {sortedAlerts.map((alert) => (
              <li
                key={alert.key}
                data-testid={`finance-alert-${alert.key}`}
                data-severity={alert.severity}
              >
                <span className="tag-chip">{t(`alerts.severity.${alert.severity}`)}</span>
                <span>{describeAlert(alert)}</span>
                {alert.lowConfidence ? <small>({t("alerts.lowConfidence")})</small> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="finance-columns">
        <SectionCard title={t("overview.trendTitle")}>
          <div className="finance-trend">
            {trendColumns.map((column, index) => (
              <div
                key={column.periodKey}
                className={`finance-trend__column${
                  index === trendColumns.length - 1 ? " finance-trend__column--current" : ""
                }`}
              >
                <span className="finance-trend__amount">
                  {formatMoney({ amountMinor: column.expenseMinor, currency: baseCurrency })}
                </span>
                <div className="finance-trend__track">
                  <div
                    className="finance-trend__bar"
                    style={{ height: `${(column.expenseMinor / maxTrendExpenseMinor) * 100}%` }}
                  />
                </div>
                <span className="finance-trend__label" title={column.periodKey}>
                  {formatMonthShort(column.periodKey)}
                </span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title={t("overview.topCategoriesTitle")}>
          {!loading && topCategories.length === 0 ? (
            <p className="finance-empty finance-empty--neutral">
              <span className="finance-empty__icon" aria-hidden="true">
                –
              </span>
              <span>{t("overview.noTopCategories")}</span>
            </p>
          ) : null}
          <ol className="finance-rank">
            {topCategories.map((row, index) => (
              <li key={row.key}>
                <span className="finance-rank__index">{index + 1}</span>
                <span className="finance-rank__name">
                  {categoryNameById.get(row.key) ?? row.key}
                </span>
                <span className="finance-rank__amount">
                  {formatMoney({ amountMinor: row.totalMinor, currency: baseCurrency })}
                </span>
                <span className="finance-rank__bar" aria-hidden="true">
                  <span style={{ width: `${(row.totalMinor / maxCategoryMinor) * 100}%` }} />
                </span>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>

      <div className="finance-columns">
        <SectionCard title={t("overview.recurringTitle")}>
          {!loading && upcomingRecurring.length === 0 ? (
            <p className="finance-empty finance-empty--neutral">
              <span className="finance-empty__icon" aria-hidden="true">
                –
              </span>
              <span>{t("overview.noRecurring")}</span>
            </p>
          ) : null}
          <div className="finance-rows">
            {upcomingRecurring.map((series) => (
              <article key={series.id} className="finance-row">
                <span className="finance-row__avatar" aria-hidden="true">
                  {accountInitial(series.merchantKey)}
                </span>
                <div className="finance-row__main">
                  <h3 className="finance-row__title">{series.merchantKey}</h3>
                  <span className="finance-row__meta">
                    {t("overview.recurringNextDate", { date: series.nextExpectedDate })}
                  </span>
                </div>
                <span className="finance-row__amount">
                  {formatMoney({
                    amountMinor: series.expectedAmountMinor,
                    currency: accountById.get(series.accountId)?.currency ?? baseCurrency,
                  })}
                </span>
                <div className="finance-row__actions">
                  {!series.confirmedByUser ? (
                    <button type="button" onClick={() => void confirmRecurring(series)}>
                      {t("overview.recurringConfirm")}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void pauseRecurring(series)}>
                    {t("overview.recurringPause")}
                  </button>
                  <button type="button" onClick={() => void endRecurring(series)}>
                    {t("overview.recurringEnd")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>

        <SectionCard title={t("overview.accountsTitle")}>
          {loading ? <p>{t("overview.loading")}</p> : null}
          {loadError ? <p className="banner">{t("overview.loadError")}</p> : null}
          {!loading && !loadError && accounts.length === 0 ? (
            <p className="finance-empty finance-empty--neutral">
              <span className="finance-empty__icon" aria-hidden="true">
                –
              </span>
              <span>{t("overview.noAccounts")}</span>
            </p>
          ) : null}
          <div className="finance-rows">
            {(netWorth?.accounts ?? []).map((line) => {
              const account = accountById.get(line.accountId);
              if (!account) {
                return null;
              }
              return (
                <article
                  key={account.id}
                  className={`finance-row${account.closed ? " finance-row--closed" : ""}`}
                >
                  <span className="finance-row__avatar" aria-hidden="true">
                    {accountInitial(account.name)}
                  </span>
                  <div className="finance-row__main">
                    <h3 className="finance-row__title">
                      {account.name}
                      {account.closed ? ` ${t("overview.closedAccount")}` : ""}
                    </h3>
                    {accountsToUpdate.has(account.id) ? (
                      <span
                        className="finance-row__update"
                        data-testid={`finance-account-update-${account.id}`}
                      >
                        {t("freshness.status.due")}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={`finance-row__amount${
                      line.balanceMinor < 0 ? " finance-row__amount--negative" : ""
                    }`}
                  >
                    {formatMoney({ amountMinor: line.balanceMinor, currency: line.currency })}
                  </span>
                </article>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </div>
  );
};
