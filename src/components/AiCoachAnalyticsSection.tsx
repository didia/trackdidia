import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadCoachAnalytics } from "../lib/ai/analytics/load-coach-analytics";
import type { AcceptanceRateBucket, CoachAnalyticsSummary } from "../lib/ai/analytics/proposal-analytics";
import { PROMPT_REGISTRY } from "../lib/ai/prompts/registry";
import { t as translate } from "../i18n";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiCoachAnalyticsSectionProps {
  repository: AppRepository;
}

const formatRate = (value: number | null): string =>
  value === null ? translate("emDash", { ns: "common" }) : `${Math.round(value * 100)} %`;

const BucketTable = ({ title, buckets }: { title: string; buckets: AcceptanceRateBucket[] }) => {
  const { t } = useTranslation("settings");

  return (
    <div className="analytics-table-block">
      <h4>{title}</h4>
      {buckets.length === 0 ? (
        <p className="muted-copy">{t("analytics.noDecidedProposals")}</p>
      ) : (
        <table className="analytics-table">
          <thead>
            <tr>
              <th scope="col">{t("analytics.col.label")}</th>
              <th scope="col">{t("analytics.col.decided")}</th>
              <th scope="col">{t("analytics.col.accepted")}</th>
              <th scope="col">{t("analytics.col.dismissed")}</th>
              <th scope="col">{t("analytics.col.acceptanceRate")}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.key}>
                <td>{bucket.label}</td>
                <td>{bucket.decided}</td>
                <td>{bucket.accepted}</td>
                <td>{bucket.dismissed}</td>
                <td>{formatRate(bucket.acceptanceRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export const AiCoachAnalyticsSection = ({ repository }: AiCoachAnalyticsSectionProps) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const [analytics, setAnalytics] = useState<CoachAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAnalytics(await loadCoachAnalytics(repository));
    } catch {
      setAnalytics(null);
      setError(translate("analytics.loadError", { ns: "settings" }));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await loadCoachAnalytics(repository);
        if (!cancelled) {
          setAnalytics(result);
        }
      } catch {
        if (!cancelled) {
          setAnalytics(null);
          setError(translate("analytics.loadError", { ns: "settings" }));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  if (loading) {
    return (
      <SectionCard title={t("analytics.title")} subtitle={t("analytics.subtitle")}>
        <p className="muted-copy">{tCommon("status.loading")}</p>
      </SectionCard>
    );
  }

  if (error) {
    return (
      <SectionCard
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
      >
        <div className="banner">{error}</div>
        <div className="form-actions">
          <button className="button button--ghost" type="button" onClick={() => void loadAnalytics()}>
            {tCommon("actions.retry")}
          </button>
        </div>
      </SectionCard>
    );
  }

  if (!analytics) {
    return (
      <SectionCard
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
      >
        <p className="muted-copy">{t("analytics.noData")}</p>
      </SectionCard>
    );
  }

  const dismissalTrend = analytics.dismissalTrend.filter((point) => point.decided > 0);

  return (
    <SectionCard
      title={t("analytics.title")}
      subtitle={t("analytics.subtitleFull")}
    >
      <BucketTable title={t("analytics.bySurface")} buckets={analytics.bySurface} />
      <BucketTable title={t("analytics.byType")} buckets={analytics.byType} />
      <BucketTable title={t("analytics.byStance")} buckets={analytics.byStance} />

      <div className="analytics-table-block">
        <h4>{t("analytics.dismissalTrend")}</h4>
        {dismissalTrend.length === 0 ? (
          <p className="muted-copy">{t("analytics.noDecisionsInPeriod")}</p>
        ) : (
          <table className="analytics-table">
            <thead>
              <tr>
                <th scope="col">{t("analytics.col.date")}</th>
                <th scope="col">{t("analytics.col.decisions")}</th>
                <th scope="col">{t("analytics.col.dismissals")}</th>
                <th scope="col">{t("analytics.col.dismissalRate")}</th>
              </tr>
            </thead>
            <tbody>
              {dismissalTrend.map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>{point.decided}</td>
                  <td>{point.dismissed}</td>
                  <td>{formatRate(point.dismissalRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {analytics.lowAcceptanceSignals.length > 0 ? (
        <div className="analytics-table-block">
          <h4>{t("analytics.promptRevisionSignals")}</h4>
          <ul className="analytics-signals">
            {analytics.lowAcceptanceSignals.map((signal) => (
              <li key={`${signal.dimension}-${signal.key}`}>
                <strong>{signal.label}</strong> {tCommon("emDash")}{" "}
                {t("analytics.acceptanceSample", {
                  percent: Math.round(signal.acceptanceRate * 100),
                  count: signal.sampleSize
                })}{" "}
                {signal.note}
                {signal.promptVersion
                  ? ` ${t("analytics.currentVersion", { version: signal.promptVersion })}`
                  : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="analytics-table-block">
        <h4>{t("analytics.activePromptVersions")}</h4>
        <table className="analytics-table">
          <thead>
            <tr>
              <th scope="col">{t("analytics.col.surface")}</th>
              <th scope="col">{t("analytics.col.version")}</th>
              <th scope="col">{t("analytics.col.description")}</th>
            </tr>
          </thead>
          <tbody>
            {PROMPT_REGISTRY.map((entry) => (
              <tr key={entry.surface}>
                <td>{entry.surface}</td>
                <td>{entry.version}</td>
                <td>{translate(`analytics.prompt.${entry.surface}`, { ns: "settings" })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
};
