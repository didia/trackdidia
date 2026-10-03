import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type { FinanceCategory, FinancePerson } from "../domain/finance";
import type {
  FinanceCategorySpendRow,
  FinanceMerchantSpendRow,
  FinanceMonthOverMonthRow,
  FinancePersonSpendRow,
  FinanceReportLine,
  FinanceTrendPoint,
} from "../domain/finance/reports";
import {
  getMonthEndDate,
  getMonthKey,
  getMonthStartDate,
  getPreviousMonthKey,
} from "../domain/monthly-review";
import { getTodayDate } from "../lib/date";
import { formatMoney } from "../lib/finance/money";

const MERCHANT_SPEND_LIMIT = 10;

export const FinanceReportsPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const baseCurrency = settings.financeBaseCurrency;
  const today = getTodayDate();
  const currentMonthKey = getMonthKey(today);

  const [dateFrom, setDateFrom] = useState(getMonthStartDate(currentMonthKey));
  const [dateTo, setDateTo] = useState(getMonthEndDate(currentMonthKey));
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [people, setPeople] = useState<FinancePerson[]>([]);
  const [categorySpend, setCategorySpend] = useState<FinanceCategorySpendRow[]>([]);
  const [merchantSpend, setMerchantSpend] = useState<FinanceMerchantSpendRow[]>([]);
  const [personSpend, setPersonSpend] = useState<FinancePersonSpendRow[]>([]);
  const [trend, setTrend] = useState<FinanceTrendPoint[]>([]);
  const [monthOverMonth, setMonthOverMonth] = useState<FinanceMonthOverMonthRow[]>([]);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<FinanceReportLine[]>([]);

  const range = useMemo(() => ({ from: dateFrom, to: dateTo }), [dateFrom, dateTo]);

  const load = useCallback(async () => {
    const fromMonthKey = getMonthKey(dateFrom);
    const previousRange = {
      from: getMonthStartDate(getPreviousMonthKey(fromMonthKey)),
      to: getMonthEndDate(getPreviousMonthKey(fromMonthKey)),
    };
    const [
      nextCategories,
      nextPeople,
      nextCategorySpend,
      nextMerchantSpend,
      nextPersonSpend,
      nextTrend,
      nextMonthOverMonth,
    ] = await Promise.all([
      repository.listFinanceCategories(),
      repository.listFinancePeople(),
      repository.computeFinanceCategorySpend(range, "category"),
      repository.computeFinanceMerchantSpend(range, MERCHANT_SPEND_LIMIT),
      repository.computeFinancePersonSpend(range),
      repository.computeFinanceTrend(range, "month"),
      repository.computeFinanceMonthOverMonth(range, previousRange, "category"),
    ]);
    setCategories(nextCategories);
    setPeople(nextPeople);
    setCategorySpend(nextCategorySpend);
    setMerchantSpend(nextMerchantSpend);
    setPersonSpend(nextPersonSpend);
    setTrend(nextTrend);
    setMonthOverMonth(nextMonthOverMonth);
  }, [repository, range, dateFrom]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const personNameById = useMemo(() => new Map(people.map((p) => [p.id, p.displayName])), [people]);

  const openDrilldown = useCallback(
    async (key: string) => {
      setSelectedCategoryKey(key);
      const lines = await repository.listFinanceCategorySpendDrilldown(range, "category", key);
      setDrilldown(lines);
    },
    [repository, range],
  );

  const closeDrilldown = () => {
    setSelectedCategoryKey(null);
    setDrilldown([]);
  };

  return (
    <div className="page">
      <PageHeader eyebrow={t("reports.hero.eyebrow")} title={t("reports.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("reports.rangeTitle")}>
        <div className="field-row">
          <label>
            {t("reports.fields.from")}
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label>
            {t("reports.fields.to")}
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
        </div>
      </SectionCard>

      <SectionCard title={t("reports.categoryTitle")}>
        {categorySpend.length === 0 ? <p>{t("reports.noData")}</p> : null}
        <table>
          <tbody>
            {categorySpend.map((row) => (
              <tr key={row.key}>
                <td>{categoryNameById.get(row.key) ?? row.key}</td>
                <td>{formatMoney({ amountMinor: row.totalMinor, currency: baseCurrency })}</td>
                <td>
                  <button type="button" onClick={() => void openDrilldown(row.key)}>
                    {t("reports.drilldownAction")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {selectedCategoryKey !== null ? (
          <div className="panel" role="dialog" aria-label={t("reports.drilldownTitle")}>
            <h3>{t("reports.drilldownTitle")}</h3>
            <ul className="stack">
              {drilldown.map((line) => (
                <li key={line.lineId}>
                  {line.postedDate} — {line.merchantDisplay ?? line.merchantKey} —{" "}
                  {formatMoney({ amountMinor: -line.amountMinor, currency: baseCurrency })}
                </li>
              ))}
            </ul>
            <button type="button" onClick={closeDrilldown}>
              {t("reports.closeDrilldown")}
            </button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title={t("reports.merchantTitle")}>
        {merchantSpend.length === 0 ? <p>{t("reports.noData")}</p> : null}
        <ol className="stack">
          {merchantSpend.map((row) => (
            <li key={row.merchantKey}>
              {row.merchantDisplay ?? row.merchantKey} —{" "}
              {formatMoney({ amountMinor: row.totalMinor, currency: baseCurrency })}
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title={t("reports.personTitle")}>
        {personSpend.length === 0 ? <p>{t("reports.noData")}</p> : null}
        <ol className="stack">
          {personSpend.map((row) => (
            <li key={row.personId ?? "unassigned"}>
              {row.personId
                ? (personNameById.get(row.personId) ?? row.personId)
                : t("reports.unassignedPerson")}{" "}
              — {formatMoney({ amountMinor: row.totalMinor, currency: baseCurrency })}
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title={t("reports.trendTitle")}>
        <table>
          <thead>
            <tr>
              <th>{t("reports.fields.period")}</th>
              <th>{t("overview.incomeLabel")}</th>
              <th>{t("overview.expenseLabel")}</th>
              <th>{t("overview.netLabel")}</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((point) => (
              <tr key={point.periodKey}>
                <td>{point.periodKey}</td>
                <td>{formatMoney({ amountMinor: point.incomeMinor, currency: baseCurrency })}</td>
                <td>{formatMoney({ amountMinor: point.expenseMinor, currency: baseCurrency })}</td>
                <td>{formatMoney({ amountMinor: point.netMinor, currency: baseCurrency })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title={t("reports.monthOverMonthTitle")}>
        {monthOverMonth.length === 0 ? <p>{t("reports.noData")}</p> : null}
        <table>
          <thead>
            <tr>
              <th>{t("reports.fields.category")}</th>
              <th>{t("reports.fields.current")}</th>
              <th>{t("reports.fields.previous")}</th>
              <th>{t("reports.fields.delta")}</th>
            </tr>
          </thead>
          <tbody>
            {monthOverMonth.map((row) => (
              <tr key={row.key}>
                <td>{categoryNameById.get(row.key) ?? row.key}</td>
                <td>{formatMoney({ amountMinor: row.currentMinor, currency: baseCurrency })}</td>
                <td>{formatMoney({ amountMinor: row.previousMinor, currency: baseCurrency })}</td>
                <td>{formatMoney({ amountMinor: row.deltaMinor, currency: baseCurrency })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
};
