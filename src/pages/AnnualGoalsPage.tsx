import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { GoalPacingPanel } from "../components/GoalPacingPanel";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import {
  addAnnualGoalMilestone,
  annualGoalCadencePeriodOptions,
  annualGoalDimensions,
  annualGoalDirectionOptions,
  annualGoalMeasurementTypeOptions,
  annualGoalPrincipleOptions,
  annualGoalSourceOptions,
  annualGoalStatusOptions,
  annualGoalTrendOptions,
  createEmptyAnnualGoal,
  removeAnnualGoalMilestone,
  setAnnualGoalProgressLogEntry,
  updateAnnualGoalEvaluation,
  updateAnnualGoalMilestone,
} from "../domain/annual-goals";
import {
  buildMonthKeysForYear,
  buildWeekPeriodKeysForYear,
} from "../domain/annual-goal-measurement";
import { getMonthKey } from "../domain/monthly-review";
import type {
  AnnualGoal,
  AnnualGoalCadencePeriod,
  AnnualGoalDirection,
  AnnualGoalMeasurementType,
  AnnualGoalSnapshot,
  AnnualGoalStatus,
  GoalPacingResult,
  PrincipleKey,
} from "../domain/types";
import { resolveGoalPacingSnapshotInputs } from "../lib/ai/context/goal-pacing-snapshot";
import { loadLatestGoalPacing } from "../lib/ai/goal-pacing-loader";
import { GoalPacingService } from "../lib/ai/goal-pacing-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { getTodayDate } from "../lib/date";

const formatMaybeNumber = (value: number | null, unit: string, noneLabel: string): string =>
  value === null ? noneLabel : `${Math.round(value)} ${unit}`.trim();

const formatPercent = (value: number | null, noneLabel: string): string =>
  value === null ? noneLabel : `${Math.round(value * 100)}%`;

const AnnualGoalFields = ({
  goal,
  onChange,
}: {
  goal: AnnualGoal;
  onChange: (updater: (current: AnnualGoal) => AnnualGoal) => void;
}) => {
  const { t } = useTranslation("goals");
  const set = <K extends keyof AnnualGoal>(key: K, value: AnnualGoal[K]) =>
    onChange((current) => ({ ...current, [key]: value }));

  const showSourceFields =
    goal.measurementType === "numeric" || goal.measurementType === "cumulative";

  return (
    <div className="task-card__grid">
      <label className="stacked-field">
        <span>{t("card.fields.title")}</span>
        <input value={goal.title} onChange={(event) => set("title", event.target.value)} />
      </label>
      <label className="stacked-field">
        <span>{t("card.fields.dimension")}</span>
        <select
          value={goal.dimension}
          onChange={(event) => set("dimension", event.target.value as AnnualGoal["dimension"])}
        >
          {annualGoalDimensions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="stacked-field">
        <span>{t("card.fields.measurementType")}</span>
        <select
          value={goal.measurementType}
          onChange={(event) =>
            set("measurementType", event.target.value as AnnualGoalMeasurementType)
          }
        >
          {annualGoalMeasurementTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="stacked-field">
        <span>{t("card.fields.status")}</span>
        <select
          value={goal.status}
          onChange={(event) => set("status", event.target.value as AnnualGoalStatus)}
        >
          {annualGoalStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="stacked-field">
        <span>{t("card.fields.deadline")}</span>
        <input
          type="date"
          value={goal.deadline ?? ""}
          onChange={(event) => set("deadline", event.target.value || null)}
        />
      </label>

      {showSourceFields ? (
        <label className="stacked-field">
          <span>{t("card.fields.source")}</span>
          <select
            value={goal.sourceId ?? ""}
            onChange={(event) =>
              set(
                "sourceId",
                event.target.value ? (event.target.value as AnnualGoal["sourceId"]) : null,
              )
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
      ) : null}

      {goal.measurementType === "numeric" ? (
        <label className="stacked-field">
          <span>{t("card.fields.startingValue")}</span>
          <input
            type="number"
            value={goal.startingValue ?? ""}
            onChange={(event) =>
              set(
                "startingValue",
                event.target.value.trim() === "" ? null : Number(event.target.value),
              )
            }
          />
        </label>
      ) : null}

      {showSourceFields ? (
        <>
          <label className="stacked-field">
            <span>{t("card.fields.target")}</span>
            <input
              type="number"
              value={goal.targetValue ?? ""}
              onChange={(event) =>
                set(
                  "targetValue",
                  event.target.value.trim() === "" ? null : Number(event.target.value),
                )
              }
            />
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.unit")}</span>
            <input value={goal.unit} onChange={(event) => set("unit", event.target.value)} />
          </label>
        </>
      ) : null}

      {goal.measurementType === "numeric" ? (
        <>
          <label className="stacked-field">
            <span>{t("card.fields.direction")}</span>
            <select
              value={goal.direction ?? ""}
              onChange={(event) =>
                set(
                  "direction",
                  event.target.value ? (event.target.value as AnnualGoalDirection) : null,
                )
              }
            >
              <option value="">{t("card.fields.directionAuto")}</option>
              {annualGoalDirectionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.manualCurrent")}</span>
            <input
              type="number"
              value={goal.manualCurrentValue ?? ""}
              onChange={(event) =>
                set(
                  "manualCurrentValue",
                  event.target.value.trim() === "" ? null : Number(event.target.value),
                )
              }
            />
          </label>
        </>
      ) : null}

      {goal.measurementType === "recurring" ? (
        <>
          <label className="stacked-field">
            <span>{t("card.fields.cadenceTarget")}</span>
            <input
              type="number"
              value={goal.cadenceTarget ?? ""}
              onChange={(event) =>
                set(
                  "cadenceTarget",
                  event.target.value.trim() === "" ? null : Number(event.target.value),
                )
              }
            />
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.cadencePeriod")}</span>
            <select
              value={goal.cadencePeriod}
              onChange={(event) =>
                set("cadencePeriod", event.target.value as AnnualGoalCadencePeriod)
              }
            >
              {annualGoalCadencePeriodOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("card.fields.principle")}</span>
            <select
              value={goal.principleKey ?? ""}
              onChange={(event) =>
                set(
                  "principleKey",
                  event.target.value ? (event.target.value as PrincipleKey) : null,
                )
              }
            >
              <option value="">{t("card.principleNoneOption")}</option>
              {annualGoalPrincipleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
    </div>
  );
};

const AnnualGoalMeasurementReadout = ({
  goal,
  snapshot,
}: {
  goal: AnnualGoal;
  snapshot: AnnualGoalSnapshot | undefined;
}) => {
  const { t } = useTranslation("goals");
  if (!snapshot) {
    return null;
  }

  const { measurement } = snapshot;

  if (goal.measurementType === "binary") {
    return (
      <div className="weekly-overview-grid">
        <article className="status-card">
          <span>{t("card.metrics.current")}</span>
          <strong>
            {goal.status === "achieved"
              ? t("card.metrics.binaryAchieved")
              : t("card.metrics.binaryNotAchieved")}
          </strong>
        </article>
        <article className="status-card">
          <span>{t("milestones.title")}</span>
          <strong>
            {t("milestones.completedCount", {
              completed: measurement.milestonesCompleted,
              total: measurement.milestonesTotal,
            })}
          </strong>
        </article>
      </div>
    );
  }

  if (goal.measurementType === "cumulative") {
    return (
      <div className="weekly-overview-grid">
        <article className="status-card">
          <span>{t("card.metrics.progress")}</span>
          <strong>
            {t("card.metrics.cumulativeProgress", {
              current: snapshot.currentValue === null ? "—" : Math.round(snapshot.currentValue),
              target: goal.targetValue ?? "—",
              unit: goal.unit,
            })}
          </strong>
        </article>
      </div>
    );
  }

  if (goal.measurementType === "recurring") {
    return (
      <div className="weekly-overview-grid">
        <article className="status-card">
          <span>{t("card.fields.cadenceTarget")}</span>
          <strong>
            {t("card.metrics.recurringThisPeriod", {
              count: measurement.currentPeriodCount ?? 0,
              target: measurement.cadenceTarget ?? 0,
            })}
          </strong>
        </article>
        <article className="status-card">
          <span>{t("card.metrics.adherence")}</span>
          <strong>{formatPercent(measurement.adherenceRatio, t("format.none"))}</strong>
        </article>
        <article className="status-card">
          <span>{t("card.metrics.streak")}</span>
          <strong>{measurement.currentStreak}</strong>
        </article>
      </div>
    );
  }

  return (
    <div className="weekly-overview-grid">
      <article className="status-card">
        <span>{t("card.fields.startingValue")}</span>
        <strong>{formatMaybeNumber(goal.startingValue, goal.unit, t("format.none"))}</strong>
      </article>
      <article className="status-card">
        <span>{t("card.metrics.current")}</span>
        <strong>{formatMaybeNumber(snapshot.currentValue, goal.unit, t("format.none"))}</strong>
      </article>
      <article className="status-card">
        <span>{t("card.fields.target")}</span>
        <strong>{formatMaybeNumber(goal.targetValue, goal.unit, t("format.none"))}</strong>
      </article>
      <article className="status-card">
        <span>{t("card.metrics.progress")}</span>
        <strong>{formatPercent(snapshot.progressRatio, t("format.none"))}</strong>
      </article>
    </div>
  );
};

const CumulativeLogEditor = ({
  goal,
  year,
  snapshot,
  onLogChange,
}: {
  goal: AnnualGoal;
  year: number;
  snapshot: AnnualGoalSnapshot | undefined;
  onLogChange: (periodKey: string, value: number | null) => void;
}) => {
  const { t } = useTranslation("goals");
  const monthKeys = buildMonthKeysForYear(year);

  return (
    <div className="goal-card__progress">
      {monthKeys.map((monthKey) => {
        const runningPoint = snapshot?.monthlyProgress.find((point) => point.monthKey === monthKey);
        return (
          <article key={monthKey} className="goal-progress-pill">
            <span>{monthKey.slice(5)}</span>
            <input
              aria-label={`${t("log.increment")} ${monthKey}`}
              type="number"
              key={`${goal.id}-${goal.updatedAt}-${monthKey}`}
              defaultValue={goal.progressLog[monthKey] ?? ""}
              onBlur={(event) => {
                const raw = event.target.value.trim();
                onLogChange(monthKey, raw === "" ? null : Number(raw));
              }}
            />
            <small>
              {runningPoint?.value == null ? t("format.none") : Math.round(runningPoint.value)}
            </small>
          </article>
        );
      })}
    </div>
  );
};

const RecurringLogEditor = ({
  goal,
  year,
  snapshot,
  onLogChange,
}: {
  goal: AnnualGoal;
  year: number;
  snapshot: AnnualGoalSnapshot | undefined;
  onLogChange: (periodKey: string, value: number | null) => void;
}) => {
  const { t } = useTranslation("goals");
  const currentPeriodKey = snapshot?.measurement.currentPeriodKey ?? null;
  const periodKeys =
    goal.cadencePeriod === "month" ? buildMonthKeysForYear(year) : buildWeekPeriodKeysForYear(year);
  const currentIndex = currentPeriodKey ? periodKeys.indexOf(currentPeriodKey) : -1;
  const endIndex = currentIndex >= 0 ? currentIndex : periodKeys.length - 1;
  const startIndex = Math.max(0, endIndex - 7);
  const visiblePeriodKeys = periodKeys.slice(startIndex, endIndex + 1);

  return (
    <div className="goal-card__progress">
      {visiblePeriodKeys.map((periodKey) => {
        const isCurrent = periodKey === currentPeriodKey;
        return (
          <article
            key={periodKey}
            className={`goal-progress-pill${isCurrent ? " goal-progress-pill--active" : ""}`}
          >
            <span>{periodKey.slice(5)}</span>
            <input
              aria-label={`${t("log.periodCount")} ${periodKey}`}
              type="number"
              key={`${goal.id}-${goal.updatedAt}-${periodKey}`}
              defaultValue={goal.progressLog[periodKey] ?? ""}
              onBlur={(event) => {
                const raw = event.target.value.trim();
                onLogChange(periodKey, raw === "" ? null : Number(raw));
              }}
            />
            {isCurrent ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => onLogChange(periodKey, (goal.progressLog[periodKey] ?? 0) + 1)}
              >
                {t("log.addOne")}
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
};

const AnnualGoalMilestonesEditor = ({
  goal,
  onAdd,
  onToggle,
  onRemove,
}: {
  goal: AnnualGoal;
  onAdd: (title: string) => void;
  onToggle: (milestoneId: string, completed: boolean) => void;
  onRemove: (milestoneId: string) => void;
}) => {
  const { t } = useTranslation("goals");
  const [titleDraft, setTitleDraft] = useState("");

  return (
    <div className="goal-card__milestones">
      <div className="goal-card__header">
        <strong>{t("milestones.title")}</strong>
        <span>
          {t("milestones.completedCount", {
            completed: goal.milestones.filter((milestone) => milestone.completedAt !== null).length,
            total: goal.milestones.length,
          })}
        </span>
      </div>
      {goal.milestones.length === 0 ? (
        <p className="empty-copy">{t("milestones.empty")}</p>
      ) : (
        <ul className="checklist">
          {goal.milestones.map((milestone) => (
            <li key={milestone.id}>
              <label>
                <input
                  type="checkbox"
                  checked={milestone.completedAt !== null}
                  onChange={(event) => onToggle(milestone.id, event.target.checked)}
                />
                {milestone.title}
              </label>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => onRemove(milestone.id)}
              >
                {t("milestones.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <input
          value={titleDraft}
          placeholder={t("milestones.addPlaceholder")}
          onChange={(event) => setTitleDraft(event.target.value)}
        />
        <button
          type="button"
          className="button"
          onClick={() => {
            const title = titleDraft.trim();
            if (title) {
              onAdd(title);
              setTitleDraft("");
            }
          }}
        >
          {t("milestones.add")}
        </button>
      </div>
    </div>
  );
};

const AnnualGoalCard = ({
  goal,
  snapshot,
  year,
  evaluationMonthKey,
  onSaveGoal,
  onDeleteGoal,
  onSaveEvaluation,
}: {
  goal: AnnualGoal;
  snapshot: AnnualGoalSnapshot | undefined;
  year: number;
  evaluationMonthKey: string;
  onSaveGoal: (goal: AnnualGoal) => Promise<void>;
  onDeleteGoal: (goalId: string) => Promise<void>;
  onSaveEvaluation: (
    goal: AnnualGoal,
    monthKey: string,
    changes: Partial<AnnualGoal["evaluations"][string]>,
  ) => Promise<void>;
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
    blockers: "",
  };
  const [scoreDraft, setScoreDraft] = useState(
    evaluation.score === null ? "" : String(evaluation.score),
  );

  useEffect(() => {
    setScoreDraft(evaluation.score === null ? "" : String(evaluation.score));
  }, [evaluation.score]);

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
          <button
            className="button button--ghost"
            type="button"
            onClick={() => void onDeleteGoal(goal.id)}
          >
            {t("card.delete")}
          </button>
        </div>
      </div>

      <AnnualGoalFields goal={draft} onChange={setDraft} />

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

      <AnnualGoalMeasurementReadout goal={goal} snapshot={snapshot} />

      <div className="goal-card__tags">
        {snapshot?.linkedWeeklyMetricLabels.map((label) => (
          <span key={`weekly-${label}`} className="tag-chip">
            {label}
          </span>
        ))}
        {snapshot?.linkedDailyHabitLabels.map((label) => (
          <span key={`daily-${label}`} className="tag-chip">
            {label}
          </span>
        ))}
      </div>

      {goal.measurementType === "numeric" ? (
        <div className="goal-card__progress">
          {(snapshot?.monthlyProgress ?? []).map((point) => (
            <article
              key={point.monthKey}
              className={`goal-progress-pill${point.monthKey === evaluationMonthKey ? " goal-progress-pill--active" : ""}`}
            >
              <span>{point.monthKey.slice(5)}</span>
              <strong>{point.value === null ? t("format.none") : Math.round(point.value)}</strong>
            </article>
          ))}
        </div>
      ) : null}

      {goal.measurementType === "cumulative" ? (
        <CumulativeLogEditor
          goal={goal}
          year={year}
          snapshot={snapshot}
          onLogChange={(periodKey, value) =>
            void onSaveGoal(setAnnualGoalProgressLogEntry(goal, periodKey, value))
          }
        />
      ) : null}

      {goal.measurementType === "recurring" ? (
        <RecurringLogEditor
          goal={goal}
          year={year}
          snapshot={snapshot}
          onLogChange={(periodKey, value) =>
            void onSaveGoal(setAnnualGoalProgressLogEntry(goal, periodKey, value))
          }
        />
      ) : null}

      <AnnualGoalMilestonesEditor
        goal={goal}
        onAdd={(title) => void onSaveGoal(addAnnualGoalMilestone(goal, title))}
        onToggle={(milestoneId, completed) =>
          void onSaveGoal(
            updateAnnualGoalMilestone(goal, milestoneId, {
              completedAt: completed ? getTodayDate() : null,
            }),
          )
        }
        onRemove={(milestoneId) => void onSaveGoal(removeAnnualGoalMilestone(goal, milestoneId))}
      />

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
                  score: scoreDraft.trim() === "" ? null : Number(scoreDraft),
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
                  trend: event.target.value
                    ? (event.target.value as NonNullable<typeof evaluation.trend>)
                    : null,
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
            savedValue={evaluation.notes}
            onPersist={(value) => void onSaveEvaluation(goal, evaluationMonthKey, { notes: value })}
          />
        </label>
        <label className="stacked-field">
          <span>{t("card.blockers")}</span>
          <PersistedTextarea
            key={`${goal.id}-${evaluationMonthKey}-blockers`}
            rows={3}
            savedValue={evaluation.blockers}
            onPersist={(value) =>
              void onSaveEvaluation(goal, evaluationMonthKey, { blockers: value })
            }
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
  const [showAllStatuses, setShowAllStatuses] = useState(false);
  const [pacingResult, setPacingResult] = useState<GoalPacingResult | null>(null);
  const [pacingLoading, setPacingLoading] = useState(false);
  const pacingRequestSeqRef = useRef(0);
  const hasValidSelectedYear = useMemo(
    () => Number.isInteger(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100,
    [selectedYear],
  );
  const hasValidEvaluationMonth = useMemo(
    () => /^\d{4}-\d{2}$/.test(evaluationMonthKey),
    [evaluationMonthKey],
  );
  const [draftGoal, setDraftGoal] = useState<AnnualGoal>(
    createEmptyAnnualGoal({
      dimension: "global",
    }),
  );

  const hasLoadedOnceRef = useRef(false);

  const load = useCallback(async () => {
    if (!hasLoadedOnceRef.current) {
      setLoading(true);
    }
    const [nextGoals, nextSnapshots] = await Promise.all([
      repository.listAnnualGoals(),
      repository.computeAnnualGoalSnapshots(selectedYear),
    ]);
    setGoals(nextGoals);
    setSnapshots(nextSnapshots);
    hasLoadedOnceRef.current = true;
    setLoading(false);
  }, [repository, selectedYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPacing = useCallback(
    async (options: { year: number; trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      const requestId = ++pacingRequestSeqRef.current;
      setPacingLoading(true);
      if (options.trigger !== "auto") {
        setPacingResult(null);
      }
      try {
        const snapshotInputs = await resolveGoalPacingSnapshotInputs(repository, options.year, {
          asOfDate: getTodayDate(),
          evaluationMonthKey,
        });
        const result = await pacingService.buildPacing(repository, {
          year: options.year,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache,
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
    [evaluationMonthKey, pacingService, repository, settings],
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
    hasValidEvaluationMonth,
    hasValidSelectedYear,
    loading,
    pacingService,
    repository,
    runPacing,
    selectedYear,
  ]);

  const snapshotMap = useMemo(
    () => new Map(snapshots.map((snapshot) => [snapshot.goal.id, snapshot])),
    [snapshots],
  );

  const goalTitlesById = useMemo(
    () => new Map(goals.map((goal) => [goal.id, goal.title])),
    [goals],
  );

  const visibleGoals = useMemo(
    () => (showAllStatuses ? goals : goals.filter((goal) => goal.status === "active")),
    [goals, showAllStatuses],
  );

  const saveGoal = useCallback(
    async (goal: AnnualGoal) => {
      await repository.saveAnnualGoal(goal);
      await load();
    },
    [load, repository],
  );

  const deleteGoal = useCallback(
    async (goalId: string) => {
      await repository.deleteAnnualGoal(goalId);
      await load();
    },
    [load, repository],
  );

  const saveEvaluation = useCallback(
    async (
      goal: AnnualGoal,
      monthKey: string,
      changes: Partial<AnnualGoal["evaluations"][string]>,
    ) => {
      await repository.saveAnnualGoal(updateAnnualGoalEvaluation(goal, monthKey, changes));
      await load();
    },
    [load, repository],
  );

  if (loading) {
    return (
      <div className="page">
        <p>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">{t("hero.copy")}</p>
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
          result={pacingResult?.message.scopeKey === String(selectedYear) ? pacingResult : null}
          loading={pacingLoading}
          settings={settings}
          goalTitlesById={goalTitlesById}
          onRequestCoach={() => void runPacing({ year: selectedYear, trigger: "explicit" })}
          onRegenerate={() =>
            void runPacing({ year: selectedYear, trigger: "explicit", bypassCache: true })
          }
        />
      </SectionCard>

      <SectionCard title={t("create.title")} subtitle={t("create.subtitle")}>
        <AnnualGoalFields goal={draftGoal} onChange={setDraftGoal} />
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

      <SectionCard title={t("list.title")} subtitle={t("list.subtitle")}>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={showAllStatuses}
            onChange={(event) => setShowAllStatuses(event.target.checked)}
          />
          {t("list.showAll")}
        </label>
        <div className="goal-list">
          {visibleGoals.length === 0 ? (
            <p className="empty-copy">{t("list.empty")}</p>
          ) : (
            visibleGoals.map((goal) => (
              <AnnualGoalCard
                key={goal.id}
                goal={goal}
                snapshot={snapshotMap.get(goal.id)}
                year={selectedYear}
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
