import type { AiProposal, AppSettings, WeeklySynthesisResult } from "../domain/types";

const sourceLabels: Record<WeeklySynthesisResult["source"], string> = {
  ai: "IA active",
  cache: "IA en cache",
  local: "Guide local",
  fallback: "Fallback local"
};

const proposalLabels: Record<AiProposal["type"], string> = {
  intention_draft: "Intention du matin",
  tomorrow_focus_draft: "Focus de demain",
  commitment: "Engagement pour demain",
  memory: "Memoire candidate",
  review_section_draft: "Brouillon de section",
  weekly_objective: "Objectif hebdomadaire",
  gtd_action: "Action GTD"
};

interface WeeklySynthesisPanelProps {
  result: WeeklySynthesisResult | null;
  loading: boolean;
  settings: AppSettings;
  onRequestCoach: () => void;
  onRegenerate: () => void;
  onAcceptProposal: (proposal: AiProposal) => void;
  onDismissProposal: (proposal: AiProposal) => void;
}

export const WeeklySynthesisPanel = ({
  result,
  loading,
  settings,
  onRequestCoach,
  onRegenerate,
  onAcceptProposal,
  onDismissProposal
}: WeeklySynthesisPanelProps) => {
  const aiAvailable = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const disabledReason = !settings.aiEnabled
    ? "Active l'IA dans les parametres"
    : !settings.aiApiKey.trim()
      ? "Ajoute une cle OpenRouter dans les parametres"
      : null;

  if (!result && !loading) {
    return null;
  }

  const synthesis = result?.synthesis;
  const pendingProposals = result?.proposals.filter((proposal) => proposal.status === "pending") ?? [];

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>Coach hebdomadaire</span>
        <small>{result ? sourceLabels[result.source] : "Chargement..."}</small>
      </div>

      {loading && !synthesis ? <p>Preparation de la synthese...</p> : null}

      {synthesis ? (
        <div className="coach-pulse__body">
          <h3 className="coach-pulse__headline">{synthesis.headline}</h3>
          <p>{synthesis.scoreExplanation}</p>
          <p>
            <strong>Axe le plus solide:</strong> {synthesis.strongestAxis}
          </p>
          <p>
            <strong>Axes a surveiller:</strong> {(synthesis.weakestAxes ?? []).join(", ")}
          </p>
        </div>
      ) : null}

      {result?.warning ? <small className="coach-card__warning">Fallback local: {result.warning}</small> : null}

      {pendingProposals.length > 0 ? (
        <div className="coach-pulse__proposals">
          <strong>Suggestions</strong>
          {pendingProposals.map((proposal) => {
            const payload = JSON.parse(proposal.payloadJson) as {
              text?: string;
              title?: string;
              sectionKey?: string;
              action?: string;
              reason?: string;
            };
            const preview =
              proposal.type === "review_section_draft"
                ? `[${payload.sectionKey ?? "section"}] ${payload.text ?? ""}`
                : proposal.type === "weekly_objective"
                  ? payload.title ?? "Objectif"
                  : proposal.type === "gtd_action"
                    ? `${payload.action ?? "action"} — ${payload.reason ?? ""}`
                    : payload.text ?? "";
            return (
              <article key={proposal.id} className="coach-pulse__proposal">
                <span>{proposalLabels[proposal.type]}</span>
                <p>{preview}</p>
                <div className="section-actions">
                  <button className="button button--primary" type="button" onClick={() => onAcceptProposal(proposal)}>
                    Accepter
                  </button>
                  <button className="button button--ghost" type="button" onClick={() => onDismissProposal(proposal)}>
                    Ignorer
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
          {disabledReason ?? "Demander au coach"}
        </button>
        <button
          className="button"
          type="button"
          disabled={!aiAvailable || loading}
          title={disabledReason ?? undefined}
          onClick={onRegenerate}
        >
          Regenerer
        </button>
      </div>
    </section>
  );
};
