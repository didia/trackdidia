import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { useAsyncResource } from "../app/use-latest-request";
import type { FinanceAlert } from "../domain/finance/forecast";
import { formatDateShort, getTodayDate } from "../lib/date";
import { SectionCard } from "./SectionCard";

const MAX_ALERTS_ON_TODAY = 3;

/**
 * Today card for proactive budget-runout forecasting — see
 * specs/todo/finance.md "Surfacing". Rendered by `TodayPage` only when
 * `financeEnabled && financeAlertsOnToday`; shows at most the 3
 * highest-severity alerts plus a link to the full list on `/finances`.
 */
export const FinanceAlertsCard = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const active = settings.financeEnabled && settings.financeAlertsOnToday;
  const resourceKey = useMemo(() => ({ repository, active }), [repository, active]);
  const resource = useAsyncResource(
    resourceKey,
    async ({ repository: currentRepository, active: isActive }) => {
      if (!isActive) {
        return null;
      }
      const [{ alerts: nextAlerts }, categories] = await Promise.all([
        currentRepository.computeFinanceForecast(getTodayDate()),
        currentRepository.listFinanceCategories(),
      ]);
      return {
        alerts: nextAlerts,
        categoryNameById: new Map(categories.map((category) => [category.id, category.name])),
      };
    },
  );
  const alerts = resource.data?.alerts ?? null;
  const categoryNameById = resource.data?.categoryNameById ?? new Map<string, string>();

  if (!settings.financeEnabled || !settings.financeAlertsOnToday) {
    return null;
  }

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

  const topAlerts = (alerts ?? []).slice(0, MAX_ALERTS_ON_TODAY);

  return (
    <SectionCard title={t("alerts.title")} subtitle={t("alerts.subtitle")}>
      {resource.error ? (
        <div className="banner" role="alert">
          <p>{t("alerts.loadError")}</p>
          <button className="button" type="button" onClick={() => void resource.reload()}>
            {t("alerts.retry")}
          </button>
        </div>
      ) : null}
      {alerts !== null && topAlerts.length === 0 ? (
        <p className="empty-copy">{t("alerts.none")}</p>
      ) : null}
      {topAlerts.length > 0 ? (
        <ul className="finance-alerts-list">
          {topAlerts.map((alert) => (
            <li key={alert.key} data-testid={`finance-alert-${alert.key}`}>
              <span className="tag-chip">{t(`alerts.severity.${alert.severity}`)}</span>
              <span>{describeAlert(alert)}</span>
              {alert.lowConfidence ? <small> ({t("alerts.lowConfidence")})</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="section-actions">
        <Link className="button" to="/finances">
          {t("alerts.viewAll")}
        </Link>
      </div>
    </SectionCard>
  );
};
