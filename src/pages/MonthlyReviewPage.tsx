import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { resolveInitialMonthlyReviewMonth } from "../app/reviews/review-query-params";
import { buildRitualSections, type RitualSectionMeta } from "../app/reviews/ritual-sections";
import {
  type ReviewSynthesisContext,
  useReviewSynthesis,
} from "../app/reviews/use-review-synthesis";
import { useLatestRequest } from "../app/use-latest-request";
import { useLatestValueSaver } from "../app/use-latest-value-saver";
import { useProposalAcceptance } from "../app/use-proposal-acceptance";
import {
  applyMonthlyReviewTransition,
  createEmptyMonthlyReview,
  getMonthEndDate,
  getMonthStartDate,
  updateMonthlyReviewChecklist,
  updateMonthlyReviewNote,
} from "../domain/monthly-review";
import type {
  AiProposal,
  AnnualGoalSnapshot,
  MonthlyReview,
  MonthlyReviewSectionKey,
  MonthlyReviewSummary,
  MonthlySynthesisResult,
} from "../domain/types";
import { MonthlySynthesisPanel } from "../components/MonthlySynthesisPanel";
import type { PersistedTextareaHandle } from "../components/PersistedTextarea";
import { RitualSectionList } from "../components/RitualSectionList";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, getTodayDate } from "../lib/date";
import { formatPercent } from "../lib/format";
import { formatTimestamp } from "../lib/format";
import { resolveMonthlySnapshotInputs } from "../lib/ai/context/monthly-snapshot";
import { loadLatestMonthlySynthesis } from "../lib/ai/monthly-synthesis-loader";
import { MonthlySynthesisService } from "../lib/ai/monthly-synthesis-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { applyCoachProposal } from "../lib/ai/proposals/apply-proposal";

interface MonthlySynthesisRunOptions {
  monthKey: string;
  trigger: "auto" | "explicit";
  bypassCache?: boolean;
}

const monthlySectionMeta: ReadonlyArray<RitualSectionMeta<MonthlyReviewSectionKey>> = [
  { key: "bilan" },
  { key: "journaux", linkTo: "/semaine", linkKey: "monthly.ritual.journaux.link" },
  { key: "finances" },
  { key: "temps" },
  {
    key: "progressionObjectifs",
    linkTo: "/objectifs-annuels",
    linkKey: "monthly.ritual.progressionObjectifs.link",
  },
  { key: "missionObjectifs" },
  { key: "nettoyageListes", linkTo: "/projects", linkKey: "monthly.ritual.nettoyageListes.link" },
  { key: "calendrier", linkTo: "/scheduled", linkKey: "monthly.ritual.calendrier.link" },
  { key: "grosProjets", linkTo: "/next-actions", linkKey: "monthly.ritual.grosProjets.link" },
  { key: "developpement" },
];

export const MonthlyReviewPage = () => {
  const proposalAcceptance = useProposalAcceptance();
  const { t } = useTranslation("reviews");
  const { repository, settings } = useAppContext();
  const synthesisService = useMemo(() => new MonthlySynthesisService(new OpenRouterProvider()), []);
  const today = getTodayDate();
  const [searchParams] = useSearchParams();
  const initialMonth = resolveInitialMonthlyReviewMonth(searchParams.get("month"), today);
  const [selectedMonthKey, setSelectedMonthKey] = useState(initialMonth);
  const [review, setReview] = useState<MonthlyReview | null>(null);
  const [summary, setSummary] = useState<MonthlyReviewSummary | null>(null);
  const [goalSnapshots, setGoalSnapshots] = useState<AnnualGoalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [synthesisNotice, setSynthesisNotice] = useState<string | null>(null);
  const latestReviewRef = useRef<MonthlyReview | null>(null);
  const persistReview = useCallback(
    async (value: MonthlyReview) => {
      await repository.saveMonthlyReview(value);
    },
    [repository],
  );
  const reviewSaver = useLatestValueSaver<string, MonthlyReview>(persistReview);
  const noteRefs = useRef<Partial<Record<MonthlyReviewSectionKey, PersistedTextareaHandle | null>>>(
    {},
  );
  const monthRequest = useLatestRequest();

  const runSynthesisRequest = useCallback(
    async (
      options: MonthlySynthesisRunOptions,
      { signal, setResult }: ReviewSynthesisContext<MonthlySynthesisResult>,
    ) => {
      if (options.trigger === "auto") {
        const stored = await loadLatestMonthlySynthesis(
          repository,
          synthesisService,
          options.monthKey,
        );
        if (!signal.isLatest()) {
          return;
        }
        if (stored) {
          setResult(stored);
        }
      }

      const snapshotInputs = await resolveMonthlySnapshotInputs(repository, options.monthKey);

      if (!signal.isLatest()) {
        return;
      }

      const result = await synthesisService.buildSynthesis(repository, {
        monthKey: options.monthKey,
        settings,
        snapshotInputs,
        trigger: options.trigger,
        bypassCache: options.bypassCache,
      });

      if (!signal.isLatest()) {
        return;
      }

      setResult(result);
    },
    [repository, settings, synthesisService],
  );
  const {
    visibleResult: synthesisResult,
    loading: synthesisLoading,
    run: runSynthesis,
    clear: clearSynthesis,
    invalidate: invalidateSynthesis,
    replaceProposal: replaceSynthesisProposal,
    markProposalDismissed: markSynthesisProposalDismissed,
  } = useReviewSynthesis<MonthlySynthesisResult, MonthlySynthesisRunOptions>(
    summary?.monthKey ?? null,
    runSynthesisRequest,
  );

  const loadMonth = useCallback(
    async (requestedMonthKey: string) => {
      if (!/^\d{4}-\d{2}$/.test(requestedMonthKey)) {
        return;
      }

      invalidateSynthesis();
      clearSynthesis();
      setLoading(true);
      await monthRequest.run(async (signal) => {
        try {
          await reviewSaver.settled(requestedMonthKey).catch((error: unknown) => {
            // A rejected write leaves a dirty snapshot that the load must keep editable.
            if (!reviewSaver.isDirty(requestedMonthKey)) throw error;
          });
          if (!signal.isLatest()) return;
          const loadVersion = reviewSaver.version(requestedMonthKey);
          const [existingReview, computedSummary, annualSnapshots] = await Promise.all([
            repository.getMonthlyReview(requestedMonthKey),
            repository.computeMonthlyReviewSummary(requestedMonthKey),
            repository.computeAnnualGoalSnapshots(Number(requestedMonthKey.slice(0, 4))),
          ]);
          if (!signal.isLatest()) {
            return;
          }
          const keepLocal =
            reviewSaver.version(requestedMonthKey) !== loadVersion ||
            reviewSaver.isDirty(requestedMonthKey);
          const nextReview =
            (keepLocal ? reviewSaver.get(requestedMonthKey) : undefined) ??
            existingReview ??
            createEmptyMonthlyReview(requestedMonthKey);
          if (!keepLocal) reviewSaver.hydrate(requestedMonthKey, nextReview);
          latestReviewRef.current = nextReview;
          setSelectedMonthKey(requestedMonthKey);
          setReview(nextReview);
          setSummary(computedSummary);
          setGoalSnapshots(annualSnapshots);
        } finally {
          if (signal.isLatest()) setLoading(false);
        }
      });
    },
    [clearSynthesis, invalidateSynthesis, monthRequest, repository, reviewSaver],
  );

  useEffect(() => {
    void loadMonth(selectedMonthKey);
  }, [loadMonth]);

  useEffect(() => {
    if (!summary || loading) {
      return;
    }

    void runSynthesis({ monthKey: summary.monthKey, trigger: "auto" });
  }, [summary?.monthKey, loading, runSynthesis]);

  const handleAcceptSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || !synthesisResult) return;
    if (!proposalAcceptance.begin(proposal.id)) return;
    try {
      const monthKey = summary.monthKey;
      const applied = await applyCoachProposal(repository, proposal, {
        acceptedDate: monthKey,
        monthly: {
          monthKey,
          withReview: async (sectionKey, work) => {
            const current = latestReviewRef.current ?? review ?? createEmptyMonthlyReview(monthKey);
            if (!reviewSaver.get(monthKey)) reviewSaver.hydrate(monthKey, current);
            return reviewSaver.run(monthKey, async (snapshot) => {
              const beforeVersion = reviewSaver.version(monthKey);
              const outcome = await work(snapshot);
              if (!outcome.monthlyReview) return outcome;
              const latest = reviewSaver.get(monthKey) ?? snapshot;
              const unchanged = reviewSaver.version(monthKey) === beforeVersion;
              const next =
                latest.notes[sectionKey] === snapshot.notes[sectionKey]
                  ? updateMonthlyReviewNote(
                      latest,
                      sectionKey,
                      outcome.monthlyReview.notes[sectionKey],
                    )
                  : latest;
              reviewSaver.remember(monthKey, next);
              if (unchanged) reviewSaver.markSaved(monthKey, reviewSaver.version(monthKey));
              if (latestReviewRef.current?.monthKey === monthKey) {
                latestReviewRef.current = next;
                setReview(next);
                noteRefs.current[sectionKey]?.setDraft(next.notes[sectionKey]);
              }
              return { ...outcome, text: next.notes[sectionKey], monthlyReview: next };
            });
          },
        },
      });
      if (!applied.proposal) return;
      if (applied.goalMissing) setSynthesisNotice(t("monthly.synthesis.goalMissing"));
      if (applied.goalId)
        setGoalSnapshots(await repository.computeAnnualGoalSnapshots(Number(monthKey.slice(0, 4))));
      replaceSynthesisProposal(applied.proposal);
    } finally {
      proposalAcceptance.end(proposal.id);
    }
  };

  const handleDismissSynthesisProposal = async (proposal: AiProposal) => {
    if (proposalAcceptance.isApplying(proposal.id)) return;
    await repository.decideAiProposal(proposal.id, "dismissed");
    markSynthesisProposalDismissed(proposal.id);
  };

  const saveReview = useCallback(
    (nextReview: MonthlyReview) => {
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      return reviewSaver.set(nextReview.monthKey, nextReview);
    },
    [reviewSaver],
  );

  const selectedGoalSnapshots = useMemo(
    () =>
      goalSnapshots.filter((snapshot) =>
        snapshot.monthlyProgress.some((point) => point.monthKey === selectedMonthKey),
      ),
    [goalSnapshots, selectedMonthKey],
  );

  const monthlySections = useMemo(
    () =>
      buildRitualSections(monthlySectionMeta, (key) => String(t(key as never)), "monthly.ritual"),
    [t],
  );

  if (loading || !review || !summary) {
    return (
      <div className="page">
        <p>{t("monthly.loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t("monthly.hero.eyebrow")}
        title={t("monthly.hero.range", {
          start: formatDateLong(summary.monthStartDate),
          end: formatDateLong(summary.monthEndDate),
        })}
        copy={t("monthly.hero.copy")}
      />

      <SectionCard title={t("monthly.picker.title")} subtitle={t("monthly.picker.subtitle")}>
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>{t("monthly.picker.monthLabel")}</span>
            <input
              aria-label={t("monthly.picker.monthLabel")}
              type="month"
              value={selectedMonthKey}
              onChange={(event) => setSelectedMonthKey(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              className="button"
              type="button"
              onClick={() => void loadMonth(selectedMonthKey)}
            >
              {t("monthly.picker.load")}
            </button>
            <button className="button" type="button" onClick={() => void loadMonth(initialMonth)}>
              {t("monthly.picker.current")}
            </button>
          </div>
        </div>
        <p className="empty-copy">
          {t("monthly.picker.window", {
            start: getMonthStartDate(selectedMonthKey),
            end: getMonthEndDate(selectedMonthKey),
          })}
        </p>
      </SectionCard>

      <SectionCard title={t("monthly.summary.title")} subtitle={t("monthly.summary.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("monthly.summary.status")}</span>
            <strong>
              {review.status === "closed" ? t("monthly.status.closed") : t("monthly.status.draft")}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.daysTracked")}</span>
            <strong>{summary.daysTracked}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.weeksCovered")}</span>
            <strong>{summary.weeksCovered}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.weeklyReviewsClosed")}</span>
            <strong>{summary.weeklyReviewsCompleted}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.sleepAverage")}</span>
            <strong>{Math.round(summary.sleepAverage)} / 100</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.trc")}</span>
            <strong>{Math.round(summary.trcRate)}%</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.screenTime")}</span>
            <strong>{summary.screenTimeTotalMinutes} min</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.pomodoris")}</span>
            <strong>{summary.pomodorisTotal}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.disciplineAverage")}</span>
            <strong>{Math.round(summary.disciplineAverage * 100)}%</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.tasksCompletion")}</span>
            <strong>{Math.round(summary.tasksCompletionRate)}%</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.summary.weeklyScoreAverage")}</span>
            <strong>{formatPercent(summary.weeklyScoreAverage)}</strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard title={t("monthly.coach.title")} subtitle={t("monthly.coach.subtitle")}>
        <MonthlySynthesisPanel
          result={synthesisResult}
          loading={synthesisLoading}
          notice={synthesisNotice}
          settings={settings}
          onRequestCoach={() => {
            if (!summary) {
              return;
            }
            void runSynthesis({ monthKey: summary.monthKey, trigger: "explicit" });
          }}
          onRegenerate={() => {
            if (!summary) {
              return;
            }
            void runSynthesis({
              monthKey: summary.monthKey,
              trigger: "explicit",
              bypassCache: true,
            });
          }}
          applyingProposalIds={proposalAcceptance.applyingProposalIds}
          onAcceptProposal={(proposal) => void handleAcceptSynthesisProposal(proposal)}
          onDismissProposal={(proposal) => void handleDismissSynthesisProposal(proposal)}
        />
      </SectionCard>

      <SectionCard title={t("monthly.weeks.title")} subtitle={t("monthly.weeks.subtitle")}>
        <div className="weekly-day-grid">
          {summary.weeks.map((week) => (
            <article key={week.weekStartDate} className="schedule-day-group">
              <div className="schedule-day-group__header">
                <h3>{week.weekStartDate}</h3>
                <span>
                  {week.reviewStatus === "missing"
                    ? t("monthly.weeks.status.missing")
                    : week.reviewStatus === "closed"
                      ? t("monthly.weeks.status.closed")
                      : t("monthly.weeks.status.draft")}
                </span>
              </div>
              <div className="weekly-day-card__metrics">
                <span>{t("monthly.weeks.metrics.end", { date: week.weekEndDate })}</span>
                <span>
                  {t("monthly.weeks.metrics.score", { n: formatPercent(week.weeklyScore) })}
                </span>
                <span>{t("monthly.weeks.metrics.notes", { n: week.noteCount })}</span>
              </div>
            </article>
          ))}
        </div>
        <div className="section-actions">
          <Link className="button" to="/semaine">
            {t("monthly.weeks.openWeekly")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("monthly.goals.title")} subtitle={t("monthly.goals.subtitle")}>
        <div className="weekly-day-grid">
          {selectedGoalSnapshots.length === 0 ? (
            <p className="empty-copy">{t("monthly.goals.empty")}</p>
          ) : (
            selectedGoalSnapshots.map((snapshot) => {
              const monthPoint =
                snapshot.monthlyProgress.find((point) => point.monthKey === selectedMonthKey) ??
                null;
              const evaluation = snapshot.goal.evaluations[selectedMonthKey] ?? null;
              const { measurement } = snapshot;
              return (
                <article key={snapshot.goal.id} className="schedule-day-group">
                  <div className="schedule-day-group__header">
                    <h3>{snapshot.goal.title}</h3>
                    <span>{snapshot.goal.dimension}</span>
                  </div>
                  <div className="weekly-day-card__metrics">
                    {snapshot.goal.measurementType === "binary" ? (
                      <>
                        <span>
                          {t("monthly.goals.metrics.binaryStatus")}{" "}
                          {snapshot.goal.status === "achieved"
                            ? t("monthly.goals.metrics.binaryAchieved")
                            : t("monthly.goals.metrics.binaryNotAchieved")}
                        </span>
                        <span>
                          {t("monthly.goals.metrics.milestones")} {measurement.milestonesCompleted}/
                          {measurement.milestonesTotal}
                        </span>
                      </>
                    ) : snapshot.goal.measurementType === "recurring" ? (
                      <>
                        <span>
                          {t("monthly.goals.metrics.recurringThisPeriod", {
                            count: measurement.currentPeriodCount ?? 0,
                            target: measurement.cadenceTarget ?? 0,
                          })}
                        </span>
                        <span>
                          {t("monthly.goals.metrics.recurringAdherence")}{" "}
                          {measurement.adherenceRatio === null
                            ? "—"
                            : `${Math.round(measurement.adherenceRatio * 100)}%`}
                        </span>
                        <span>
                          {t("monthly.goals.metrics.recurringStreak")} {measurement.currentStreak}
                        </span>
                      </>
                    ) : snapshot.goal.measurementType === "cumulative" ? (
                      <span>
                        {t("monthly.goals.metrics.cumulativeProgress", {
                          current:
                            snapshot.currentValue === null
                              ? "—"
                              : Math.round(snapshot.currentValue),
                          target: snapshot.goal.targetValue ?? "—",
                          unit: snapshot.goal.unit,
                        })}
                      </span>
                    ) : (
                      <>
                        <span>
                          {t("monthly.goals.metrics.current")}{" "}
                          {snapshot.currentValue === null
                            ? "—"
                            : `${Math.round(snapshot.currentValue)} ${snapshot.goal.unit}`.trim()}
                        </span>
                        <span>
                          {t("monthly.goals.metrics.target")}{" "}
                          {snapshot.goal.targetValue === null
                            ? "—"
                            : `${snapshot.goal.targetValue} ${snapshot.goal.unit}`.trim()}
                        </span>
                        <span>
                          {t("monthly.goals.metrics.month")}{" "}
                          {monthPoint?.value === null || monthPoint?.value === undefined
                            ? "—"
                            : `${Math.round(monthPoint.value)} ${snapshot.goal.unit}`.trim()}
                        </span>
                      </>
                    )}
                    <span>
                      {t("monthly.goals.metrics.evaluation")}{" "}
                      {evaluation?.score === null || evaluation?.score === undefined
                        ? "—"
                        : `${evaluation.score}/100`}
                    </span>
                  </div>
                </article>
              );
            })
          )}
        </div>
        <div className="section-actions">
          <Link className="button button--primary" to="/objectifs-annuels">
            {t("monthly.goals.manage")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("monthly.ritual.title")} subtitle={t("monthly.ritual.subtitle")}>
        <RitualSectionList
          className="monthly-ritual-stack"
          sections={monthlySections}
          scopeKey={review.monthKey}
          checklist={review.ritualChecklist}
          notes={review.notes}
          noteRefs={noteRefs}
          labels={{
            done: t("monthly.ritual.done"),
            doneAria: (section) => t("monthly.ritual.doneAria", { section }),
            notesLabel: (section) => t("monthly.ritual.notesLabel", { section }),
          }}
          onToggle={(sectionKey, checked) => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void saveReview(updateMonthlyReviewChecklist(currentReview, sectionKey, checked));
          }}
          onPersistNote={(sectionKey, value) => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            return saveReview(updateMonthlyReviewNote(currentReview, sectionKey, value));
          }}
        />
      </SectionCard>

      <SectionCard title={t("monthly.state.title")} subtitle={t("monthly.state.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("monthly.state.updatedAt")}</span>
            <strong>{formatTimestamp(review.updatedAt)}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.state.start")}</span>
            <strong>{summary.monthStartDate}</strong>
          </article>
          <article className="status-card">
            <span>{t("monthly.state.end")}</span>
            <strong>{summary.monthEndDate}</strong>
          </article>
        </div>
      </SectionCard>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void saveReview(applyMonthlyReviewTransition(currentReview, "closed"));
          }}
        >
          {t("monthly.actions.close")}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void saveReview(applyMonthlyReviewTransition(currentReview, "draft"));
          }}
        >
          {t("monthly.actions.reopen")}
        </button>
      </div>
    </div>
  );
};
