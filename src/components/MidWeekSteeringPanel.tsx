import { useTranslation } from "react-i18next";
import type { AppSettings, MidWeekSteeringResult } from "../domain/types";
import { formatDateLong } from "../lib/date";
import { t as translate } from "../i18n";

interface MidWeekSteeringPanelProps {
  result: MidWeekSteeringResult | null;
  loading: boolean;
  settings: AppSettings;
  /** Current `asOfDate`; a result from an earlier day of the week is labelled with its own date. */
  asOfDate: string;
  signalLabelsByKey: Map<string, string>;
  /** Sunday: no AI at all, a single line replaces the panel. */
  sunday: boolean;
  onRequestCoach: () => void;
  onRegenerate: () => void;
}

export const MidWeekSteeringPanel = ({
  result,
  loading,
  settings,
  asOfDate,
  signalLabelsByKey,
  sunday,
  onRequestCoach,
  onRegenerate,
}: MidWeekSteeringPanelProps) => {
  const { t } = useTranslation("coach");
  const { t: tCommon } = useTranslation("common");

  if (sunday) {
    return <p className="empty-copy">{t("midWeekSteering.sundayLine")}</p>;
  }

  const aiAvailable = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const disabledReason = !settings.aiEnabled
    ? t("disabled.aiOff")
    : !settings.aiApiKey.trim()
      ? t("disabled.missingKey")
      : null;
  const steering = result?.steering;

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{t("midWeekSteering.title")}</span>
        <small>
          {result
            ? translate(`source.${result.source}`, { ns: "coach" })
            : tCommon("status.loading")}
        </small>
      </div>

      {loading && !steering ? <p>{t("midWeekSteering.preparing")}</p> : null}

      {steering ? (
        <>
          {steering.asOfDate && steering.asOfDate !== asOfDate ? (
            <small>{t("midWeekSteering.asOf", { date: formatDateLong(steering.asOfDate) })}</small>
          ) : null}
          <h3>{steering.headline}</h3>
          <p>{steering.read}</p>
          <p>
            <strong>{t("midWeekSteering.focusShift")}</strong> {steering.focusShift}
          </p>
          {steering.actions.length > 0 ? (
            <div className="coach-pulse__proposals">
              {steering.actions.map((action) => (
                <article key={action.signalKey} className="coach-pulse__proposal">
                  <span>{signalLabelsByKey.get(action.signalKey) ?? action.signalKey}</span>
                  <p>
                    <strong>{action.title}</strong>
                  </p>
                  <p>{action.why}</p>
                  <small>
                    {t("midWeekSteering.effort", {
                      level: translate(`effort.${action.effort}`, { ns: "coach" }),
                    })}
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-copy">{t("midWeekSteering.empty")}</p>
          )}
        </>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">
          {t("warningFallbackPrefix", { warning: result.warning })}
        </small>
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
