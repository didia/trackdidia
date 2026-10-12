import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../../app/app-context";
import { useAsyncResource } from "../../app/use-latest-request";
import {
  FINANCE_BUDGET_ACCOUNT_CADENCE_DAYS,
  FINANCE_OTHER_ACCOUNT_CADENCE_DAYS,
  type FinanceAccountFreshness,
} from "../../domain/finance/account-freshness";
import { formatDateLong, getTodayDate } from "../../lib/date";
import { loadFinanceAccountFreshness } from "../../lib/finance/account-freshness-loader";
import { SectionCard } from "../SectionCard";

/**
 * "Which accounts need fresh data" list for the weekly budget review and the finance
 * overview: how old each open account's data is against its cadence (weekly for budget
 * accounts, monthly for the rest), most overdue first, with a link to the importer.
 * `embedded` drops the card chrome so it can sit inside another section (the weekly
 * review's budget ritual).
 */
export const FinanceAccountFreshnessCard = ({ embedded = false }: { embedded?: boolean }) => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const active = settings.financeEnabled;
  const resourceKey = useMemo(() => ({ repository, active }), [repository, active]);
  const resource = useAsyncResource(
    resourceKey,
    async ({ repository: currentRepository, active: isActive }) =>
      isActive ? loadFinanceAccountFreshness(currentRepository, getTodayDate()) : null,
  );
  const rows = resource.data;

  if (!active) {
    return null;
  }

  const dueCount = rows?.filter((row) => row.status !== "fresh").length ?? 0;

  const describeAge = (row: FinanceAccountFreshness): string => {
    if (row.dataThroughDate === null || row.ageDays === null) {
      return t("freshness.neverLoaded");
    }
    const through = t(
      row.dataThroughSource === "statement" ? "freshness.statementThrough" : "freshness.through",
      { date: formatDateLong(row.dataThroughDate) },
    );
    return `${through} · ${t("freshness.ageDays", { count: row.ageDays })}`;
  };

  const describeCadence = (row: FinanceAccountFreshness): string => {
    if (row.cadenceDays === FINANCE_BUDGET_ACCOUNT_CADENCE_DAYS) {
      return t("freshness.cadenceWeekly");
    }
    if (row.cadenceDays === FINANCE_OTHER_ACCOUNT_CADENCE_DAYS) {
      return t("freshness.cadenceMonthly");
    }
    return t("freshness.cadenceEveryDays", { count: row.cadenceDays });
  };

  const title = t("freshness.title");
  const subtitle =
    rows === null
      ? t("freshness.subtitle")
      : dueCount === 0
        ? t("freshness.allFresh")
        : t("freshness.dueSummary", { count: dueCount });

  const content = (
    <>
      {resource.error ? (
        <div className="banner" role="alert">
          <p>{t("freshness.loadError")}</p>
          <button className="button" type="button" onClick={() => void resource.reload()}>
            {t("freshness.retry")}
          </button>
        </div>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <p className="empty-copy">{t("freshness.noAccounts")}</p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul className="finance-alerts-list">
          {rows.map((row) => (
            <li
              key={row.accountId}
              data-testid={`finance-freshness-${row.accountId}`}
              data-status={row.status}
              data-severity={row.status === "fresh" ? "info" : "warning"}
            >
              <span className="tag-chip">{t(`freshness.status.${row.status}`)}</span>
              <span>
                <strong>{row.name}</strong>
                {row.institution ? ` · ${row.institution}` : ""}
                <br />
                <small>
                  {describeAge(row)} · {describeCadence(row)}
                </small>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="section-actions">
        <Link className="button" to="/finances/import">
          {t("freshness.import")}
        </Link>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="finance-freshness" data-testid="finance-freshness-embedded">
        <h4>{title}</h4>
        <p className="muted-copy">{subtitle}</p>
        {content}
      </div>
    );
  }

  return (
    <SectionCard title={title} subtitle={subtitle}>
      {content}
    </SectionCard>
  );
};
