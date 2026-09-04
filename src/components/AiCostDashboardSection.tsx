import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
    maximumFractionDigits: 4,
  }).format(value);

export const AiCostDashboardSection = ({
  repository,
  costPerMillionTokens,
}: AiCostDashboardSectionProps) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
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
      ? tCommon("ellipsis")
      : costPerMillionTokens === null
        ? tCommon("emDash")
        : formatUsd(usage?.estimatedCostUsd ?? 0);

  return (
    <SectionCard title={t("cost.title")} subtitle={t("cost.subtitle")}>
      <div className="status-grid">
        <article className="status-card">
          <span>{t("cost.month")}</span>
          <strong>{monthKey}</strong>
        </article>
        <article className="status-card">
          <span>{t("cost.calls")}</span>
          <strong>
            {loading || !totals ? tCommon("ellipsis") : formatInteger(totals.callCount)}
          </strong>
        </article>
        <article className="status-card">
          <span>{t("cost.tokensPrompt")}</span>
          <strong>
            {loading || !totals ? tCommon("ellipsis") : formatInteger(totals.tokensPrompt)}
          </strong>
        </article>
        <article className="status-card">
          <span>{t("cost.tokensCompletion")}</span>
          <strong>
            {loading || !totals ? tCommon("ellipsis") : formatInteger(totals.tokensCompletion)}
          </strong>
        </article>
        <article className="status-card">
          <span>{t("cost.estimated")}</span>
          <strong>{costLabel}</strong>
        </article>
      </div>

      <p className="muted-copy">
        {costPerMillionTokens === null
          ? t("cost.enterRateHint")
          : t("cost.calculatedWithRate", { rate: costPerMillionTokens })}
      </p>
    </SectionCard>
  );
};
