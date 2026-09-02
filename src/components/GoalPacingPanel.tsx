import { useTranslation } from "react-i18next";
import type { AppSettings, GoalPacingResult } from "../domain/types";
import { t as translate } from "../i18n";

interface GoalPacingPanelProps {
  result: GoalPacingResult | null;
  loading: boolean;
  settings: AppSettings;
  goalTitlesById: Map<string, string>;
  onRequestCoach: () => void;
  onRegenerate: () => void;
}

export const GoalPacingPanel = ({
  result,
  loading,
  settings,
  goalTitlesById,
  onRequestCoach,
  onRegenerate
}: GoalPacingPanelProps) => {
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

  const pacing = result?.pacing;

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{t("pacing.title")}</span>
        <small>{result ? translate(`source.${result.source}`, { ns: "coach" }) : tCommon("status.loading")}</small>
      </div>

      {loading && !pacing ? <p>{t("pacing.preparing")}</p> : null}

      {pacing && pacing.goals.length > 0 ? (
        <div className="coach-pulse__proposals">
          {pacing.goals.map((goal) => (
            <article key={goal.goalId} className="coach-pulse__proposal">
              <span>{goalTitlesById.get(goal.goalId) ?? goal.goalId}</span>
              <p>
                <strong>{goal.onPace ? t("pacing.onPace") : t("pacing.offPace")}</strong> {tCommon("emDash")}{" "}
                {t("pacing.riskPrefix", { level: translate(`risk.${goal.riskLevel}`, { ns: "coach" }) })}
              </p>
              <p>{goal.gap}</p>
              <p>
                <strong>{t("pacing.weeklyBehaviour")}</strong> {goal.requiredWeeklyBehaviour}
              </p>
              <p>
                <strong>{t("pacing.recommendation")}</strong> {goal.recommendation}
              </p>
            </article>
          ))}
        </div>
      ) : pacing ? (
        <p className="empty-copy">{t("pacing.empty")}</p>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">{t("warningFallbackPrefix", { warning: result.warning })}</small>
      ) : null}

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
