import { useTranslation } from "react-i18next";
import type { AiProposal, AppSettings, MonthlySynthesisResult } from "../domain/types";
import { t as translate } from "../i18n";

const proposalTypeKeys = {
  intention_draft: "proposal.intentionDraft",
  tomorrow_focus_draft: "proposal.tomorrowFocus",
  commitment: "proposal.commitment",
  memory: "proposal.memory",
  review_section_draft: "proposal.reviewSection",
  weekly_objective: "proposal.weeklyObjective",
  gtd_action: "proposal.gtdAction",
  goal_evaluation: "proposal.goalEvaluation",
} as const satisfies Record<AiProposal["type"], string>;

interface MonthlySynthesisPanelProps {
  result: MonthlySynthesisResult | null;
  loading: boolean;
  notice?: string | null;
  settings: AppSettings;
  onRequestCoach: () => void;
  onRegenerate: () => void;
  onAcceptProposal: (proposal: AiProposal) => void;
  onDismissProposal: (proposal: AiProposal) => void;
}

export const MonthlySynthesisPanel = ({
  result,
  loading,
  notice,
  settings,
  onRequestCoach,
  onRegenerate,
  onAcceptProposal,
  onDismissProposal,
}: MonthlySynthesisPanelProps) => {
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
  const pendingProposals =
    result?.proposals.filter((proposal) => proposal.status === "pending") ?? [];

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{t("monthly.title")}</span>
        <small>
          {result
            ? translate(`source.${result.source}`, { ns: "coach" })
            : tCommon("status.loading")}
        </small>
      </div>

      {loading && !synthesis ? <p>{t("monthly.preparing")}</p> : null}

      {synthesis ? (
        <div className="coach-pulse__body">
          <h3 className="coach-pulse__headline">{synthesis.headline}</h3>
          <p>{synthesis.weekPattern}</p>
        </div>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">
          {t("warningFallbackPrefix", { warning: result.warning })}
        </small>
      ) : null}

      {notice ? <small className="coach-card__warning">{notice}</small> : null}

      {pendingProposals.length > 0 ? (
        <div className="coach-pulse__proposals">
          <strong>{t("proposals")}</strong>
          {pendingProposals.map((proposal) => {
            const payload = JSON.parse(proposal.payloadJson) as {
              text?: string;
              sectionKey?: string;
              goalId?: string;
              score?: number | null;
              notes?: string;
            };
            const preview =
              proposal.type === "review_section_draft"
                ? `[${payload.sectionKey ?? t("proposal.sectionFallback")}] ${payload.text ?? ""}`
                : proposal.type === "goal_evaluation"
                  ? `[${payload.goalId ?? t("proposal.goalFallback")}] ${payload.score ?? tCommon("emDash")}/100 ${tCommon("emDash")} ${payload.notes ?? ""}`
                  : (payload.text ?? "");
            return (
              <article key={proposal.id} className="coach-pulse__proposal">
                <span>{t(proposalTypeKeys[proposal.type])}</span>
                <p>{preview}</p>
                <div className="section-actions">
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => onAcceptProposal(proposal)}
                  >
                    {t("accept")}
                  </button>
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => onDismissProposal(proposal)}
                  >
                    {t("dismiss")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
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
