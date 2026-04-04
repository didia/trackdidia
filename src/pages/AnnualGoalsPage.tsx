import { useCallback, useEffect, useMemo, useState } from "react";
import {
  annualGoalDimensions,
  annualGoalSourceOptions,
  annualGoalTrendOptions,
  createEmptyAnnualGoal,
  updateAnnualGoalEvaluation
} from "../domain/annual-goals";
import type { AnnualGoal, AnnualGoalSnapshot } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { getMonthKey } from "../domain/monthly-review";
import { getTodayDate } from "../lib/date";

const formatMaybeNumber = (value: number | null, unit: string): string =>
  value === null ? "—" : `${Math.round(value)} ${unit}`.trim();

const AnnualGoalCard = ({
  goal,
  snapshot,
  evaluationMonthKey,
  onSaveGoal,
  onDeleteGoal,
  onSaveEvaluation
}: {
  goal: AnnualGoal;
  snapshot: AnnualGoalSnapshot | undefined;
  evaluationMonthKey: string;
  onSaveGoal: (goal: AnnualGoal) => Promise<void>;
  onDeleteGoal: (goalId: string) => Promise<void>;
  onSaveEvaluation: (goal: AnnualGoal, monthKey: string, changes: Partial<AnnualGoal["evaluations"][string]>) => Promise<void>;
}) => {
  const [draft, setDraft] = useState(goal);

  useEffect(() => {
    setDraft(goal);
  }, [goal]);

  const evaluation = draft.evaluations[evaluationMonthKey] ?? {
    monthKey: evaluationMonthKey,
    score: null,
    trend: null,
    notes: "",
    blockers: ""
  };
  const [scoreDraft, setScoreDraft] = useState(evaluation.score === null ? "" : String(evaluation.score));

  useEffect(() => {
    setScoreDraft(evaluation.score === null ? "" : String(evaluation.score));
  }, [evaluation.score, evaluationMonthKey, goal.id]);

  return (
    <article className="goal-card">
      <div className="goal-card__header">
        <div>
          <strong>{goal.title || "Nouvel objectif"}</strong>
          <p className="empty-copy">{snapshot?.sourceLabel ?? "Source manuelle"}</p>
        </div>
        <div className="task-card__quick-actions">
          <button className="button" type="button" onClick={() => void onSaveGoal(draft)}>
            Enregistrer
          </button>
          <button className="button button--ghost" type="button" onClick={() => void onDeleteGoal(goal.id)}>
            Supprimer
          </button>
        </div>
      </div>

      <div className="task-card__grid">
        <label className="stacked-field">
          <span>Titre</span>
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label className="stacked-field">
          <span>Dimension</span>
          <select
            value={draft.dimension}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dimension: event.target.value as AnnualGoal["dimension"]
              }))
            }
          >
            {annualGoalDimensions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stacked-field">
          <span>Source</span>
          <select
            value={draft.sourceId ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceId: event.target.value ? (event.target.value as AnnualGoal["sourceId"]) : null
              }))
            }
          >
            <option value="">Manuel</option>
            {annualGoalSourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stacked-field">
          <span>Cible</span>
          <input
            type="number"
            value={draft.targetValue ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                targetValue: event.target.value.trim() === "" ? null : Number(event.target.value)
              }))
            }
          />
        </label>
        <label className="stacked-field">
          <span>Unite</span>
          <input value={draft.unit} onChange={(event) => setDraft((current) => ({ ...current, unit: event.target.value }))} />
        </label>
        <label className="stacked-field">
          <span>Etat actuel manuel</span>
          <input
            type="number"
            value={draft.manualCurrentValue ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                manualCurrentValue: event.target.value.trim() === "" ? null : Number(event.target.value)
              }))
            }
          />
        </label>
      </div>

      <label className="stacked-field">
        <span>Description</span>
        <PersistedTextarea
          key={`${goal.id}-description`}
          rows={3}
          debounceMs={0}
          savedValue={draft.description}
          onPersist={(value) => setDraft((current) => ({ ...current, description: value }))}
        />
      </label>

      <div className="weekly-overview-grid">
        <article className="status-card">
          <span>Etat actuel</span>
          <strong>{formatMaybeNumber(snapshot?.currentValue ?? null, draft.unit)}</strong>
        </article>
        <article className="status-card">
          <span>Progression</span>
          <strong>{snapshot?.progressRatio === null || snapshot?.progressRatio === undefined ? "—" : `${Math.round(snapshot.progressRatio * 100)}%`}</strong>
        </article>
        <article className="status-card">
          <span>Source</span>
          <strong>{snapshot?.sourceLabel ?? "Manuelle"}</strong>
        </article>
      </div>

      <div className="goal-card__tags">
        {snapshot?.linkedWeeklyMetricLabels.map((label) => (
          <span key={`weekly-${label}`} className="tag-chip">{label}</span>
        ))}
        {snapshot?.linkedDailyHabitLabels.map((label) => (
          <span key={`daily-${label}`} className="tag-chip">{label}</span>
        ))}
      </div>

      <div className="goal-card__progress">
        {(snapshot?.monthlyProgress ?? []).map((point) => (
          <article key={point.monthKey} className={`goal-progress-pill${point.monthKey === evaluationMonthKey ? " goal-progress-pill--active" : ""}`}>
            <span>{point.monthKey.slice(5)}</span>
            <strong>{point.value === null ? "—" : Math.round(point.value)}</strong>
          </article>
        ))}
      </div>

      <div className="goal-card__evaluation">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>Score {evaluationMonthKey}</span>
            <input
              type="number"
              value={scoreDraft}
              onChange={(event) => setScoreDraft(event.target.value)}
              onBlur={() =>
                void onSaveEvaluation(goal, evaluationMonthKey, {
                  score: scoreDraft.trim() === "" ? null : Number(scoreDraft)
                })
              }
            />
          </label>
          <label className="stacked-field">
            <span>Tendance</span>
            <select
              value={evaluation.trend ?? ""}
              onChange={(event) =>
                void onSaveEvaluation(goal, evaluationMonthKey, {
                  trend: event.target.value ? (event.target.value as NonNullable<typeof evaluation.trend>) : null
                })
              }
            >
              <option value="">Aucune</option>
              {annualGoalTrendOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="stacked-field">
          <span>Notes mensuelles</span>
          <PersistedTextarea
            key={`${goal.id}-${evaluationMonthKey}-notes`}
            rows={3}
            debounceMs={0}
            savedValue={evaluation.notes}
            onPersist={(value) => void onSaveEvaluation(goal, evaluationMonthKey, { notes: value })}
          />
        </label>
        <label className="stacked-field">
          <span>Blocages</span>
          <PersistedTextarea
            key={`${goal.id}-${evaluationMonthKey}-blockers`}
            rows={3}
            debounceMs={0}
            savedValue={evaluation.blockers}
            onPersist={(value) => void onSaveEvaluation(goal, evaluationMonthKey, { blockers: value })}
          />
        </label>
      </div>
    </article>
  );
};

export const AnnualGoalsPage = () => {
  const { repository } = useAppContext();
  const currentYear = Number(getTodayDate().slice(0, 4));
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [evaluationMonthKey, setEvaluationMonthKey] = useState(getMonthKey(getTodayDate()));
  const [goals, setGoals] = useState<AnnualGoal[]>([]);
  const [snapshots, setSnapshots] = useState<AnnualGoalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftGoal, setDraftGoal] = useState<AnnualGoal>(
    createEmptyAnnualGoal({
      dimension: "global"
    })
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [nextGoals, nextSnapshots] = await Promise.all([
      repository.listAnnualGoals(),
      repository.computeAnnualGoalSnapshots(selectedYear)
    ]);
    setGoals(nextGoals);
    setSnapshots(nextSnapshots);
    setLoading(false);
  }, [repository, selectedYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const snapshotMap = useMemo(
    () => new Map(snapshots.map((snapshot) => [snapshot.goal.id, snapshot])),
    [snapshots]
  );

  const saveGoal = useCallback(
    async (goal: AnnualGoal) => {
      await repository.saveAnnualGoal(goal);
      await load();
    },
    [load, repository]
  );

  const deleteGoal = useCallback(
    async (goalId: string) => {
      await repository.deleteAnnualGoal(goalId);
      await load();
    },
    [load, repository]
  );

  const saveEvaluation = useCallback(
    async (goal: AnnualGoal, monthKey: string, changes: Partial<AnnualGoal["evaluations"][string]>) => {
      await repository.saveAnnualGoal(updateAnnualGoalEvaluation(goal, monthKey, changes));
      await load();
    },
    [load, repository]
  );

  if (loading) {
    return <div className="page"><p>Chargement des objectifs annuels...</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Objectifs annuels</p>
          <h2>Dimensions de vie, cibles, progression mensuelle et blocages.</h2>
          <p className="hero__copy">
            L'objectif n'est pas juste de declarer une ambition, mais de voir quelles habitudes quotidiennes et quels resultats hebdo la nourrissent reellement.
          </p>
        </div>
      </header>

      <SectionCard title="Pilotage" subtitle="Choisis l'annee de reference et le mois d'evaluation.">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>Annee</span>
            <input
              type="number"
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value || currentYear))}
            />
          </label>
          <label className="stacked-field">
            <span>Mois d'evaluation</span>
            <input
              type="month"
              value={evaluationMonthKey}
              onChange={(event) => setEvaluationMonthKey(event.target.value)}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Ajouter un objectif" subtitle="Structure par dimension, cible et source de donnees.">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>Titre</span>
            <input value={draftGoal.title} onChange={(event) => setDraftGoal((current) => ({ ...current, title: event.target.value }))} />
          </label>
          <label className="stacked-field">
            <span>Dimension</span>
            <select
              value={draftGoal.dimension}
              onChange={(event) => setDraftGoal((current) => ({ ...current, dimension: event.target.value as AnnualGoal["dimension"] }))}
            >
              {annualGoalDimensions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>Source</span>
            <select
              value={draftGoal.sourceId ?? ""}
              onChange={(event) =>
                setDraftGoal((current) => ({
                  ...current,
                  sourceId: event.target.value ? (event.target.value as AnnualGoal["sourceId"]) : null
                }))
              }
            >
              <option value="">Manuel</option>
              {annualGoalSourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>Cible</span>
            <input
              type="number"
              value={draftGoal.targetValue ?? ""}
              onChange={(event) =>
                setDraftGoal((current) => ({
                  ...current,
                  targetValue: event.target.value.trim() === "" ? null : Number(event.target.value)
                }))
              }
            />
          </label>
          <label className="stacked-field">
            <span>Unite</span>
            <input value={draftGoal.unit} onChange={(event) => setDraftGoal((current) => ({ ...current, unit: event.target.value }))} />
          </label>
          <label className="stacked-field">
            <span>Valeur manuelle actuelle</span>
            <input
              type="number"
              value={draftGoal.manualCurrentValue ?? ""}
              onChange={(event) =>
                setDraftGoal((current) => ({
                  ...current,
                  manualCurrentValue: event.target.value.trim() === "" ? null : Number(event.target.value)
                }))
              }
            />
          </label>
        </div>
        <label className="stacked-field">
          <span>Description</span>
          <PersistedTextarea
            key="new-goal-description"
            rows={3}
            debounceMs={0}
            savedValue={draftGoal.description}
            onPersist={(value) => setDraftGoal((current) => ({ ...current, description: value }))}
          />
        </label>
        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            onClick={async () => {
              await repository.saveAnnualGoal(draftGoal);
              setDraftGoal(createEmptyAnnualGoal({ dimension: "global" }));
              await load();
            }}
          >
            Ajouter l'objectif
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Objectifs actifs"
        subtitle="Chaque objectif affiche sa progression annuelle, sa trajectoire mensuelle et son evaluation du mois choisi."
      >
        <div className="goal-list">
          {goals.length === 0 ? (
            <p className="empty-copy">Aucun objectif annuel pour l'instant.</p>
          ) : (
            goals.map((goal) => (
              <AnnualGoalCard
                key={goal.id}
                goal={goal}
                snapshot={snapshotMap.get(goal.id)}
                evaluationMonthKey={evaluationMonthKey}
                onSaveGoal={saveGoal}
                onDeleteGoal={deleteGoal}
                onSaveEvaluation={saveEvaluation}
              />
            ))
          )}
        </div>
      </SectionCard>
    </div>
  );
};
