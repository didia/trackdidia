import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiUsageSummary, AiUsageTotals } from "../domain/types";
import { applyCostEstimate } from "../lib/ai/analytics/cost";
import { getCurrentMonthKey } from "../lib/ai/analytics/month-range";
import type { AppRepository } from "../lib/storage/repository";
import { SectionCard } from "./SectionCard";

interface AiCostDashboardSectionProps {
  repository: AppRepository;
  /** Null when the rate draft is empty — cost estimate is omitted instead of showing $0.00. */
  costPerMillionTokens: number | null;
}

const formatInteger = (value: number): string => new Intl.NumberFormat("fr-CA").format(value);

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("fr-CA", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(value);

export const AiCostDashboardSection = ({ repository, costPerMillionTokens }: AiCostDashboardSectionProps) => {
  const [totals, setTotals] = useState<AiUsageTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const monthKey = getCurrentMonthKey();

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      setTotals(await repository.computeAiUsageForMonth(monthKey));
    } finally {
      setLoading(false);
    }
  }, [repository, monthKey]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const usage = useMemo((): AiUsageSummary | null => {
    if (!totals || costPerMillionTokens === null) {
      return null;
    }
    return applyCostEstimate(totals, costPerMillionTokens);
  }, [totals, costPerMillionTokens]);

  const costLabel =
    loading || !totals
      ? "..."
      : costPerMillionTokens === null
        ? "—"
        : formatUsd(usage!.estimatedCostUsd);

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
          <strong>{loading || !totals ? "..." : formatInteger(totals.callCount)}</strong>
        </article>
        <article className="status-card">
          <span>Jetons entree</span>
          <strong>{loading || !totals ? "..." : formatInteger(totals.tokensPrompt)}</strong>
        </article>
        <article className="status-card">
          <span>Jetons sortie</span>
          <strong>{loading || !totals ? "..." : formatInteger(totals.tokensCompletion)}</strong>
        </article>
        <article className="status-card">
          <span>Cout estime</span>
          <strong>{costLabel}</strong>
        </article>
      </div>

      <p className="muted-copy">
        {costPerMillionTokens === null ? (
          <>Entrez un tarif approximatif dans Parametres IA pour estimer le cout.</>
        ) : (
          <>
            Cout calcule avec le tarif {costPerMillionTokens} USD / million de jetons (prompt + completion). Les
            tarifs OpenRouter varient selon le modele — ajuste le tarif dans Parametres IA.
          </>
        )}
      </p>
    </SectionCard>
  );
};
