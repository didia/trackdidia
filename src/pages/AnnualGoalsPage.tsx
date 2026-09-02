import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  annualGoalDimensions,
  annualGoalSourceOptions,
  annualGoalTrendOptions,
  createEmptyAnnualGoal,
  updateAnnualGoalEvaluation
} from "../domain/annual-goals";
import type { AnnualGoal, AnnualGoalSnapshot, GoalPacingResult } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { GoalPacingPanel } from "../components/GoalPacingPanel";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { getMonthKey } from "../domain/monthly-review";
import { getTodayDate } from "../lib/date";
import { resolveGoalPacingSnapshotInputs } from "../lib/ai/context/goal-pacing-snapshot";
import { loadLatestGoalPacing } from "../lib/ai/goal-pacing-loader";
import { GoalPacingService } from "../lib/ai/goal-pacing-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";

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
  const { t } = useTranslation("goals");
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

  const formatMaybeNumber = (value: number | null, unit: string): string =>
    value === null ? t("format.none") : `${Math.round(value)} ${unit}`.trim();

  return (
    <article className="goal-card">
      <div className="goal-card__header">
        <div>
          <strong>{goal.title || t("card.untitled")}</strong>
          <p className="empty-copy">{snapshot?.sourceLabel ?? t("card.sourceManualFallback")}</p>
        </div>
        <div className="task-card__quick-actions">
          <button className="button" type="button" onClick={() => void onSaveGoal(draft)}>
            {t("card.save")}
          </button>
          <button className="button button--ghost" type="button" onClick={() => void onDeleteGoal(goal.id)}>
            {t("card.delete")}
          </button>
        </div>
      </div>

      <div className="task-card__grid">
        <label className="stacked-field">
          <span>{t("card.fields.title")}</span>
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label className="stacked-field">
          <span>{t("card.fields.dimension")}</span>
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
          <span>{t("card.fields.source")}</span>
          <select
            value={draft.sourceId ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceId: event.target.value ? (event.target.value as AnnualGoal["sourceId"]) : null
              }))
            }
          >
            <option value="">{t("card.sourceManualOption")}</option>
            {annualGoalSourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stacked-field">
          <span>{t("card.fields.target")}</span>
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
          <span>{t("card.fields.unit")}</span>
          <input value={draft.unit} onChange={(event) => setDraft((current) => ({ ...current, unit: event.target.value }))} />
        </label>
        <label className="stacked-field">
          <span>{t("card.fields.manualCurrent")}</span>
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
        <span>{t("card.fields.description")}</span>
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
          <span>{t("card.metrics.current")}</span>
          <strong>{formatMaybeNumber(snapshot?.currentValue ?? null, draft.unit)}</strong>
        </article>
        <article className="status-card">
          <span>{t("card.metrics.progress")}</span>
          <strong>{snapshot?.progressRatio === null || snapshot?.progressRatio === undefined ? t("format.none") : `${Math.round(snapshot.progressRatio * 100)}%`}</strong>
        </article>
        <article className="status-card">
          <span>{t("card.metrics.source")}</span>
          <strong>{snapshot?.sourceLabel ?? t("card.sourceLabelManual")}</strong>
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
            <strong>{point.value === null ? t("format.none") : Math.round(point.value)}</strong>
          </article>
        ))}
      </div>

      <div className="goal-card__evaluation">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("card.scoreLabel", { monthKey: evaluationMonthKey })}</span>
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
            <span>{t("card.trend")}</span>
            <select
              value={evaluation.trend ?? ""}
              onChange={(event) =>
                void onSaveEvaluation(goal, evaluationMonthKey, {
                  trend: event.target.value ? (event.target.value as NonNullable<typeof evaluation.trend>) : null
                })
              }
            >
              <option value="">{t("card.trendNone")}</option>
              {annualGoalTrendOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="stacked-field">
          <span>{t("card.notes")}</span>
          <PersistedTextarea
            key={`${goal.id}-${evaluationMonthKey}-notes`}
            rows={3}
            debounceMs={0}
            savedValue={evaluation.notes}
            onPersist={(value) => void onSaveEvaluation(goal, evaluationMonthKey, { notes: value })}
          />
        </label>
        <label className="stacked-field">
          <span>{t("card.blockers")}</span>
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
  const { t } = useTranslation("goals");
  const { repository, settings } = useAppContext();
  const pacingService = useMemo(() => new GoalPacingService(new OpenRouterProvider()), []);
  const currentYear = Number(getTodayDate().slice(0, 4));
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [evaluationMonthKey, setEvaluationMonthKey] = useState(getMonthKey(getTodayDate()));
  const [goals, setGoals] = useState<AnnualGoal[]>([]);
  const [snapshots, setSnapshots] = useState<AnnualGoalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [pacingResult, setPacingResult] = useState<GoalPacingResult | null>(null);
  const [pacingLoading, setPacingLoading] = useState(false);
  const pacingRequestSeqRef = useRef(0);
  const hasValidSelectedYear = useMemo(
    () => Number.isInteger(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100,
    [selectedYear]
  );
  const hasValidEvaluationMonth = useMemo(
    () => /^\d{4}-\d{2}$/.test(evaluationMonthKey),
    [evaluationMonthKey]
  );
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

  const runPacing = useCallback(
    async (options: { year: number; trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      const requestId = ++pacingRequestSeqRef.current;
      setPacingLoading(true);
      try {
        const snapshotInputs = await resolveGoalPacingSnapshotInputs(repository, options.year, {
          asOfDate: getTodayDate(),
          evaluationMonthKey
        });
        const result = await pacingService.buildPacing(repository, {
          year: options.year,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache
        });
        if (requestId !== pacingRequestSeqRef.current) {
          return;
        }
        setPacingResult(result);
      } finally {
        if (requestId === pacingRequestSeqRef.current) {
          setPacingLoading(false);
        }
      }
    },
    [evaluationMonthKey, pacingService, repository, settings]
  );

  useEffect(() => {
    setPacingResult(null);
  }, [selectedYear]);

  useEffect(() => {
    if (loading || !hasValidSelectedYear || !hasValidEvaluationMonth) {
      return;
    }

    void (async () => {
      const stored = await loadLatestGoalPacing(repository, pacingService, selectedYear);
      if (stored && stored.message.scopeKey === String(selectedYear)) {
        setPacingResult(stored);
      }
      await runPacing({ year: selectedYear, trigger: "auto" });
    })();
  }, [
    evaluationMonthKey,
    hasValidEvaluationMonth,
    hasValidSelectedYear,
    loading,
    pacingService,
    repository,
    runPacing,
    selectedYear
  ]);

  const snapshotMap = useMemo(
    () => new Map(snapshots.map((snapshot) => [snapshot.goal.id, snapshot])),
    [snapshots]
  );

  const goalTitlesById = useMemo(() => new Map(goals.map((goal) => [goal.id, goal.title])), [goals]);

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
    return <div className="page"><p>{t("loading")}</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">
            {t("hero.copy")}
          </p>
        </div>
      </header>

      <SectionCard title={t("pilot.title")} subtitle={t("pilot.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("pilot.year")}</span>
            <input
              type="number"
              value={selectedYear}
              onChange={(event) => setSelectedYear(Number(event.target.value || currentYear))}
            />
          </label>
          <label className="stacked-field">
            <span>{t("pilot.month")}</span>
            <input
              type="month"
              value={evaluationMonthKey}
              onChange={(event) => setEvaluationMonthKey(event.target.value)}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title={t("pacing.title")} subtitle={t("pacing.subtitle")}>
        <GoalPacingPanel
          result={
            pacingResult?.message.scopeKey === String(selectedYear) ? pacingResult : null
          }
          loading={pacingLoading}
          settings={settings}
          goalTitlesById={goalTitlesById}
          onRequestCoach={() => void runPacing({ year: selectedYear, trigger: "explicit" })}
          onRegenerate={() => void runPacing({ year: selectedYear, trigger: "explicit", bypassCache: true })}
        />
      </SectionCard>

      <SectionCard title={t("create.title")} subtitle={t("create.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("card.fields.title")}</span>
            <input value={draftGoal.title} onChange={(event) => setDraftGoal((current) => ({ ...current, title: event.target.value }))} />
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.dimension")}</span>
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
            <span>{t("card.fields.source")}</span>
            <select
              value={draftGoal.sourceId ?? ""}
              onChange={(event) =>
                setDraftGoal((current) => ({
                  ...current,
                  sourceId: event.target.value ? (event.target.value as AnnualGoal["sourceId"]) : null
                }))
              }
            >
              <option value="">{t("card.sourceManualOption")}</option>
              {annualGoalSourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.target")}</span>
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
            <span>{t("card.fields.unit")}</span>
            <input value={draftGoal.unit} onChange={(event) => setDraftGoal((current) => ({ ...current, unit: event.target.value }))} />
          </label>
          <label className="stacked-field">
            <span>{t("create.manualCurrent")}</span>
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
          <span>{t("card.fields.description")}</span>
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
            {t("create.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title={t("list.title")}
        subtitle={t("list.subtitle")}
      >
        <div className="goal-list">
          {goals.length === 0 ? (
            <p className="empty-copy">{t("list.empty")}</p>
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
