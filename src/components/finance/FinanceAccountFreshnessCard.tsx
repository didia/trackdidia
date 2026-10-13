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
import { formatDateLong } from "../../lib/date";
import { loadFinanceAccountFreshness } from "../../lib/finance/account-freshness-loader";
import { SectionCard } from "../SectionCard";

/**
 * "Which accounts need fresh data" list for the weekly budget review: only the open accounts
 * whose data is older than their cadence (weekly for budget accounts, monthly for the rest) or
 * never loaded, most overdue first, with a link to the importer. Accounts that are up to date
 * are left out. `embedded` drops the card chrome so it can sit inside another section (the
 * weekly review's budget ritual).
 */
export const FinanceAccountFreshnessCard = ({ embedded = false }: { embedded?: boolean }) => {
  const { t } = useTranslation("finance");
  const { repository, settings, calendarDay } = useAppContext();
  const active = settings.financeEnabled;
  // `calendarDay` rolls over at local midnight/focus, so ages and due chips never stay on yesterday.
  const resourceKey = useMemo(
    () => ({ repository, active, today: calendarDay }),
    [repository, active, calendarDay],
  );
  const resource = useAsyncResource(
    resourceKey,
    async ({ repository: currentRepository, active: isActive, today }) =>
      isActive ? loadFinanceAccountFreshness(currentRepository, today) : null,
  );
  const rows = resource.data;

  if (!active) {
    return null;
  }

  const dueRows = rows?.filter((row) => row.status !== "fresh") ?? [];
  const dueCount = dueRows.length;

  const describeAge = (row: FinanceAccountFreshness): string => {
    const through = t(`freshness.${row.dataThroughSource}Through`, {
      date: formatDateLong(row.dataThroughDate),
    });
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
      {resource.loading && rows === null ? (
        <p className="empty-copy">{t("freshness.loading")}</p>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <p className="empty-copy">{t("freshness.noAccounts")}</p>
      ) : null}
      {dueCount > 0 ? (
        <ul className="finance-alerts-list">
          {dueRows.map((row) => (
            <li
              key={row.accountId}
              data-testid={`finance-freshness-${row.accountId}`}
              data-status={row.status}
              data-severity="warning"
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
