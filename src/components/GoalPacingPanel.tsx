import type { AppSettings, GoalPacingResult } from "../domain/types";

const sourceLabels: Record<GoalPacingResult["source"], string> = {
  ai: "IA active",
  cache: "IA en cache",
  local: "Guide local",
  fallback: "Fallback local"
};

const riskLabels = {
  low: "Faible",
  medium: "Moyen",
  high: "Eleve"
} as const;

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
  const aiAvailable = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const disabledReason = !settings.aiEnabled
    ? "Active l'IA dans les parametres"
    : !settings.aiApiKey.trim()
      ? "Ajoute une cle OpenRouter dans les parametres"
      : null;

  if (!result && !loading) {
    return null;
  }

  const pacing = result?.pacing;

  return (
    <section className="coach-card coach-pulse">
      <div className="coach-card__label">
        <span>Pilotage annuel</span>
        <small>{result ? sourceLabels[result.source] : "Chargement..."}</small>
      </div>

      {loading && !pacing ? <p>Analyse du rythme annuel...</p> : null}

      {pacing && pacing.goals.length > 0 ? (
        <div className="coach-pulse__proposals">
          {pacing.goals.map((goal) => (
            <article key={goal.goalId} className="coach-pulse__proposal">
              <span>{goalTitlesById.get(goal.goalId) ?? goal.goalId}</span>
              <p>
                <strong>{goal.onPace ? "Dans les clous" : "Hors rythme"}</strong> — Risque {riskLabels[goal.riskLevel]}
              </p>
              <p>{goal.gap}</p>
              <p>
                <strong>Comportement hebdo:</strong> {goal.requiredWeeklyBehaviour}
              </p>
              <p>
                <strong>Recommandation:</strong> {goal.recommendation}
              </p>
            </article>
          ))}
        </div>
      ) : pacing ? (
        <p className="empty-copy">Aucun objectif annuel a analyser pour l'instant.</p>
      ) : null}

      {result?.warning ? <small className="coach-card__warning">Fallback local: {result.warning}</small> : null}

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
