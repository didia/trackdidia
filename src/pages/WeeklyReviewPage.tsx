import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import {
  enqueueMidWeekDecisionSave,
  getFailedMidWeekDraft,
  waitForMidWeekDecisionSaves,
} from "../app/mid-week-decision-saves";
import { resolveInitialWeeklyReviewWeek } from "../app/reviews/review-query-params";
import { buildRitualSections, type RitualSectionMeta } from "../app/reviews/ritual-sections";
import { useReviewSynthesis } from "../app/reviews/use-review-synthesis";
import { useRescueTimeWeek } from "../app/reviews/use-rescuetime-week";
import { useWeeklyMemoryProposals } from "../app/reviews/use-weekly-memory-proposals";
import { useWeeklyReviewNotes } from "../app/reviews/use-weekly-review-notes";
import { useAsyncResource, useLatestRequest } from "../app/use-latest-request";
import { useProposalAcceptance } from "../app/use-proposal-acceptance";
import { PageHeader } from "../components/PageHeader";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { RitualSectionList } from "../components/RitualSectionList";
import { SectionCard } from "../components/SectionCard";
import { WeeklySynthesisPanel } from "../components/WeeklySynthesisPanel";
import { deriveStatusLabel } from "../domain/daily-entry";
import {
  buildMidWeekReviewSummary,
  compareMidWeekSnapshot,
  type MidWeekStatus,
} from "../domain/mid-week-review";
import type {
  AiProposal,
  WeeklyReviewSummary,
  WeeklyRitualSectionKey,
  WeeklySynthesisResult,
} from "../domain/types";
import {
  applyWeeklyReviewTransition,
  applyWeeklyScoreExternalAxes,
  buildWeekDates,
  createEmptyWeeklyReview,
  dimancheNotesWeekStart,
  getDefaultWeeklyReviewWeekStart,
  updateWeeklyReviewChecklist,
  updateWeeklyReviewNote,
} from "../domain/weekly-review";
import { resolveWeeklySnapshotInputs } from "../lib/ai/context/weekly-snapshot";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { applyCoachProposal, proposalPreviewText } from "../lib/ai/proposals/apply-proposal";
import { loadLatestWeeklySynthesis } from "../lib/ai/weekly-synthesis-loader";
import { WeeklySynthesisService } from "../lib/ai/weekly-synthesis-service";
import { addDays, formatDateLong, formatDateShort, getTodayDate } from "../lib/date";
import { formatPercent, formatTimestamp } from "../lib/format";
import { nowIso } from "../lib/gtd/shared";
import { loadDecoratedWeekEntries } from "../lib/storage/week-entries";

const ritualSectionMeta: ReadonlyArray<RitualSectionMeta<WeeklyRitualSectionKey>> = [
  { key: "bilan" },
  { key: "budget" },
  { key: "tempsEtPlan" },
  { key: "collecte", linkTo: "/inbox", linkKey: "weekly.ritual.collecte.link" },
  { key: "calendrier", linkTo: "/scheduled", linkKey: "weekly.ritual.calendrier.link" },
  { key: "gtd", linkTo: "/next-actions", linkKey: "weekly.ritual.gtd.link" },
  { key: "alignement", linkTo: "/projects", linkKey: "weekly.ritual.alignement.link" },
  { key: "dimanche", linkTo: "/historique", linkKey: "weekly.ritual.dimanche.link" },
];

interface WeeklySynthesisRunOptions {
  weekStartDate: string;
  trigger: "auto" | "explicit";
  bypassCache?: boolean;
  skipHashCheck?: boolean;
}

const formatMidWeekValue = (value: number | null, unit: string | null): string => {
  if (value === null) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  return unit ? `${rounded} ${unit}` : String(rounded);
};

const formatWholePercent = (value: number): string => `${Math.round(value)}%`;

export const WeeklyReviewPage = () => {
  const { t } = useTranslation("reviews");
  const { t: tCommon } = useTranslation("common");
  const { repository, settings, calendarDay } = useAppContext();
  const synthesisService = useMemo(() => new WeeklySynthesisService(new OpenRouterProvider()), []);
  const [searchParams] = useSearchParams();
  const dateFromQuery = searchParams.get("date");
  const [selectedWeekStart, setSelectedWeekStart] = useState(() =>
    resolveInitialWeeklyReviewWeek(dateFromQuery, getTodayDate()),
  );
  const [summary, setSummary] = useState<WeeklyReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const proposalAcceptance = useProposalAcceptance();
  const { applyingProposalIds } = proposalAcceptance;
  const {
    review,
    dimancheReview,
    latestReviewRef,
    latestDimancheReviewRef,
    load: loadNotes,
    saveReview,
    saveDimancheReview,
    withSectionReview,
  } = useWeeklyReviewNotes(calendarDay);
  const {
    goals: goalsSnapshot,
    pulse: pulseSnapshot,
    standingObjectives: standingObjectivesSnapshot,
    goalsLoading,
    pulseLoading,
    standingObjectivesLoading,
    goalsRefreshing,
    pulseRefreshing,
    message: rescueTimeMessage,
    load: loadRescueTimeData,
    refresh: refreshRescueTimeData,
    reloadStandingObjectives: loadStandingObjectives,
    getSnapshots: getRescueTimeSnapshots,
  } = useRescueTimeWeek(selectedWeekStart);
  const memoryProposals = useWeeklyMemoryProposals(review);
  const noteRefs = useRef<Partial<Record<WeeklyRitualSectionKey, PersistedTextareaHandle | null>>>(
    {},
  );
  const nextWeekDimancheRef = useRef<PersistedTextareaHandle | null>(null);
  const weekRequest = useLatestRequest();

  const runSynthesisRequest = useCallback(
    async (
      options: WeeklySynthesisRunOptions,
      {
        signal,
        setResult,
      }: { signal: { isLatest: () => boolean }; setResult: (r: WeeklySynthesisResult) => void },
    ) => {
      if (options.trigger === "auto") {
        const stored = await loadLatestWeeklySynthesis(
          repository,
          synthesisService,
          options.weekStartDate,
        );
        if (!signal.isLatest()) {
          return;
        }
        if (stored) {
          setResult(stored);
        }
      }

      if (options.skipHashCheck) {
        return;
      }

      const { goals: latestGoals, pulse: latestPulse } = getRescueTimeSnapshots();
      const goals = latestGoals?.weekStartDate === options.weekStartDate ? latestGoals : null;
      const pulse = latestPulse?.weekStartDate === options.weekStartDate ? latestPulse : null;
      const snapshotInputs = await resolveWeeklySnapshotInputs(repository, options.weekStartDate, {
        productivityPulse: pulse?.pulse ?? null,
        rescueTimeGoalsScore: goals?.score ?? null,
        rescueTimeGoalItems: goals?.items ?? [],
        rescuetimeConfigured: Boolean(settings.rescuetimeApiKey.trim()),
      });

      if (!signal.isLatest()) {
        return;
      }

      const result = await synthesisService.buildSynthesis(repository, {
        weekStartDate: options.weekStartDate,
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
    [getRescueTimeSnapshots, repository, settings, synthesisService],
  );
  const {
    visibleResult: synthesisResult,
    loading: synthesisLoading,
    run: runSynthesis,
    clear: clearSynthesis,
    replaceProposal: replaceSynthesisProposal,
    markProposalDismissed: markSynthesisProposalDismissed,
  } = useReviewSynthesis<WeeklySynthesisResult, WeeklySynthesisRunOptions>(
    summary?.weekStartDate ?? null,
    runSynthesisRequest,
  );

  const loadWeek = useCallback(
    async (requestedWeekStart: string) => {
      await weekRequest.run(async (signal) => {
        const normalized = buildWeekDates(requestedWeekStart);
        setLoading(true);
        clearSynthesis();
        try {
          const loaded = await loadNotes(normalized, signal.isLatest, () =>
            repository.computeWeeklyReviewSummary(normalized),
          );
          if (!loaded) {
            return;
          }
          setSelectedWeekStart(normalized);
          setSummary(loaded.companion);
          void loadRescueTimeData(normalized);
        } finally {
          if (signal.isLatest()) {
            setLoading(false);
          }
        }
      });
    },
    [clearSynthesis, loadNotes, loadRescueTimeData, repository, weekRequest],
  );

  useEffect(() => {
    void loadWeek(selectedWeekStart);
  }, [loadWeek]);

  useEffect(() => {
    if (!summary || loading) {
      return;
    }

    void runSynthesis({
      weekStartDate: summary.weekStartDate,
      trigger: "auto",
      skipHashCheck: goalsLoading || pulseLoading,
    });
  }, [summary?.weekStartDate, loading, goalsLoading, pulseLoading, runSynthesis]);

  const handleAcceptSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || !synthesisResult || proposalAcceptance.isApplying(proposal.id)) return;
    if (!proposalAcceptance.begin(proposal.id)) return;
    try {
      const weekStartDate = summary.weekStartDate;
      const applied = await applyCoachProposal(repository, proposal, {
        acceptedDate: weekStartDate,
        weekly: {
          withReview: (sectionKey, work) =>
            withSectionReview(weekStartDate, sectionKey, work, (target, text) => {
              if (target === "nextWeek") {
                nextWeekDimancheRef.current?.setDraft(text);
              } else {
                noteRefs.current[sectionKey]?.setDraft(text);
              }
            }),
        },
      });
      if (!applied.proposal) return;
      if (applied.objectiveId) await loadStandingObjectives(weekStartDate);
      replaceSynthesisProposal(applied.proposal);
    } finally {
      proposalAcceptance.end(proposal.id);
    }
  };

  const handleDismissSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || !synthesisResult) {
      return;
    }

    if (proposalAcceptance.isApplying(proposal.id)) {
      return;
    }

    await repository.decideAiProposal(proposal.id, "dismissed");
    markSynthesisProposalDismissed(proposal.id);
  };

  const handleAcceptWeeklyMemoryProposal = (proposal: AiProposal) =>
    memoryProposals.accept(proposal, latestReviewRef.current?.weekStartDate ?? selectedWeekStart);

  const hasValidSelectedWeek = useMemo(
    () => /^\d{4}-\d{2}-\d{2}$/.test(selectedWeekStart),
    [selectedWeekStart],
  );
  const weekEndDate = useMemo(
    () => (hasValidSelectedWeek ? addDays(selectedWeekStart, 6) : ""),
    [hasValidSelectedWeek, selectedWeekStart],
  );

  // Read-only mid-week decisions card. Entries are loaded only when a snapshot exists so plain
  // week navigation adds no queries.
  const midWeekWeek = useMemo(() => {
    try {
      return hasValidSelectedWeek ? buildWeekDates(selectedWeekStart) : selectedWeekStart;
    } catch {
      return selectedWeekStart;
    }
  }, [hasValidSelectedWeek, selectedWeekStart]);
  const midWeekDecisions = useAsyncResource(midWeekWeek, async (week) => {
    // A save still queued from /mi-semaine must land before the card reads the row.
    await waitForMidWeekDecisionSaves(week);
    return repository.getMidWeekDecisions(week);
  });
  // A save that rejected while its /mi-semaine editor was unmounted is only in memory; surface it
  // here so it can be retried. Read after the load, which waits for the week's save chain.
  const [retryingFailedDraft, setRetryingFailedDraft] = useState(false);
  const [failedDraftRetryError, setFailedDraftRetryError] = useState(false);
  const failedMidWeekDraft = midWeekDecisions.loading
    ? undefined
    : getFailedMidWeekDraft(midWeekWeek);
  const retryFailedMidWeekDraft = async (week: string, text: string) => {
    setRetryingFailedDraft(true);
    setFailedDraftRetryError(false);
    try {
      await enqueueMidWeekDecisionSave(week, text, () =>
        repository.saveMidWeekDecisions({
          weekStartDate: week,
          decisions: text,
          decidedOnDate: calendarDay,
          updatedAt: nowIso(),
        }),
      );
    } catch {
      setFailedDraftRetryError(true);
    } finally {
      setRetryingFailedDraft(false);
      void midWeekDecisions.reload();
    }
  };
  // Ignore a row that belongs to another week (the resource clears on key change, but guard anyway).
  const midWeekRow =
    midWeekDecisions.data?.weekStartDate === midWeekWeek ? midWeekDecisions.data : null;
  const midWeekSnapshot = midWeekRow?.laggingSnapshot ?? null;
  const midWeekEntries = useAsyncResource(
    `${midWeekWeek}|${midWeekSnapshot ? "with" : "without"}`,
    () =>
      midWeekSnapshot ? loadDecoratedWeekEntries(repository, midWeekWeek) : Promise.resolve(null),
  );
  const midWeekWeekEnd = addDays(midWeekWeek, 6);
  const midWeekToDate = midWeekWeekEnd >= calendarDay;
  const midWeekComparison = useMemo(() => {
    if (
      !midWeekSnapshot ||
      !midWeekEntries.data ||
      !summary ||
      summary.weekStartDate !== midWeekWeek
    ) {
      return null;
    }
    if (
      goalsLoading ||
      goalsRefreshing ||
      pulseLoading ||
      pulseRefreshing ||
      standingObjectivesLoading
    ) {
      return null;
    }
    const matches = <T extends { weekStartDate: string }>(value: T | null): T | null =>
      value?.weekStartDate === midWeekWeek ? value : null;
    const finalSummary = buildMidWeekReviewSummary({
      weekStartDate: midWeekWeek,
      asOfDate: midWeekToDate ? calendarDay : addDays(midWeekWeekEnd, 1),
      weekEntries: midWeekEntries.data,
      summary,
      goalsSnapshot: matches(goalsSnapshot),
      pulseSnapshot: matches(pulseSnapshot),
      objectivesSnapshot: matches(standingObjectivesSnapshot),
    });
    return compareMidWeekSnapshot(midWeekSnapshot, finalSummary);
  }, [
    midWeekSnapshot,
    midWeekEntries.data,
    summary,
    midWeekWeek,
    goalsSnapshot,
    pulseSnapshot,
    standingObjectivesSnapshot,
    goalsLoading,
    goalsRefreshing,
    pulseLoading,
    pulseRefreshing,
    standingObjectivesLoading,
    midWeekToDate,
    calendarDay,
    midWeekWeekEnd,
  ]);

  const displayedSummary = useMemo(() => {
    if (!summary) {
      return null;
    }

    const rescueTimeGoalsScore =
      goalsSnapshot?.weekStartDate === summary.weekStartDate ? goalsSnapshot.score : null;
    const productivityPulse =
      pulseSnapshot?.weekStartDate === summary.weekStartDate ? pulseSnapshot.pulse : null;

    return applyWeeklyScoreExternalAxes(summary, {
      rescueTimeGoalsScore,
      productivityPulse,
    });
  }, [goalsSnapshot, pulseSnapshot, summary]);

  const ritualSections = useMemo(
    () => buildRitualSections(ritualSectionMeta, (key) => String(t(key as never)), "weekly.ritual"),
    [t],
  );

  const formatHours = (hours: number | null): string =>
    hours === null ? t("weekly.format.none") : t("weekly.format.hours", { n: hours.toFixed(2) });

  const formatObjectiveScore = (score: number | null): string =>
    score === null ? t("weekly.format.none") : formatPercent(score);

  const formatPulse = (value: number | null): string =>
    value === null ? t("weekly.format.none") : t("weekly.format.score", { n: Math.round(value) });

  if (loading || !review || !summary || !displayedSummary) {
    return (
      <div className="page">
        <p>{t("weekly.loading")}</p>
      </div>
    );
  }

  const notesWeekStart = dimancheNotesWeekStart(summary.weekStartDate, calendarDay);
  const notesOnNextWeek = notesWeekStart !== summary.weekStartDate;
  const weekMatchedGoalsSnapshot =
    goalsSnapshot?.weekStartDate === summary.weekStartDate ? goalsSnapshot : null;
  const weekMatchedStandingObjectivesSnapshot =
    standingObjectivesSnapshot?.weekStartDate === summary.weekStartDate
      ? standingObjectivesSnapshot
      : null;
  const weekMatchedPulseSnapshot =
    pulseSnapshot?.weekStartDate === summary.weekStartDate ? pulseSnapshot : null;
  // Oldest timestamp among the cached snapshots, so the notice never overstates freshness.
  const rescueTimeCachedAt =
    [weekMatchedGoalsSnapshot?.cachedAt, weekMatchedPulseSnapshot?.cachedAt]
      .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const goalsBusy = goalsLoading || goalsRefreshing;

  const pulseBusy = pulseLoading || pulseRefreshing;
  const rescueTimeRefreshing = goalsRefreshing || pulseRefreshing;

  return (
    <div className="page">
      <PageHeader
        eyebrow={t("weekly.hero.eyebrow")}
        title={t("weekly.hero.range", {
          start: formatDateLong(summary.weekStartDate),
          end: formatDateLong(summary.weekEndDate),
        })}
        copy={t("weekly.hero.copy")}
        actions={
          <>
            <button
              className="button"
              type="button"
              disabled={!hasValidSelectedWeek}
              onClick={() => {
                if (!hasValidSelectedWeek) {
                  return;
                }
                void loadWeek(addDays(selectedWeekStart, -7));
              }}
            >
              {t("weekly.nav.prev")}
            </button>
            <button
              className="button"
              type="button"
              disabled={!hasValidSelectedWeek}
              onClick={() => {
                if (!hasValidSelectedWeek) {
                  return;
                }
                void loadWeek(addDays(selectedWeekStart, 7));
              }}
            >
              {t("weekly.nav.next")}
            </button>
          </>
        }
      />

      <SectionCard title={t("weekly.picker.title")} subtitle={t("weekly.picker.subtitle")}>
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>{t("weekly.picker.startLabel")}</span>
            <input
              aria-label={t("weekly.picker.startLabel")}
              type="date"
              value={selectedWeekStart}
              onChange={(event) => setSelectedWeekStart(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={!hasValidSelectedWeek}
              onClick={() => {
                if (!hasValidSelectedWeek) {
                  return;
                }
                void loadWeek(selectedWeekStart);
              }}
            >
              {t("weekly.picker.load")}
            </button>
            <button
              className="button"
              type="button"
              onClick={() =>
                void loadWeek(buildWeekDates(getDefaultWeeklyReviewWeekStart(getTodayDate())))
              }
            >
              {t("weekly.picker.current")}
            </button>
          </div>
        </div>
        <p className="empty-copy">
          {hasValidSelectedWeek
            ? t("weekly.picker.window", {
                start: formatDateShort(selectedWeekStart),
                end: formatDateShort(weekEndDate),
              })
            : t("weekly.picker.invalid")}
        </p>
      </SectionCard>

      <SectionCard title={t("weekly.coach.title")} subtitle={t("weekly.coach.subtitle")}>
        <WeeklySynthesisPanel
          result={synthesisResult}
          loading={synthesisLoading}
          settings={settings}
          applyingProposalIds={applyingProposalIds}
          onRequestCoach={() => {
            if (!summary) {
              return;
            }
            void runSynthesis({ weekStartDate: summary.weekStartDate, trigger: "explicit" });
          }}
          onRegenerate={() => {
            if (!summary) {
              return;
            }
            void runSynthesis({
              weekStartDate: summary.weekStartDate,
              trigger: "explicit",
              bypassCache: true,
            });
          }}
          onAcceptProposal={(proposal) => void handleAcceptSynthesisProposal(proposal)}
          onDismissProposal={(proposal) => void handleDismissSynthesisProposal(proposal)}
        />
      </SectionCard>

      <SectionCard title={t("weekly.overview.title")} subtitle={t("weekly.overview.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("weekly.overview.status")}</span>
            <strong>
              {review.status === "closed" ? t("weekly.status.closed") : t("weekly.status.draft")}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.score")}</span>
            <strong>{formatPercent(displayedSummary.weeklyScore)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.sleepAverage")}</span>
            <strong>{t("weekly.format.score", { n: Math.round(summary.sleepAverage) })}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.trcRespected")}</span>
            <strong>{summary.trcDaysRespected} / 7</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.screenTime")}</span>
            <strong>{summary.screenTimeTotalMinutes} min</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.pomodoris")}</span>
            <strong>{summary.pomodorisTotal}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.calorieAverage")}</span>
            <strong>{Math.round(summary.calorieAverage)} kcal</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.computerProductivity")}</span>
            <strong>
              {pulseBusy || !weekMatchedPulseSnapshot
                ? t("weekly.loadingPlaceholder")
                : formatPulse(displayedSummary.productivityPulse)}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.disciplineAverage")}</span>
            <strong>{formatWholePercent(summary.disciplineAverage * 100)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.tasks")}</span>
            <strong>
              {summary.tasksCompletedTotal} / {summary.tasksAddedTotal}
            </strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard
        title={t("weekly.midWeekDecisions.title")}
        subtitle={t("weekly.midWeekDecisions.subtitle")}
      >
        {midWeekDecisions.loading ||
        (midWeekDecisions.data !== null && midWeekDecisions.data.weekStartDate !== midWeekWeek) ? (
          <p className="empty-copy">{t("weekly.loadingPlaceholder")}</p>
        ) : midWeekDecisions.error ? (
          <div className="banner" role="alert">
            {t("weekly.midWeekDecisions.loadError")}{" "}
            <button className="button" type="button" onClick={() => void midWeekDecisions.reload()}>
              {t("weekly.midWeekDecisions.retry")}
            </button>
          </div>
        ) : failedMidWeekDraft ? (
          <>
            <p className="midweek-decisions-text">{failedMidWeekDraft.text}</p>
            <div className="banner" role="alert">
              {t("weekly.midWeekDecisions.unsaved")}{" "}
              <button
                className="button"
                type="button"
                disabled={retryingFailedDraft}
                onClick={() => void retryFailedMidWeekDraft(midWeekWeek, failedMidWeekDraft.text)}
              >
                {t("weekly.midWeekDecisions.retry")}
              </button>
            </div>
          </>
        ) : !midWeekRow ? (
          <>
            <p className="empty-copy">{t("weekly.midWeekDecisions.empty")}</p>
            <div className="section-actions">
              <Link className="button" to="/mi-semaine">
                {t("weekly.midWeekDecisions.openMidWeek")}
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="midweek-decisions-text">{midWeekRow.decisions}</p>
            <p className="empty-copy">
              {t("weekly.midWeekDecisions.decidedOn", {
                date: formatDateLong(midWeekRow.decidedOnDate),
              })}
            </p>
            {midWeekSnapshot ? (
              <>
                <h3>{t("weekly.midWeekDecisions.snapshotTitle")}</h3>
                {!midWeekComparison ? (
                  <p className="empty-copy">{t("weekly.midWeekDecisions.loadingSnapshot")}</p>
                ) : (
                  <ul className="midweek-list">
                    {midWeekComparison.map(({ key, before, after, recovered }) => {
                      const status = (value: MidWeekStatus) => t(`midWeek.status.${value}`);
                      return (
                        <li key={key} className="midweek-signal">
                          <strong>{before.label}</strong>
                          <p>
                            {t("weekly.midWeekDecisions.before", {
                              date: formatDateLong(midWeekSnapshot.asOfDate),
                              actual: formatMidWeekValue(before.actual, before.unit),
                              expected: formatMidWeekValue(before.expected, before.unit),
                              status: status(before.status),
                            })}
                          </p>
                          <p>
                            {after === null
                              ? t("weekly.midWeekDecisions.gone")
                              : after.status === "unknown"
                                ? t("weekly.midWeekDecisions.unknown")
                                : t(
                                    midWeekToDate
                                      ? "weekly.midWeekDecisions.afterToDate"
                                      : "weekly.midWeekDecisions.after",
                                    {
                                      actual: formatMidWeekValue(after.actual, after.unit),
                                      target: formatMidWeekValue(after.weekTarget, after.unit),
                                      status: status(after.status),
                                    },
                                  )}
                            {after !== null && after.status !== "unknown" && !after.hasFullCoverage
                              ? ` ${t("weekly.midWeekDecisions.partialCoverage", {
                                  withData: after.daysWithData,
                                  applicable: after.daysApplicable,
                                })}`
                              : ""}
                          </p>
                          <span className="summary-pill">
                            {recovered === true
                              ? t("weekly.midWeekDecisions.recovered")
                              : recovered === false
                                ? t("weekly.midWeekDecisions.notRecovered")
                                : t("weekly.midWeekDecisions.neutral")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : null}
            <div className="section-actions">
              <Link className="button" to="/mi-semaine">
                {t("weekly.midWeekDecisions.openMidWeek")}
              </Link>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title={t("weekly.rescueGoals.title")}
        subtitle={t("weekly.rescueGoals.subtitle")}
      >
        {rescueTimeMessage ? <div className="banner">{rescueTimeMessage}</div> : null}
        {!settings.rescuetimeApiKey.trim() ? (
          <div className="banner">
            {t("weekly.rescueGoals.missingKey")}{" "}
            <Link to="/parametres">{t("weekly.rescueGoals.settingsLink")}</Link>{" "}
            {t("weekly.rescueGoals.missingKeySuffix")}
          </div>
        ) : null}
        {weekMatchedGoalsSnapshot?.fetchError ? (
          <div className="banner">{weekMatchedGoalsSnapshot.fetchError}</div>
        ) : null}
        {weekMatchedPulseSnapshot?.fetchError ? (
          <div className="banner">{weekMatchedPulseSnapshot.fetchError}</div>
        ) : null}
        {rescueTimeCachedAt ? (
          <p className="empty-copy">
            {t("weekly.rescueGoals.cachedNotice", {
              timestamp: formatTimestamp(rescueTimeCachedAt),
            })}
          </p>
        ) : null}

        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("weekly.rescueGoals.metrics.score")}</span>
            <strong>
              {goalsBusy || !weekMatchedGoalsSnapshot
                ? t("weekly.loadingPlaceholder")
                : formatObjectiveScore(weekMatchedGoalsSnapshot.score)}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.rescueGoals.metrics.points")}</span>
            <strong>
              {goalsBusy || !weekMatchedGoalsSnapshot
                ? t("weekly.loadingPlaceholder")
                : weekMatchedGoalsSnapshot.items.length === 0
                  ? t("weekly.format.none")
                  : `${weekMatchedGoalsSnapshot.totalAchievement.toFixed(2)} / ${weekMatchedGoalsSnapshot.items.length}`}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.overview.computerProductivity")}</span>
            <strong>
              {pulseBusy || !weekMatchedPulseSnapshot
                ? t("weekly.loadingPlaceholder")
                : formatPulse(displayedSummary.productivityPulse)}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.rescueGoals.metrics.source")}</span>
            <strong>
              {!settings.rescuetimeApiKey.trim()
                ? t("weekly.rescueGoals.source.missingKey")
                : rescueTimeCachedAt
                  ? t("weekly.rescueGoals.source.cache")
                  : t("weekly.rescueGoals.source.goals")}
            </strong>
          </article>
        </div>

        <div className="form-actions">
          <button
            className="button"
            type="button"
            disabled={rescueTimeRefreshing || !settings.rescuetimeApiKey.trim()}
            onClick={() => void refreshRescueTimeData(summary.weekStartDate)}
          >
            {rescueTimeRefreshing
              ? t("weekly.rescueGoals.refreshing")
              : t("weekly.rescueGoals.refresh")}
          </button>
        </div>

        {goalsBusy || !weekMatchedGoalsSnapshot ? (
          <p className="empty-copy">{t("weekly.rescueGoals.loading")}</p>
        ) : weekMatchedGoalsSnapshot.items.length === 0 ? (
          weekMatchedGoalsSnapshot.fetchError ? null : (
            <p className="empty-copy">{t("weekly.rescueGoals.empty")}</p>
          )
        ) : (
          <div className="weekly-day-grid">
            {weekMatchedGoalsSnapshot.items.map((item) => (
              <article key={item.goalId} className="schedule-day-group">
                <div className="schedule-day-group__header">
                  <h3>{item.title}</h3>
                  <span>{item.achievement.toFixed(2)}/1</span>
                </div>
                <div className="weekly-day-card__metrics">
                  <span>
                    {item.isMore
                      ? t("weekly.rescueGoals.direction.more")
                      : t("weekly.rescueGoals.direction.less")}
                  </span>
                  <span>
                    {t("weekly.rescueGoals.timeLine", {
                      actual: formatHours(item.actualHours),
                      target: formatHours(item.weeklyTargetHours),
                    })}
                  </span>
                  <span>{t("weekly.rescueGoals.schedule", { label: item.scheduleLabel })}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t("weekly.standing.title")} subtitle={t("weekly.standing.subtitle")}>
        {weekMatchedStandingObjectivesSnapshot?.fetchError ? (
          <div className="banner">{weekMatchedStandingObjectivesSnapshot.fetchError}</div>
        ) : null}
        {weekMatchedStandingObjectivesSnapshot?.cachedAt ? (
          <p className="empty-copy">
            {t("weekly.rescueGoals.cachedNotice", {
              timestamp: formatTimestamp(weekMatchedStandingObjectivesSnapshot.cachedAt),
            })}
          </p>
        ) : null}
        {standingObjectivesLoading || !weekMatchedStandingObjectivesSnapshot ? (
          <p className="empty-copy">{t("weekly.standing.loading")}</p>
        ) : weekMatchedStandingObjectivesSnapshot.items.length === 0 ? (
          <p className="empty-copy">{t("weekly.standing.empty")}</p>
        ) : (
          <div className="weekly-day-grid">
            {weekMatchedStandingObjectivesSnapshot.items.map((item) => (
              <article key={item.objective.id} className="schedule-day-group">
                <div className="schedule-day-group__header">
                  <h3>{item.objective.title}</h3>
                  <span>{item.achievement.toFixed(2)}/1</span>
                </div>
                <div className="weekly-day-card__metrics">
                  <span>
                    {item.objective.kind === "manual"
                      ? t("weekly.standing.kind.manual")
                      : t("weekly.standing.kind.time")}
                  </span>
                  {item.objective.kind === "time" ? (
                    <span>
                      {t("weekly.standing.timeLine", {
                        actual: formatHours(item.actualHours),
                        target: formatHours(item.objective.targetHours),
                      })}
                    </span>
                  ) : (
                    <label className="switch-row">
                      <input
                        aria-label={t("weekly.standing.achievedAria", {
                          title: item.objective.title,
                        })}
                        type="checkbox"
                        checked={item.achievement === 1}
                        onChange={(event) => {
                          void repository
                            .saveWeeklyObjectiveResult({
                              weekStartDate: weekMatchedStandingObjectivesSnapshot.weekStartDate,
                              objectiveId: item.objective.id,
                              achieved: event.target.checked,
                              updatedAt: new Date().toISOString(),
                            })
                            .then(() =>
                              loadStandingObjectives(
                                weekMatchedStandingObjectivesSnapshot.weekStartDate,
                              ),
                            );
                        }}
                      />
                      <span>{t("weekly.standing.achieved")}</span>
                    </label>
                  )}
                  {item.error ? <span>{item.error}</span> : null}
                </div>
                <div className="section-actions">
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => {
                      void repository
                        .deleteWeeklyObjective(item.objective.id)
                        .then(() =>
                          loadStandingObjectives(
                            weekMatchedStandingObjectivesSnapshot.weekStartDate,
                          ),
                        );
                    }}
                  >
                    {t("weekly.standing.delete")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {!standingObjectivesLoading && weekMatchedStandingObjectivesSnapshot ? (
          <p className="empty-copy">
            {t("weekly.standing.score", {
              score: formatObjectiveScore(weekMatchedStandingObjectivesSnapshot.score),
            })}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title={t("weekly.axes.title")} subtitle={t("weekly.axes.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("weekly.axes.sleep")}</span>
            <strong>{formatWholePercent(summary.sleepQuality)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.respectTrc")}</span>
            <strong>{formatWholePercent(summary.respectTrc)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.screenTimeScore")}</span>
            <strong>{formatWholePercent(summary.phoneScreenTime)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.focusTimeScore")}</span>
            <strong>{formatWholePercent(summary.pomodoris)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.physicalActivity")}</span>
            <strong>{formatWholePercent(summary.physicalActivity)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.disciplineScore")}</span>
            <strong>{formatWholePercent(summary.discipline)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.completionRate")}</span>
            <strong>{formatWholePercent(summary.tasksCompletionRate)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.computerProductivity")}</span>
            <strong>
              {pulseBusy || !weekMatchedPulseSnapshot
                ? t("weekly.loadingPlaceholder")
                : formatPulse(displayedSummary.productivityPulse)}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.axes.rescueTimeScore")}</span>
            <strong>
              {goalsBusy || !weekMatchedGoalsSnapshot
                ? t("weekly.loadingPlaceholder")
                : formatObjectiveScore(displayedSummary.rescueTimeGoalsScore)}
            </strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard title={t("weekly.days.title")} subtitle={t("weekly.days.subtitle")}>
        <div className="weekly-day-grid">
          {summary.days.map((day) => (
            <article key={day.date} className="schedule-day-group">
              <div className="schedule-day-group__header">
                <h3>{formatDateShort(day.date)}</h3>
                <span>{deriveStatusLabel(day.status)}</span>
              </div>
              <div className="weekly-day-card__metrics">
                <span>
                  {day.sleepQuality === null
                    ? t("weekly.days.metrics.sleepNone")
                    : t("weekly.days.metrics.sleep", {
                        value: t("weekly.days.metrics.sleepValue", {
                          n: Math.round(day.sleepQuality),
                        }),
                      })}
                </span>
                <span>
                  {t("weekly.days.metrics.trc", {
                    value: day.trcRespected ? tCommon("boolean.yes") : tCommon("boolean.no"),
                  })}
                </span>
                <span>{t("weekly.days.metrics.screen", { n: day.screenTimeMinutes })}</span>
                <span>{t("weekly.days.metrics.pomodoris", { n: day.pomodoris })}</span>
                <span>{t("weekly.days.metrics.kcal", { n: day.calorieExpenditure })}</span>
                <span>
                  {t("weekly.days.metrics.discipline", {
                    value: formatWholePercent(day.disciplineScore * 100),
                  })}
                </span>
                <span>
                  {t("weekly.days.metrics.tasks", {
                    completed: day.tasksCompleted,
                    added: day.tasksAdded,
                  })}
                </span>
              </div>
            </article>
          ))}
        </div>
        <div className="section-actions">
          <Link className="button" to="/historique">
            {t("weekly.days.openHistory")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("weekly.ritual.title")} subtitle={t("weekly.ritual.subtitle")}>
        <RitualSectionList
          className="weekly-ritual-stack"
          sections={ritualSections}
          scopeKey={review.weekStartDate}
          checklist={review.ritualChecklist}
          notes={review.notes}
          noteRefs={noteRefs}
          labels={{
            done: t("weekly.ritual.done"),
            doneAria: (section) => t("weekly.ritual.doneAria", { section }),
            notesLabel: (section) => t("weekly.ritual.notesLabel", { section }),
          }}
          notesPlaceholder={(section) =>
            t("weekly.ritual.notesPlaceholder", { section: section.title.toLowerCase() })
          }
          onToggle={(sectionKey, checked) => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void saveReview(updateWeeklyReviewChecklist(currentReview, sectionKey, checked));
          }}
          onPersistNote={(sectionKey, value) => {
            const currentReview =
              latestReviewRef.current ?? createEmptyWeeklyReview(review.weekStartDate);
            return saveReview(updateWeeklyReviewNote(currentReview, sectionKey, value));
          }}
          renderAfterNotes={(section) =>
            section.key === "dimanche" && notesOnNextWeek ? (
              <label className="stacked-field">
                <span>{t("weekly.ritual.nextWeekNotesLabel")}</span>
                <PersistedTextarea
                  key={`${notesWeekStart}-dimanche-next`}
                  ref={(handle) => {
                    nextWeekDimancheRef.current = handle;
                  }}
                  rows={4}
                  debounceMs={0}
                  savedValue={dimancheReview?.notes.dimanche ?? ""}
                  onPersist={(value) => {
                    const currentDimanche =
                      latestDimancheReviewRef.current ?? createEmptyWeeklyReview(notesWeekStart);
                    return saveDimancheReview(
                      updateWeeklyReviewNote(currentDimanche, "dimanche", value),
                    );
                  }}
                  placeholder={t("weekly.ritual.nextWeekNotesPlaceholder")}
                />
              </label>
            ) : null
          }
        />
      </SectionCard>

      <SectionCard title={t("weekly.state.title")} subtitle={t("weekly.state.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("weekly.state.updatedAt")}</span>
            <strong>{formatTimestamp(review.updatedAt)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.state.start")}</span>
            <strong>{formatDateLong(summary.weekStartDate)}</strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.state.end")}</span>
            <strong>{formatDateLong(summary.weekEndDate)}</strong>
          </article>
        </div>
      </SectionCard>

      {memoryProposals.proposals.length > 0 ? (
        <SectionCard title={t("weekly.memory.title")} subtitle={t("weekly.memory.subtitle")}>
          <div className="coach-pulse__proposals">
            {memoryProposals.proposals.map((proposal) => (
              <article key={proposal.id} className="coach-pulse__proposal">
                <span>{t("weekly.memory.itemLabel")}</span>
                <p>{proposalPreviewText(proposal)}</p>
                <div className="section-actions">
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => void handleAcceptWeeklyMemoryProposal(proposal)}
                  >
                    {t("weekly.memory.accept")}
                  </button>
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => void memoryProposals.dismiss(proposal)}
                  >
                    {t("weekly.memory.dismiss")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void (async () => {
              const closedReview = applyWeeklyReviewTransition(currentReview, "closed");
              await memoryProposals.distillForClose(closedReview);
              await saveReview(closedReview);
            })();
          }}
        >
          {t("weekly.actions.close")}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => {
            const currentReview = latestReviewRef.current;
            if (!currentReview) {
              return;
            }
            void saveReview(applyWeeklyReviewTransition(currentReview, "draft"));
          }}
        >
          {t("weekly.actions.reopen")}
        </button>
      </div>
    </div>
  );
};
