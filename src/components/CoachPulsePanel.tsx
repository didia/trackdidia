import { useTranslation } from "react-i18next";
import { principleDefinitions } from "../domain/definitions";
import type { AiProposal, AppSettings, CoachPulseResult, PrincipleKey } from "../domain/types";
import { t as translate } from "../i18n";

const proposalTypeKeys = {
  intention_draft: "proposal.intentionDraft",
  tomorrow_focus_draft: "proposal.tomorrowFocus",
  commitment: "proposal.commitment",
  memory: "proposal.memory",
  review_section_draft: "proposal.reviewSection",
  weekly_objective: "proposal.weeklyObjective",
  gtd_action: "proposal.gtdAction",
  goal_evaluation: "proposal.goalEvaluation"
} as const satisfies Partial<Record<AiProposal["type"], string>>;

const principleLabel = (key: PrincipleKey | null | undefined): string | null => {
  if (!key) {
    return null;
  }

  return principleDefinitions.find((definition) => definition.key === key)?.label ?? key;
};

interface CoachPulsePanelProps {
  title: string;
  result: CoachPulseResult | null;
  loading: boolean;
  settings: AppSettings;
  /** When true, hide the explicit request button because the page auto-loads AI. */
  autoloadAi?: boolean;
  onRequestCoach?: () => void;
  onRegenerate: () => void;
  onAcceptProposal: (proposal: AiProposal) => void;
  onDismissProposal: (proposal: AiProposal) => void;
}

export const CoachPulsePanel = ({
  title,
  result,
  loading,
  settings,
  autoloadAi = false,
  onRequestCoach,
  onRegenerate,
  onAcceptProposal,
  onDismissProposal
}: CoachPulsePanelProps) => {
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

  const pulse = result?.pulse;
  const pendingProposals = result?.proposals.filter((proposal) => proposal.status === "pending") ?? [];
  const principleRecovery = principleLabel(pulse?.principleToRecover);

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{title}</span>
        <small>{result ? translate(`source.${result.source}`, { ns: "coach" }) : tCommon("status.loading")}</small>
      </div>

      {loading && !pulse ? <p>{t("pulse.preparing")}</p> : null}

      {pulse ? (
        <div className="coach-pulse__body">
          <p className="coach-pulse__stance">{translate(`stance.${pulse.stance}`, { ns: "coach" })}</p>
          <h3 className="coach-pulse__headline">{pulse.headline}</h3>
          <p>{pulse.read}</p>
          {pulse.move ? (
            <article className="coach-pulse__move">
              <strong>{pulse.move.what}</strong>
              <span>{pulse.move.why}</span>
              <small>{t("pulse.horizonPrefix", { horizon: pulse.move.horizon })}</small>
            </article>
          ) : null}

          {pulse.priorities && pulse.priorities.length > 0 ? (
            <div className="coach-pulse__priorities">
              <strong>{t("pulse.priorities")}</strong>
              <ul>
                {pulse.priorities.map((priority, index) => (
                  <li key={`${priority.title}-${index}`}>
                    {priority.title} {tCommon("emDash")} {priority.why}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pulse.wins && pulse.wins.length > 0 ? (
            <div className="coach-pulse__wins">
              <strong>{t("pulse.wins")}</strong>
              <ul>
                {pulse.wins.map((win) => (
                  <li key={win}>{win}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {pulse.frictionPoint ? (
            <article className="coach-pulse__friction">
              <strong>{t("pulse.friction")}</strong>
              <p>{pulse.frictionPoint.what}</p>
              <p>{pulse.frictionPoint.why}</p>
              <p>
                <em>{t("pulse.adjustment")}</em> {pulse.frictionPoint.adjustment}
              </p>
            </article>
          ) : null}

          {principleRecovery ? (
            <p className="coach-pulse__principle">
              <strong>{t("pulse.principleToRecover")}</strong> {principleRecovery}
            </p>
          ) : null}
        </div>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">{t("warningFallbackPrefix", { warning: result.warning })}</small>
      ) : null}

      {pendingProposals.length > 0 ? (
        <div className="coach-pulse__proposals">
          <strong>{t("proposals")}</strong>
          {pendingProposals.map((proposal) => {
            const payload = JSON.parse(proposal.payloadJson) as { text?: string; statement?: string; kind?: string };
            const preview =
              proposal.type === "memory"
                ? `[${payload.kind ?? t("proposal.memoryKindFallback")}] ${payload.statement ?? ""}`
                : proposal.type === "commitment"
                  ? payload.statement ?? ""
                  : payload.text ?? "";
            const typeKey = proposalTypeKeys[proposal.type];
            return (
              <article key={proposal.id} className="coach-pulse__proposal">
                <span>{typeKey ? t(typeKey) : t("proposal.generic")}</span>
                <p>{preview}</p>
                <div className="section-actions">
                  <button className="button button--primary" type="button" onClick={() => onAcceptProposal(proposal)}>
                    {t("accept")}
                  </button>
                  <button className="button button--ghost" type="button" onClick={() => onDismissProposal(proposal)}>
                    {t("dismiss")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <div className="section-actions coach-pulse__actions">
        {!autoloadAi && onRequestCoach ? (
          <button
            className="button button--primary"
            type="button"
            disabled={!aiAvailable || loading}
            title={disabledReason ?? undefined}
            onClick={onRequestCoach}
          >
            {disabledReason ?? t("request")}
          </button>
        ) : null}
        <button
          className="button"
          type="button"
          disabled={!aiAvailable || loading}
          title={disabledReason ?? undefined}
          onClick={onRegenerate}
        >
          {t("regenerate")}
        </button>
        {autoloadAi && disabledReason ? (
          <small className="coach-card__warning">{disabledReason}</small>
        ) : null}
      </div>
    </section>
  );
};
