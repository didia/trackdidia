import { useCallback, useEffect, useState } from "react";
import { loadCoachAnalytics } from "../lib/ai/analytics/load-coach-analytics";
import type { AcceptanceRateBucket, CoachAnalyticsSummary } from "../lib/ai/analytics/proposal-analytics";
import { PROMPT_REGISTRY } from "../lib/ai/prompts/registry";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiCoachAnalyticsSectionProps {
  repository: AppRepository;
}

const formatRate = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value * 100)} %`;

const BucketTable = ({ title, buckets }: { title: string; buckets: AcceptanceRateBucket[] }) => (
  <div className="analytics-table-block">
    <h4>{title}</h4>
    {buckets.length === 0 ? (
      <p className="muted-copy">Aucune proposition decidee pour le moment.</p>
    ) : (
      <table className="analytics-table">
        <thead>
          <tr>
            <th scope="col">Libelle</th>
            <th scope="col">Decidees</th>
            <th scope="col">Acceptees</th>
            <th scope="col">Rejetees</th>
            <th scope="col">Taux d&apos;acceptation</th>
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

export const AiCoachAnalyticsSection = ({ repository }: AiCoachAnalyticsSectionProps) => {
  const [analytics, setAnalytics] = useState<CoachAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      setAnalytics(await loadCoachAnalytics(repository));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  if (loading) {
    return (
      <SectionCard title="Analytique coach" subtitle="Taux d'acceptation des propositions IA (lecture seule).">
        <p className="muted-copy">Chargement...</p>
      </SectionCard>
    );
  }

  if (!analytics) {
    return null;
  }

  const recentDismissals = analytics.dismissalTrend.filter((point) => point.decided > 0).slice(-7);

  return (
    <SectionCard
      title="Analytique coach"
      subtitle="Taux d'acceptation des propositions IA (lecture seule). Aucune modification automatique de prompt."
    >
      <BucketTable title="Par surface" buckets={analytics.bySurface} />
      <BucketTable title="Par type de proposition" buckets={analytics.byType} />
      <BucketTable title="Par posture (pulse coach)" buckets={analytics.byStance} />

      <div className="analytics-table-block">
        <h4>Tendance de rejet (30 derniers jours)</h4>
        {recentDismissals.length === 0 ? (
          <p className="muted-copy">Aucune decision enregistree sur la periode.</p>
        ) : (
          <table className="analytics-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Decisions</th>
                <th scope="col">Rejets</th>
                <th scope="col">Taux de rejet</th>
              </tr>
            </thead>
            <tbody>
              {recentDismissals.map((point) => (
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
          <h4>Signaux de revision de prompt</h4>
          <ul className="analytics-signals">
            {analytics.lowAcceptanceSignals.map((signal) => (
              <li key={`${signal.dimension}-${signal.key}`}>
                <strong>{signal.label}</strong> — {Math.round(signal.acceptanceRate * 100)} % d&apos;acceptation
                sur {signal.sampleSize} decisions. {signal.note}
                {signal.promptVersion ? ` (version actuelle : ${signal.promptVersion})` : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="analytics-table-block">
        <h4>Versions de prompt actives</h4>
        <table className="analytics-table">
          <thead>
            <tr>
              <th scope="col">Surface</th>
              <th scope="col">Version</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {PROMPT_REGISTRY.map((entry) => (
              <tr key={entry.surface}>
                <td>{entry.surface}</td>
                <td>{entry.version}</td>
                <td>{entry.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
};
