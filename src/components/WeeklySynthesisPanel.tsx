import type { ProposalDecisions } from "../app/use-proposal-decisions";
import { ProposalList } from "./ProposalList";
import { useTranslation } from "react-i18next";
import type { AppSettings, WeeklySynthesisResult } from "../domain/types";
import { t as translate } from "../i18n";

interface WeeklySynthesisPanelProps {
  result: WeeklySynthesisResult | null;
  loading: boolean;
  settings: AppSettings;
  onRequestCoach: () => void;
  onRegenerate: () => void;
  decisions: ProposalDecisions;
}

export const WeeklySynthesisPanel = ({
  result,
  loading,
  settings,
  onRequestCoach,
  onRegenerate,
  decisions,
}: WeeklySynthesisPanelProps) => {
  const { t } = useTranslation("coach");
  const { t: tCommon } = useTranslation("common");
  const aiAvailable = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const disabledReason = !settings.aiEnabled
    ? t("disabled.aiOff")
    : !settings.aiApiKey.trim()
      ? t("disabled.missingKey")
      : null;

  if (!result && !loading) {
    return null;
  }

  const synthesis = result?.synthesis;

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{t("weekly.title")}</span>
        <small>
          {result
            ? translate(`source.${result.source}`, { ns: "coach" })
            : tCommon("status.loading")}
        </small>
      </div>

      {loading && !synthesis ? <p>{t("weekly.preparing")}</p> : null}

      {synthesis ? (
        <div className="coach-pulse__body">
          <h3 className="coach-pulse__headline">{synthesis.headline}</h3>
          <p>{synthesis.scoreExplanation}</p>
          <p>
            <strong>{t("weekly.strongestAxis")}</strong> {synthesis.strongestAxis}
          </p>
          <p>
            <strong>{t("weekly.weakestAxes")}</strong> {(synthesis.weakestAxes ?? []).join(", ")}
          </p>
        </div>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">
          {t("warningFallbackPrefix", { warning: result.warning })}
        </small>
      ) : null}

      <ProposalList surface="weekly" proposals={result?.proposals ?? []} decisions={decisions} />

      <div className="section-actions coach-pulse__actions">
        <button
          className="button button--primary"
          type="button"
          disabled={!aiAvailable || loading}
          title={disabledReason ?? undefined}
          onClick={onRequestCoach}
        >
          {disabledReason ?? t("request")}
        </button>
        <button
          className="button"
          type="button"
          disabled={!aiAvailable || loading}
          title={disabledReason ?? undefined}
          onClick={onRegenerate}
        >
          {t("regenerate")}
        </button>
      </div>
    </section>
  );
};
