import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { deriveStatusLabel } from "../domain/daily-entry";
import {
  applyWeeklyReviewTransition,
  applyWeeklyScoreExternalAxes,
  buildWeekDates,
  createEmptyWeeklyReview,
  updateWeeklyReviewChecklist,
  updateWeeklyReviewNote
} from "../domain/weekly-review";
import type {
  AiProposal,
  WeeklyReview,
  WeeklyReviewSummary,
  WeeklyRitualSectionKey,
  WeeklySynthesisResult
} from "../domain/types";
import type { RescueTimeGoalsSnapshot } from "../domain/rescuetime-goals";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { WeeklySynthesisPanel } from "../components/WeeklySynthesisPanel";
import { formatDateLong, formatDateShort, getTodayDate } from "../lib/date";
import { formatPercent, formatTimestamp } from "../lib/format";
import { addDays } from "../lib/gtd/shared";
import { RescueTimeGoalsService, type RescueTimeProductivityPulseSnapshot } from "../lib/rescuetime/rescuetime-goals-service";
import { createWeeklyMemoryProposals, loadWeeklyMemoryProposals } from "../lib/ai/memory/weekly-distillation";
import { applyCoachProposal, proposalPreviewText } from "../lib/ai/proposals/apply-proposal";
import {
  buildWeeklyObjectiveFromProposal,
  reviewSectionFromProposal
} from "../lib/ai/proposals/weekly-proposal-ids";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { resolveWeeklySnapshotInputs } from "../lib/ai/context/weekly-snapshot";
import { loadLatestWeeklySynthesis } from "../lib/ai/weekly-synthesis-loader";
import { WeeklySynthesisService } from "../lib/ai/weekly-synthesis-service";
import { WeeklyObjectivesService } from "../lib/rescuetime/weekly-objectives-service";
import type { WeeklyObjectivesSnapshot } from "../domain/types";

interface RitualSectionDefinition {
  key: WeeklyRitualSectionKey;
  title: string;
  subtitle: string;
  prompt: string;
  linkTo?: string;
  linkLabel?: string;
}

const ritualSectionMeta: Array<{
  key: WeeklyRitualSectionKey;
  linkTo?: string;
  linkKey?:
    | "weekly.ritual.collecte.link"
    | "weekly.ritual.calendrier.link"
    | "weekly.ritual.gtd.link"
    | "weekly.ritual.alignement.link"
    | "weekly.ritual.dimanche.link";
}> = [
  { key: "bilan" },
  { key: "budget" },
  { key: "tempsEtPlan" },
  { key: "collecte", linkTo: "/inbox", linkKey: "weekly.ritual.collecte.link" },
  { key: "calendrier", linkTo: "/scheduled", linkKey: "weekly.ritual.calendrier.link" },
  { key: "gtd", linkTo: "/next-actions", linkKey: "weekly.ritual.gtd.link" },
  { key: "alignement", linkTo: "/projects", linkKey: "weekly.ritual.alignement.link" },
  { key: "dimanche", linkTo: "/historique", linkKey: "weekly.ritual.dimanche.link" }
];

const formatWholePercent = (value: number): string => `${Math.round(value)}%`;

export const WeeklyReviewPage = () => {
  const { t } = useTranslation("reviews");
  const { t: tCommon } = useTranslation("common");
  const { repository, settings } = useAppContext();
  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const objectivesService = useMemo(() => new WeeklyObjectivesService(repository), [repository]);
  const synthesisService = useMemo(() => new WeeklySynthesisService(new OpenRouterProvider()), []);
  const [selectedWeekStart, setSelectedWeekStart] = useState(buildWeekDates(getTodayDate()));
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [summary, setSummary] = useState<WeeklyReviewSummary | null>(null);
  const [goalsSnapshot, setGoalsSnapshot] = useState<RescueTimeGoalsSnapshot | null>(null);
  const [standingObjectivesSnapshot, setStandingObjectivesSnapshot] = useState<WeeklyObjectivesSnapshot | null>(null);
  const [standingObjectivesLoading, setStandingObjectivesLoading] = useState(true);
  const [pulseSnapshot, setPulseSnapshot] = useState<RescueTimeProductivityPulseSnapshot | null>(null);
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [pulseLoading, setPulseLoading] = useState(true);
  const [goalsRefreshing, setGoalsRefreshing] = useState(false);
  const [pulseRefreshing, setPulseRefreshing] = useState(false);
  const [rescueTimeMessage, setRescueTimeMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [weeklyMemoryProposals, setWeeklyMemoryProposals] = useState<AiProposal[]>([]);
  const [synthesisResult, setSynthesisResult] = useState<WeeklySynthesisResult | null>(null);
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [applyingProposalIds, setApplyingProposalIds] = useState<string[]>([]);
  const latestReviewRef = useRef<WeeklyReview | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const noteRefs = useRef<Partial<Record<WeeklyRitualSectionKey, PersistedTextareaHandle | null>>>({});
  const weekRequestSeqRef = useRef(0);
  const goalsRequestSeqRef = useRef(0);
  const pulseRequestSeqRef = useRef(0);
  const standingObjectivesRequestSeqRef = useRef(0);
  const synthesisRequestSeqRef = useRef(0);

  const loadGoalsSnapshot = useCallback(
    async (requestedWeekStart: string, options?: { refreshing?: boolean }) => {
      const requestId = ++goalsRequestSeqRef.current;
      if (options?.refreshing) {
        setGoalsRefreshing(true);
      } else {
        setGoalsLoading(true);
      }
      setRescueTimeMessage("");
      try {
        const goals = await goalsService.computeGoalsSnapshot(requestedWeekStart);
        if (requestId !== goalsRequestSeqRef.current) {
          return;
        }
        setGoalsSnapshot(goals);
      } catch (error) {
        if (requestId !== goalsRequestSeqRef.current) {
          return;
        }
        if (options?.refreshing) {
          setRescueTimeMessage(
            error instanceof Error ? error.message : t("weekly.rescueGoals.refreshError")
          );
        }
      } finally {
        if (requestId === goalsRequestSeqRef.current) {
          if (options?.refreshing) {
            setGoalsRefreshing(false);
          } else {
            setGoalsLoading(false);
          }
        }
      }
    },
    [goalsService, t]
  );

  const loadPulseSnapshot = useCallback(
    async (requestedWeekStart: string, options?: { refreshing?: boolean }) => {
      const requestId = ++pulseRequestSeqRef.current;
      if (options?.refreshing) {
        setPulseRefreshing(true);
      } else {
        setPulseLoading(true);
      }
      setRescueTimeMessage("");
      try {
        const pulse = await goalsService.computeProductivityPulse(requestedWeekStart);
        if (requestId !== pulseRequestSeqRef.current) {
          return;
        }
        setPulseSnapshot(pulse);
      } catch (error) {
        if (requestId !== pulseRequestSeqRef.current) {
          return;
        }
        if (options?.refreshing) {
          setRescueTimeMessage(
            error instanceof Error ? error.message : t("weekly.rescueGoals.pulseRefreshError")
          );
        }
      } finally {
        if (requestId === pulseRequestSeqRef.current) {
          if (options?.refreshing) {
            setPulseRefreshing(false);
          } else {
            setPulseLoading(false);
          }
        }
      }
    },
    [goalsService, t]
  );

  const loadStandingObjectives = useCallback(
    async (requestedWeekStart: string) => {
      const requestId = ++standingObjectivesRequestSeqRef.current;
      setStandingObjectivesLoading(true);
      try {
        const snapshot = await objectivesService.computeWeeklyObjectivesSnapshot(requestedWeekStart);
        if (requestId !== standingObjectivesRequestSeqRef.current) {
          return;
        }
        setStandingObjectivesSnapshot(snapshot);
      } finally {
        if (requestId === standingObjectivesRequestSeqRef.current) {
          setStandingObjectivesLoading(false);
        }
      }
    },
    [objectivesService]
  );

  const loadRescueTimeData = useCallback(
    (requestedWeekStart: string) => {
      setGoalsSnapshot(null);
      setPulseSnapshot(null);
      setStandingObjectivesSnapshot(null);
      setGoalsRefreshing(false);
      setPulseRefreshing(false);
      setRescueTimeMessage("");
      void loadGoalsSnapshot(requestedWeekStart);
      void loadPulseSnapshot(requestedWeekStart);
      void loadStandingObjectives(requestedWeekStart);
    },
    [loadGoalsSnapshot, loadPulseSnapshot, loadStandingObjectives]
  );

  const refreshRescueTimeData = useCallback(
    (requestedWeekStart: string) => {
      void loadGoalsSnapshot(requestedWeekStart, { refreshing: true });
      void loadPulseSnapshot(requestedWeekStart, { refreshing: true });
    },
    [loadGoalsSnapshot, loadPulseSnapshot]
  );

  const loadWeek = useCallback(
    async (requestedWeekStart: string) => {
      const requestId = ++weekRequestSeqRef.current;
      const normalized = buildWeekDates(requestedWeekStart);
      setLoading(true);
      try {
        const [existingReview, computedSummary] = await Promise.all([
          repository.getWeeklyReview(normalized),
          repository.computeWeeklyReviewSummary(normalized)
        ]);
        if (requestId !== weekRequestSeqRef.current) {
          return;
        }
        const nextReview = existingReview ?? createEmptyWeeklyReview(normalized);
        latestReviewRef.current = nextReview;
        setSelectedWeekStart(normalized);
        setReview(nextReview);
        setSummary(computedSummary);
        void loadRescueTimeData(normalized);
      } finally {
        if (requestId === weekRequestSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [loadRescueTimeData, repository]
  );

  useEffect(() => {
    void loadWeek(selectedWeekStart);
  }, [loadWeek]);

  const saveReview = useCallback(
    (nextReview: WeeklyReview) => {
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const snapshot = latestReviewRef.current;
          if (!snapshot) {
            return;
          }
          await repository.saveWeeklyReview(snapshot);
        });
      return saveChainRef.current;
    },
    [repository]
  );

  const runSynthesis = useCallback(
    async (options: { weekStartDate: string; trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      const requestId = ++synthesisRequestSeqRef.current;
      setSynthesisLoading(true);
      setSynthesisResult(null);

      try {
        if (options.trigger === "auto") {
          const stored = await loadLatestWeeklySynthesis(repository, synthesisService, options.weekStartDate);
          if (requestId !== synthesisRequestSeqRef.current) {
            return;
          }
          if (stored) {
            setSynthesisResult(stored);
          }
        }

        const goals =
          goalsSnapshot?.weekStartDate === options.weekStartDate ? goalsSnapshot : null;
        const pulse =
          pulseSnapshot?.weekStartDate === options.weekStartDate ? pulseSnapshot : null;
        const snapshotInputs = await resolveWeeklySnapshotInputs(repository, options.weekStartDate, {
          productivityPulse: pulse?.pulse ?? null,
          rescueTimeGoalsScore: goals?.score ?? null,
          rescuetimeConfigured: Boolean(settings.rescuetimeApiKey.trim())
        });

        if (requestId !== synthesisRequestSeqRef.current) {
          return;
        }

        const result = await synthesisService.buildSynthesis(repository, {
          weekStartDate: options.weekStartDate,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache
        });

        if (requestId !== synthesisRequestSeqRef.current) {
          return;
        }

        setSynthesisResult(result);
      } finally {
        if (requestId === synthesisRequestSeqRef.current) {
          setSynthesisLoading(false);
        }
      }
    },
    [goalsSnapshot, pulseSnapshot, repository, settings, synthesisService]
  );

  useEffect(() => {
    if (!summary || loading || goalsLoading || pulseLoading) {
      return;
    }

    setSynthesisResult(null);
    void runSynthesis({ weekStartDate: summary.weekStartDate, trigger: "auto" });
  }, [summary?.weekStartDate, loading, goalsLoading, pulseLoading, runSynthesis]);

  const synthesisMatchesWeek =
    synthesisResult?.message.scopeKey === summary?.weekStartDate && synthesisResult !== null;

  const handleAcceptSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || synthesisResult?.message.scopeKey !== summary.weekStartDate) {
      return;
    }

    if (applyingProposalIds.includes(proposal.id)) {
      return;
    }

    setApplyingProposalIds((current) => [...current, proposal.id]);

    try {
      const weekStartDate = summary.weekStartDate;
      const currentReview = latestReviewRef.current ?? review ?? createEmptyWeeklyReview(weekStartDate);

      if (proposal.type === "review_section_draft") {
        const section = reviewSectionFromProposal(proposal);
        if (!section) {
          return;
        }

        const nextReview = updateWeeklyReviewNote(currentReview, section.sectionKey, section.text);
        latestReviewRef.current = nextReview;
        setReview(nextReview);
        noteRefs.current[section.sectionKey]?.setDraft(section.text);

        const accepted = await repository.acceptAiReviewSectionDraftProposal(proposal, nextReview);
        setSynthesisResult((current) =>
          current
            ? {
                ...current,
                proposals: current.proposals.map((item) =>
                  item.id === proposal.id ? accepted.proposal : item
                )
              }
            : current
        );
        return;
      }

      if (proposal.type === "weekly_objective") {
        const objectives = await repository.listWeeklyObjectives();
        const objective = buildWeeklyObjectiveFromProposal(proposal, objectives.length);
        if (!objective) {
          return;
        }

        const accepted = await repository.acceptAiWeeklyObjectiveProposal(proposal, objective);
        await loadStandingObjectives(weekStartDate);
        setSynthesisResult((current) =>
          current
            ? {
                ...current,
                proposals: current.proposals.map((item) =>
                  item.id === proposal.id ? accepted.proposal : item
                )
              }
            : current
        );
        return;
      }

      if (proposal.type === "gtd_action") {
        const accepted = await repository.acceptAiGtdActionProposal(proposal, getTodayDate());
        if (!accepted.taskId) {
          return;
        }

        setSynthesisResult((current) =>
          current
            ? {
                ...current,
                proposals: current.proposals.map((item) =>
                  item.id === proposal.id ? accepted.proposal : item
                )
              }
            : current
        );
        return;
      }

      const applied = await applyCoachProposal(repository, proposal, weekStartDate);
      if (applied.proposalDecided) {
        setSynthesisResult((current) =>
          current
            ? {
                ...current,
                proposals: current.proposals.map((item) =>
                  item.id === proposal.id
                    ? { ...item, status: "accepted", decidedAt: new Date().toISOString() }
                    : item
                )
              }
            : current
        );
        return;
      }

      await repository.decideAiProposal(
        proposal.id,
        "accepted",
        applied.objectiveId ?? applied.taskId ?? applied.memoryId ?? weekStartDate
      );
      setSynthesisResult((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.id === proposal.id ? { ...item, status: "accepted", decidedAt: new Date().toISOString() } : item
              )
            }
          : current
      );
    } finally {
      setApplyingProposalIds((current) => current.filter((id) => id !== proposal.id));
    }
  };

  const handleDismissSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || synthesisResult?.message.scopeKey !== summary.weekStartDate) {
      return;
    }

    if (applyingProposalIds.includes(proposal.id)) {
      return;
    }

    await repository.decideAiProposal(proposal.id, "dismissed");
    setSynthesisResult((current) =>
      current
        ? {
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === proposal.id ? { ...item, status: "dismissed", decidedAt: new Date().toISOString() } : item
            )
          }
        : current
    );
  };

  const refreshWeeklyMemoryProposals = useCallback(
    async (weekStartDate: string) => {
      const proposals = await loadWeeklyMemoryProposals(repository, weekStartDate);
      setWeeklyMemoryProposals(proposals);
    },
    [repository]
  );

  useEffect(() => {
    if (review?.status !== "closed") {
      setWeeklyMemoryProposals([]);
      return;
    }

    void refreshWeeklyMemoryProposals(review.weekStartDate);
  }, [review?.status, review?.weekStartDate, refreshWeeklyMemoryProposals]);

  const handleAcceptWeeklyMemoryProposal = async (proposal: AiProposal) => {
    const weekStartDate = latestReviewRef.current?.weekStartDate ?? selectedWeekStart;
    await applyCoachProposal(repository, proposal, weekStartDate);
    setWeeklyMemoryProposals((current) => current.filter((item) => item.id !== proposal.id));
  };

  const handleDismissWeeklyMemoryProposal = async (proposal: AiProposal) => {
    await repository.decideAiProposal(proposal.id, "dismissed");
    setWeeklyMemoryProposals((current) => current.filter((item) => item.id !== proposal.id));
  };

  const hasValidSelectedWeek = useMemo(
    () => /^\d{4}-\d{2}-\d{2}$/.test(selectedWeekStart),
    [selectedWeekStart]
  );
  const weekEndDate = useMemo(
    () => (hasValidSelectedWeek ? addDays(selectedWeekStart, 6) : ""),
    [hasValidSelectedWeek, selectedWeekStart]
  );

  const previousRescuetimeApiKeyRef = useRef(settings.rescuetimeApiKey);

  useEffect(() => {
    if (previousRescuetimeApiKeyRef.current === settings.rescuetimeApiKey) {
      return;
    }

    previousRescuetimeApiKeyRef.current = settings.rescuetimeApiKey;

    if (hasValidSelectedWeek) {
      void loadRescueTimeData(selectedWeekStart);
    }
  }, [settings.rescuetimeApiKey, hasValidSelectedWeek, loadRescueTimeData, selectedWeekStart]);

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
      productivityPulse
    });
  }, [goalsSnapshot, pulseSnapshot, summary]);

  const ritualSections = useMemo<RitualSectionDefinition[]>(
    () =>
      ritualSectionMeta.map((section) => ({
        key: section.key,
        title: t(`weekly.ritual.${section.key}.title`),
        subtitle: t(`weekly.ritual.${section.key}.subtitle`),
        prompt: t(`weekly.ritual.${section.key}.prompt`),
        linkTo: section.linkTo,
        linkLabel: section.linkKey ? t(section.linkKey) : undefined
      })),
    [t]
  );

  const formatHours = (hours: number | null): string =>
    hours === null ? t("weekly.format.none") : t("weekly.format.hours", { n: hours.toFixed(2) });

  const formatObjectiveScore = (score: number | null): string =>
    score === null ? t("weekly.format.none") : formatPercent(score);

  const formatPulse = (value: number | null): string =>
    value === null ? t("weekly.format.none") : t("weekly.format.score", { n: Math.round(value) });

  if (loading || !review || !summary || !displayedSummary) {
    return <div className="page"><p>{t("weekly.loading")}</p></div>;
  }

  const weekMatchedGoalsSnapshot =
    goalsSnapshot?.weekStartDate === summary.weekStartDate ? goalsSnapshot : null;
  const weekMatchedStandingObjectivesSnapshot =
    standingObjectivesSnapshot?.weekStartDate === summary.weekStartDate ? standingObjectivesSnapshot : null;
  const weekMatchedPulseSnapshot =
    pulseSnapshot?.weekStartDate === summary.weekStartDate ? pulseSnapshot : null;
  const goalsBusy = goalsLoading || goalsRefreshing;
  const pulseBusy = pulseLoading || pulseRefreshing;
  const rescueTimeRefreshing = goalsRefreshing || pulseRefreshing;

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("weekly.hero.eyebrow")}</p>
          <h2>
            {t("weekly.hero.range", {
              start: formatDateLong(summary.weekStartDate),
              end: formatDateLong(summary.weekEndDate)
            })}
          </h2>
          <p className="hero__copy">
            {t("weekly.hero.copy")}
          </p>
        </div>
        <div className="hero__actions">
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
        </div>
      </header>

      <SectionCard
        title={t("weekly.picker.title")}
        subtitle={t("weekly.picker.subtitle")}
      >
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
            <button className="button" type="button" onClick={() => void loadWeek(buildWeekDates(getTodayDate()))}>
              {t("weekly.picker.current")}
            </button>
          </div>
        </div>
        <p className="empty-copy">
          {hasValidSelectedWeek
            ? t("weekly.picker.window", {
                start: formatDateShort(selectedWeekStart),
                end: formatDateShort(weekEndDate)
              })
            : t("weekly.picker.invalid")}
        </p>
      </SectionCard>

      <SectionCard title={t("weekly.coach.title")} subtitle={t("weekly.coach.subtitle")}>
        <WeeklySynthesisPanel
          result={synthesisMatchesWeek ? synthesisResult : null}
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
            void runSynthesis({ weekStartDate: summary.weekStartDate, trigger: "explicit", bypassCache: true });
          }}
          onAcceptProposal={(proposal) => void handleAcceptSynthesisProposal(proposal)}
          onDismissProposal={(proposal) => void handleDismissSynthesisProposal(proposal)}
        />
      </SectionCard>

      <SectionCard title={t("weekly.overview.title")} subtitle={t("weekly.overview.subtitle")}>
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>{t("weekly.overview.status")}</span>
            <strong>{review.status === "closed" ? t("weekly.status.closed") : t("weekly.status.draft")}</strong>
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
              {pulseBusy || !weekMatchedPulseSnapshot ? t("weekly.loadingPlaceholder") : formatPulse(displayedSummary.productivityPulse)}
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
        title={t("weekly.rescueGoals.title")}
        subtitle={t("weekly.rescueGoals.subtitle")}
      >
        {rescueTimeMessage ? <div className="banner">{rescueTimeMessage}</div> : null}
        {!settings.rescuetimeApiKey.trim() ? (
          <div className="banner">
            {t("weekly.rescueGoals.missingKey")}{" "}
            <Link to="/parametres">{t("weekly.rescueGoals.settingsLink")}</Link> {t("weekly.rescueGoals.missingKeySuffix")}
          </div>
        ) : null}
        {weekMatchedGoalsSnapshot?.fetchError ? (
          <div className="banner">{weekMatchedGoalsSnapshot.fetchError}</div>
        ) : null}
        {weekMatchedPulseSnapshot?.fetchError ? (
          <div className="banner">{weekMatchedPulseSnapshot.fetchError}</div>
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
              {pulseBusy || !weekMatchedPulseSnapshot ? t("weekly.loadingPlaceholder") : formatPulse(displayedSummary.productivityPulse)}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("weekly.rescueGoals.metrics.source")}</span>
            <strong>{settings.rescuetimeApiKey.trim() ? t("weekly.rescueGoals.source.goals") : t("weekly.rescueGoals.source.missingKey")}</strong>
          </article>
        </div>

        <div className="form-actions">
          <button
            className="button"
            type="button"
            disabled={rescueTimeRefreshing || !settings.rescuetimeApiKey.trim()}
            onClick={() => void refreshRescueTimeData(summary.weekStartDate)}
          >
            {rescueTimeRefreshing ? t("weekly.rescueGoals.refreshing") : t("weekly.rescueGoals.refresh")}
          </button>
        </div>

        {goalsBusy || !weekMatchedGoalsSnapshot ? (
          <p className="empty-copy">{t("weekly.rescueGoals.loading")}</p>
        ) : weekMatchedGoalsSnapshot.fetchError ? null : weekMatchedGoalsSnapshot.items.length === 0 ? (
          <p className="empty-copy">{t("weekly.rescueGoals.empty")}</p>
        ) : (
          <div className="weekly-day-grid">
            {weekMatchedGoalsSnapshot.items.map((item) => (
              <article key={item.goalId} className="schedule-day-group">
                <div className="schedule-day-group__header">
                  <h3>{item.title}</h3>
                  <span>{item.achievement.toFixed(2)}/1</span>
                </div>
                <div className="weekly-day-card__metrics">
                  <span>{item.isMore ? t("weekly.rescueGoals.direction.more") : t("weekly.rescueGoals.direction.less")}</span>
                  <span>
                    {t("weekly.rescueGoals.timeLine", {
                      actual: formatHours(item.actualHours),
                      target: formatHours(item.weeklyTargetHours)
                    })}
                  </span>
                  <span>{t("weekly.rescueGoals.schedule", { label: item.scheduleLabel })}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title={t("weekly.standing.title")}
        subtitle={t("weekly.standing.subtitle")}
      >
        {standingObjectivesLoading || !weekMatchedStandingObjectivesSnapshot ? (
          <p className="empty-copy">{t("weekly.standing.loading")}</p>
        ) : weekMatchedStandingObjectivesSnapshot.fetchError ? (
          <div className="banner">{weekMatchedStandingObjectivesSnapshot.fetchError}</div>
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
                  <span>{item.objective.kind === "manual" ? t("weekly.standing.kind.manual") : t("weekly.standing.kind.time")}</span>
                  {item.objective.kind === "time" ? (
                    <span>
                      {t("weekly.standing.timeLine", {
                        actual: formatHours(item.actualHours),
                        target: formatHours(item.objective.targetHours)
                      })}
                    </span>
                  ) : (
                    <label className="switch-row">
                      <input
                        aria-label={t("weekly.standing.achievedAria", { title: item.objective.title })}
                        type="checkbox"
                        checked={item.achievement === 1}
                        onChange={(event) => {
                          void repository.saveWeeklyObjectiveResult({
                            weekStartDate: weekMatchedStandingObjectivesSnapshot.weekStartDate,
                            objectiveId: item.objective.id,
                            achieved: event.target.checked,
                            updatedAt: new Date().toISOString()
                          }).then(() => loadStandingObjectives(weekMatchedStandingObjectivesSnapshot.weekStartDate));
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
                      void repository.deleteWeeklyObjective(item.objective.id).then(() =>
                        loadStandingObjectives(weekMatchedStandingObjectivesSnapshot.weekStartDate)
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
            {t("weekly.standing.score", { score: formatObjectiveScore(weekMatchedStandingObjectivesSnapshot.score) })}
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
              {pulseBusy || !weekMatchedPulseSnapshot ? t("weekly.loadingPlaceholder") : formatPulse(displayedSummary.productivityPulse)}
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
                        value: t("weekly.days.metrics.sleepValue", { n: Math.round(day.sleepQuality) })
                      })}
                </span>
                <span>
                  {t("weekly.days.metrics.trc", {
                    value: day.trcRespected ? tCommon("boolean.yes") : tCommon("boolean.no")
                  })}
                </span>
                <span>{t("weekly.days.metrics.screen", { n: day.screenTimeMinutes })}</span>
                <span>{t("weekly.days.metrics.pomodoris", { n: day.pomodoris })}</span>
                <span>{t("weekly.days.metrics.kcal", { n: day.calorieExpenditure })}</span>
                <span>{t("weekly.days.metrics.discipline", { value: formatWholePercent(day.disciplineScore * 100) })}</span>
                <span>
                  {t("weekly.days.metrics.tasks", { completed: day.tasksCompleted, added: day.tasksAdded })}
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

      <SectionCard
        title={t("weekly.ritual.title")}
        subtitle={t("weekly.ritual.subtitle")}
      >
        <div className="weekly-ritual-grid">
          {ritualSections.map((section) => (
            <article key={section.key} className="weekly-ritual-card">
              <div className="weekly-ritual-card__header">
                <div>
                  <h3>{section.title}</h3>
                  <p>{section.subtitle}</p>
                </div>
                <label className="switch-row">
                  <input
                    aria-label={t("weekly.ritual.doneAria", { section: section.title })}
                    type="checkbox"
                    checked={review.ritualChecklist[section.key]}
                    onChange={(event) => {
                      const currentReview = latestReviewRef.current;
                      if (!currentReview) {
                        return;
                      }
                      void saveReview(updateWeeklyReviewChecklist(currentReview, section.key, event.target.checked));
                    }}
                  />
                  <span>{t("weekly.ritual.done")}</span>
                </label>
              </div>
              <p className="empty-copy">{section.prompt}</p>
              <label className="stacked-field">
                <span>{t("weekly.ritual.notesLabel", { section: section.title })}</span>
                <PersistedTextarea
                  key={`${review.weekStartDate}-${section.key}`}
                  ref={(handle) => {
                    noteRefs.current[section.key] = handle;
                  }}
                  rows={4}
                  debounceMs={0}
                  savedValue={review.notes[section.key]}
                  onPersist={(value) => {
                    const currentReview = latestReviewRef.current;
                    if (!currentReview) {
                      return;
                    }
                    void saveReview(updateWeeklyReviewNote(currentReview, section.key, value));
                  }}
                  placeholder={t("weekly.ritual.notesPlaceholder", { section: section.title.toLowerCase() })}
                />
              </label>
              {section.linkTo && section.linkLabel ? (
                <div className="section-actions">
                  <Link className="button button--ghost" to={section.linkTo}>
                    {section.linkLabel}
                  </Link>
                </div>
              ) : null}
            </article>
          ))}
        </div>
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

      {weeklyMemoryProposals.length > 0 ? (
        <SectionCard
          title={t("weekly.memory.title")}
          subtitle={t("weekly.memory.subtitle")}
        >
          <div className="coach-pulse__proposals">
            {weeklyMemoryProposals.map((proposal) => (
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
                    onClick={() => void handleDismissWeeklyMemoryProposal(proposal)}
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
              const historyEntries = await repository.listDailyEntries(120);
              const proposals = await createWeeklyMemoryProposals(
                repository,
                closedReview.weekStartDate,
                historyEntries
              );
              setWeeklyMemoryProposals(proposals);
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
