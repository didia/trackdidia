import type { AiProposal, AppSettings, CoachPulseResult } from "../domain/types";

const sourceLabels: Record<CoachPulseResult["source"], string> = {
  ai: "IA active",
  cache: "IA en cache",
  local: "Guide local",
  fallback: "Fallback local"
};

const proposalLabels: Record<AiProposal["type"], string> = {
  intention_draft: "Intention du matin",
  tomorrow_focus_draft: "Focus de demain"
};

interface CoachPulsePanelProps {
  title: string;
  result: CoachPulseResult | null;
  loading: boolean;
  settings: AppSettings;
  onRequestCoach: () => void;
  onRegenerate: () => void;
  onAcceptProposal: (proposal: AiProposal) => void;
  onDismissProposal: (proposal: AiProposal) => void;
}

export const CoachPulsePanel = ({
  title,
  result,
  loading,
  settings,
  onRequestCoach,
  onRegenerate,
  onAcceptProposal,
  onDismissProposal
}: CoachPulsePanelProps) => {
  const aiAvailable = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const disabledReason = !settings.aiEnabled
    ? "Active l'IA dans les parametres"
    : !settings.aiApiKey.trim()
      ? "Ajoute une cle OpenRouter dans les parametres"
      : null;

  if (!result && !loading) {
    return null;
  }

  const pulse = result?.pulse;
  const pendingProposals = result?.proposals.filter((proposal) => proposal.status === "pending") ?? [];

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>{title}</span>
        <small>{result ? sourceLabels[result.source] : "Chargement..."}</small>
      </div>

      {loading && !pulse ? <p>Preparation du coach...</p> : null}

      {pulse ? (
        <div className="coach-pulse__body">
          <h3 className="coach-pulse__headline">{pulse.headline}</h3>
          <p>{pulse.read}</p>
          {pulse.move ? (
            <article className="coach-pulse__move">
              <strong>{pulse.move.what}</strong>
              <span>{pulse.move.why}</span>
              <small>Horizon: {pulse.move.horizon}</small>
            </article>
          ) : null}

          {pulse.priorities && pulse.priorities.length > 0 ? (
            <div className="coach-pulse__priorities">
              <strong>Priorites</strong>
              <ul>
                {pulse.priorities.map((priority, index) => (
                  <li key={`${priority.title}-${index}`}>
                    {priority.title} — {priority.why}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pulse.wins && pulse.wins.length > 0 ? (
            <div className="coach-pulse__wins">
              <strong>Victoires</strong>
              <ul>
                {pulse.wins.map((win) => (
                  <li key={win}>{win}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {result?.warning ? <small className="coach-card__warning">Fallback local: {result.warning}</small> : null}

      {pendingProposals.length > 0 ? (
        <div className="coach-pulse__proposals">
          <strong>Suggestions</strong>
          {pendingProposals.map((proposal) => {
            const payload = JSON.parse(proposal.payloadJson) as { text?: string };
            return (
              <article key={proposal.id} className="coach-pulse__proposal">
                <span>{proposalLabels[proposal.type]}</span>
                <p>{payload.text ?? ""}</p>
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
          Régénérer
        </button>
      </div>
    </section>
  );
};
