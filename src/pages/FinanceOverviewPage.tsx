import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
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
import { formatMoney } from "../lib/finance/money";

const ALERT_SEVERITY_ORDER: FinanceAlertSeverity[] = ["critical", "warning", "info"];

const TOP_CATEGORY_COUNT = 5;
const TREND_MONTHS = 6;
const UPCOMING_RECURRING_COUNT = 5;

export const FinanceOverviewPage = () => {
  const { t } = useTranslation("finance");
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

  const alertsBySeverity = useMemo(() => {
    const grouped = new Map<FinanceAlertSeverity, FinanceAlert[]>();
    for (const alert of alerts) {
      const bucket = grouped.get(alert.severity);
      if (bucket) {
        bucket.push(alert);
      } else {
        grouped.set(alert.severity, [alert]);
      }
    }
    return grouped;
  }, [alerts]);

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

  return (
    <div className="page">
      <PageHeader eyebrow={t("overview.hero.eyebrow")} title={t("overview.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("overview.netWorthTitle")}>
        {netWorth ? (
          <>
            <p className="hero__copy">
              {formatMoney({ amountMinor: netWorth.netWorthMinor, currency: baseCurrency })}
            </p>
            <dl className="definition-list">
              <div>
                <dt>{t("overview.assetsLabel")}</dt>
                <dd>
                  {formatMoney({ amountMinor: netWorth.assetsMinor, currency: baseCurrency })}
                </dd>
              </div>
              <div>
                <dt>{t("overview.liabilitiesLabel")}</dt>
                <dd>
                  {formatMoney({ amountMinor: netWorth.liabilitiesMinor, currency: baseCurrency })}
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
      </SectionCard>

      <SectionCard title={t("alerts.title")} subtitle={t("alerts.subtitle")}>
        {alerts.length === 0 ? <p className="empty-copy">{t("alerts.none")}</p> : null}
        {ALERT_SEVERITY_ORDER.map((severity) => {
          const group = alertsBySeverity.get(severity);
          if (!group || group.length === 0) {
            return null;
          }
          return (
            <div key={severity} className="finance-alerts-group">
              <h3>{t(`alerts.severity.${severity}`)}</h3>
              <ul className="finance-alerts-list">
                {group.map((alert) => (
                  <li key={alert.key} data-testid={`finance-alert-${alert.key}`}>
                    <span>{describeAlert(alert)}</span>
                    {alert.lowConfidence ? <small> ({t("alerts.lowConfidence")})</small> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </SectionCard>

      <SectionCard title={t("overview.cashFlowTitle")}>
        {cashFlow ? (
          <dl className="definition-list">
            <div>
              <dt>{t("overview.incomeLabel")}</dt>
              <dd>{formatMoney({ amountMinor: cashFlow.incomeMinor, currency: baseCurrency })}</dd>
            </div>
            <div>
              <dt>{t("overview.expenseLabel")}</dt>
              <dd>{formatMoney({ amountMinor: cashFlow.expenseMinor, currency: baseCurrency })}</dd>
            </div>
            <div>
              <dt>{t("overview.netLabel")}</dt>
              <dd>{formatMoney({ amountMinor: cashFlow.netMinor, currency: baseCurrency })}</dd>
            </div>
          </dl>
        ) : null}
      </SectionCard>

      <SectionCard title={t("overview.trendTitle")}>
        <div className="finance-trend">
          {trendColumns.map((column) => (
            <div key={column.periodKey} className="finance-trend__column">
              <span className="finance-trend__amount">
                {formatMoney({ amountMinor: column.expenseMinor, currency: baseCurrency })}
              </span>
              <div className="finance-trend__track">
                <div
                  className="finance-trend__bar"
                  style={{ height: `${(column.expenseMinor / maxTrendExpenseMinor) * 100}%` }}
                />
              </div>
              <span className="finance-trend__label">{column.periodKey}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("overview.topCategoriesTitle")}>
        {!loading && topCategories.length === 0 ? <p>{t("overview.noTopCategories")}</p> : null}
        <ol className="stack">
          {topCategories.map((row) => (
            <li key={row.key}>
              {categoryNameById.get(row.key) ?? row.key} —{" "}
              {formatMoney({ amountMinor: row.totalMinor, currency: baseCurrency })}
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title={t("overview.recurringTitle")}>
        {!loading && upcomingRecurring.length === 0 ? <p>{t("overview.noRecurring")}</p> : null}
        <div className="stack">
          {upcomingRecurring.map((series) => (
            <article key={series.id} className="list-card">
              <h3>{series.merchantKey}</h3>
              <p>
                {t("overview.recurringNextDate", { date: series.nextExpectedDate })} —{" "}
                {formatMoney({
                  amountMinor: series.expectedAmountMinor,
                  currency: accountById.get(series.accountId)?.currency ?? baseCurrency,
                })}
              </p>
              <div className="button-row">
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
        {!loading && !loadError && accounts.length === 0 ? <p>{t("overview.noAccounts")}</p> : null}
        <div className="stack">
          {(netWorth?.accounts ?? []).map((line) => {
            const account = accountById.get(line.accountId);
            if (!account) {
              return null;
            }
            return (
              <article key={account.id} className="list-card">
                <h3>
                  {account.name}
                  {account.closed ? ` ${t("overview.closedAccount")}` : ""}
                </h3>
                <p>{formatMoney({ amountMinor: line.balanceMinor, currency: line.currency })}</p>
              </article>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
};
