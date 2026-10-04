import { useTranslation } from "react-i18next";
import type { ProposalDecisions } from "../app/use-proposal-decisions";
import type { AiProposal } from "../domain/types";
import { proposalPreviewText } from "../lib/ai/proposals/apply-proposal";

export type ProposalSurface = "pulse" | "weekly" | "monthly";

const reviewLabelKeys = {
  intention_draft: "proposal.intentionDraft",
  tomorrow_focus_draft: "proposal.tomorrowFocus",
  commitment: "proposal.commitment",
  memory: "proposal.memory",
  review_section_draft: "proposal.reviewSection",
  weekly_objective: "proposal.weeklyObjective",
  gtd_action: "proposal.gtdAction",
  goal_evaluation: "proposal.goalEvaluation",
} as const satisfies Record<AiProposal["type"], string>;

type ProposalLabelKeys = Partial<
  Record<AiProposal["type"], (typeof reviewLabelKeys)[AiProposal["type"]]>
>;

/** Per-surface badge labels (coach namespace keys); unknown types fall back to the generic label. */
export const proposalLabelKeys: Record<ProposalSurface, ProposalLabelKeys> = {
  pulse: { ...reviewLabelKeys },
  weekly: reviewLabelKeys,
  monthly: reviewLabelKeys,
};

const previewSurface = (surface: ProposalSurface): "weekly" | "monthly" | undefined =>
  surface === "pulse" ? undefined : surface;

interface ProposalListProps {
  surface: ProposalSurface;
  proposals: AiProposal[];
  decisions: ProposalDecisions;
}

export const ProposalList = ({ surface, proposals, decisions }: ProposalListProps) => {
  const { t } = useTranslation("coach");
  const { t: tCommon } = useTranslation("common");
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  if (pending.length === 0) return null;
  const labelKeys = proposalLabelKeys[surface];

  return (
    <div className="coach-pulse__proposals">
      <strong>{t("proposals")}</strong>
      {pending.map((proposal) => {
        const applying = decisions.isApplying(proposal.id);
        const labelKey = labelKeys[proposal.type];
        return (
          <article key={proposal.id} className="coach-pulse__proposal">
            <span>{labelKey ? t(labelKey) : t("proposal.generic")}</span>
            <p>{proposalPreviewText(proposal, previewSurface(surface))}</p>
            <div className="section-actions">
              <button
                className="button button--primary"
                type="button"
                disabled={applying}
                onClick={() => void decisions.accept(proposal)}
              >
                {applying ? tCommon("status.applying") : t("accept")}
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={applying}
                onClick={() => void decisions.dismiss(proposal)}
              >
                {t("dismiss")}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
};
