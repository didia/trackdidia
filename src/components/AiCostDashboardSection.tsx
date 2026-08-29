import { useCallback, useEffect, useState } from "react";
import type { AppSettings, AiUsageSummary } from "../domain/types";
import { applyCostEstimate } from "../lib/ai/analytics/cost";
import { getCurrentMonthKey } from "../lib/ai/analytics/month-range";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiCostDashboardSectionProps {
  repository: AppRepository;
  settings: AppSettings;
}

const formatInteger = (value: number): string => new Intl.NumberFormat("fr-CA").format(value);

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("fr-CA", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);

export const AiCostDashboardSection = ({ repository, settings }: AiCostDashboardSectionProps) => {
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const monthKey = getCurrentMonthKey();

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await repository.computeAiUsageForMonth(monthKey);
      setUsage(applyCostEstimate(summary, settings.aiCostPerMillionTokens));
    } finally {
      setLoading(false);
    }
  }, [repository, monthKey, settings.aiCostPerMillionTokens]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  return (
    <SectionCard
      title="Cout IA (mois en cours)"
      subtitle="Estimation locale a partir des jetons enregistres dans ai_messages. Les tarifs OpenRouter varient selon le modele."
    >
      <div className="status-grid">
        <article className="status-card">
          <span>Mois</span>
          <strong>{monthKey}</strong>
        </article>
        <article className="status-card">
          <span>Appels enregistres</span>
          <strong>{loading || !usage ? "..." : formatInteger(usage.callCount)}</strong>
        </article>
        <article className="status-card">
          <span>Jetons entree</span>
          <strong>{loading || !usage ? "..." : formatInteger(usage.tokensPrompt)}</strong>
        </article>
        <article className="status-card">
          <span>Jetons sortie</span>
          <strong>{loading || !usage ? "..." : formatInteger(usage.tokensCompletion)}</strong>
        </article>
        <article className="status-card">
          <span>Cout estime</span>
          <strong>{loading || !usage ? "..." : formatUsd(usage.estimatedCostUsd)}</strong>
        </article>
      </div>

      <p className="muted-copy">
        Cout calcule avec le tarif {settings.aiCostPerMillionTokens} USD / million de jetons (prompt + completion).
        Les tarifs OpenRouter varient selon le modele — ajuste le tarif dans Parametres IA.
      </p>
    </SectionCard>
  );
};
