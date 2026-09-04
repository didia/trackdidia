import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import {
  applyMonthlyReviewTransition,
  createEmptyMonthlyReview,
  getMonthEndDate,
  getMonthKey,
  getMonthStartDate,
  getPreviousMonthKey,
  isFirstSaturdayOfMonth,
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
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, getTodayDate } from "../lib/date";
import { formatPercent } from "../lib/format";
import { formatTimestamp } from "../lib/format";
import { resolveMonthlySnapshotInputs } from "../lib/ai/context/monthly-snapshot";
import { loadLatestMonthlySynthesis } from "../lib/ai/monthly-synthesis-loader";
import {
  MonthlySynthesisService,
  monthlyReviewSectionFromProposal,
} from "../lib/ai/monthly-synthesis-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { applyCoachProposal } from "../lib/ai/proposals/apply-proposal";

interface MonthlySectionDefinition {
  key: MonthlyReviewSectionKey;
  title: string;
  subtitle: string;
  prompt: string;
  linkTo?: string;
  linkLabel?: string;
}

const monthlySectionMeta: Array<{
  key: MonthlyReviewSectionKey;
  linkTo?: string;
  linkKey?:
    | "monthly.ritual.journaux.link"
    | "monthly.ritual.progressionObjectifs.link"
    | "monthly.ritual.nettoyageListes.link"
    | "monthly.ritual.calendrier.link"
    | "monthly.ritual.grosProjets.link";
}> = [
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
  const { t } = useTranslation("reviews");
  const { repository, settings } = useAppContext();
  const synthesisService = useMemo(() => new MonthlySynthesisService(new OpenRouterProvider()), []);
  const today = getTodayDate();
  const initialMonth = isFirstSaturdayOfMonth(today)
    ? getPreviousMonthKey(today)
    : getMonthKey(today);
  const [selectedMonthKey, setSelectedMonthKey] = useState(initialMonth);
  const [review, setReview] = useState<MonthlyReview | null>(null);
  const [summary, setSummary] = useState<MonthlyReviewSummary | null>(null);
  const [goalSnapshots, setGoalSnapshots] = useState<AnnualGoalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [synthesisResult, setSynthesisResult] = useState<MonthlySynthesisResult | null>(null);
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [synthesisNotice, setSynthesisNotice] = useState<string | null>(null);
  const latestReviewRef = useRef<MonthlyReview | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const noteRefs = useRef<Partial<Record<MonthlyReviewSectionKey, PersistedTextareaHandle | null>>>(
    {},
  );
  const synthesisRequestSeqRef = useRef(0);

  const loadMonth = useCallback(
    async (requestedMonthKey: string) => {
      if (!/^\d{4}-\d{2}$/.test(requestedMonthKey)) {
        return;
      }

      synthesisRequestSeqRef.current += 1;
      setSynthesisResult(null);
      setLoading(true);
      const [existingReview, computedSummary, annualSnapshots] = await Promise.all([
        repository.getMonthlyReview(requestedMonthKey),
        repository.computeMonthlyReviewSummary(requestedMonthKey),
        repository.computeAnnualGoalSnapshots(Number(requestedMonthKey.slice(0, 4))),
      ]);
      const nextReview = existingReview ?? createEmptyMonthlyReview(requestedMonthKey);
      latestReviewRef.current = nextReview;
      setSelectedMonthKey(requestedMonthKey);
      setReview(nextReview);
      setSummary(computedSummary);
      setGoalSnapshots(annualSnapshots);
      setLoading(false);
    },
    [repository],
  );

  useEffect(() => {
    void loadMonth(selectedMonthKey);
  }, [loadMonth]);

  const runSynthesis = useCallback(
    async (options: { monthKey: string; trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      const requestId = ++synthesisRequestSeqRef.current;
      setSynthesisLoading(true);
      setSynthesisResult(null);

      try {
        if (options.trigger === "auto") {
          const stored = await loadLatestMonthlySynthesis(
            repository,
            synthesisService,
            options.monthKey,
          );
          if (requestId !== synthesisRequestSeqRef.current) {
            return;
          }
          if (stored) {
            setSynthesisResult(stored);
          }
        }

        const snapshotInputs = await resolveMonthlySnapshotInputs(repository, options.monthKey);

        if (requestId !== synthesisRequestSeqRef.current) {
          return;
        }

        const result = await synthesisService.buildSynthesis(repository, {
          monthKey: options.monthKey,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache,
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
    [repository, settings, synthesisService],
  );

  useEffect(() => {
    if (!summary || loading) {
      return;
    }

    void runSynthesis({ monthKey: summary.monthKey, trigger: "auto" });
  }, [summary?.monthKey, loading, runSynthesis]);

  const synthesisMatchesMonth =
    synthesisResult?.message.scopeKey === summary?.monthKey && synthesisResult !== null;

  const handleAcceptSynthesisProposal = async (proposal: AiProposal) => {
    if (!summary || synthesisResult?.message.scopeKey !== summary.monthKey) {
      return;
    }

    const monthKey = summary.monthKey;
    const currentReview = latestReviewRef.current ?? review ?? createEmptyMonthlyReview(monthKey);

    if (proposal.type === "review_section_draft") {
      const section = monthlyReviewSectionFromProposal(proposal);
      if (!section) {
        return;
      }

      const nextReview = updateMonthlyReviewNote(currentReview, section.sectionKey, section.text);
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      noteRefs.current[section.sectionKey]?.setDraft(section.text);

      const accepted = await repository.acceptAiMonthlyReviewSectionDraftProposal(
        proposal,
        nextReview,
      );
      setSynthesisResult((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.id === proposal.id ? accepted.proposal : item,
              ),
            }
          : current,
      );
      return;
    }

    if (proposal.type === "goal_evaluation") {
      const payload = JSON.parse(proposal.payloadJson) as { monthKey?: string };
      if (payload.monthKey !== monthKey) {
        return;
      }
    }

    const applied = await applyCoachProposal(repository, proposal, monthKey);

    if (proposal.type === "goal_evaluation" && !applied.goalId) {
      await repository.decideAiProposal(proposal.id, "dismissed");
      setSynthesisNotice(t("monthly.synthesis.goalMissing"));
      setSynthesisResult((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.id === proposal.id
                  ? { ...item, status: "dismissed", decidedAt: new Date().toISOString() }
                  : item,
              ),
            }
          : current,
      );
      return;
    }

    if (proposal.type === "goal_evaluation" && applied.goalId) {
      const annualSnapshots = await repository.computeAnnualGoalSnapshots(
        Number(monthKey.slice(0, 4)),
      );
      setGoalSnapshots(annualSnapshots);
    }

    await repository.decideAiProposal(
      proposal.id,
      "accepted",
      applied.goalId ?? applied.objectiveId ?? applied.taskId ?? applied.memoryId ?? monthKey,
    );
    setSynthesisResult((current) =>
      current
        ? {
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === proposal.id
                ? { ...item, status: "accepted", decidedAt: new Date().toISOString() }
                : item,
            ),
          }
        : current,
    );
  };

  const handleDismissSynthesisProposal = async (proposal: AiProposal) => {
    await repository.decideAiProposal(proposal.id, "dismissed");
    setSynthesisResult((current) =>
      current
        ? {
            ...current,
            proposals: current.proposals.map((item) =>
              item.id === proposal.id
                ? { ...item, status: "dismissed", decidedAt: new Date().toISOString() }
                : item,
            ),
          }
        : current,
    );
  };

  const saveReview = useCallback(
    (nextReview: MonthlyReview) => {
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const snapshot = latestReviewRef.current;
          if (!snapshot) {
            return;
          }
          await repository.saveMonthlyReview(snapshot);
        });
      return saveChainRef.current;
    },
    [repository],
  );

  const selectedGoalSnapshots = useMemo(
    () =>
      goalSnapshots.filter((snapshot) =>
        snapshot.monthlyProgress.some((point) => point.monthKey === selectedMonthKey),
      ),
    [goalSnapshots, selectedMonthKey],
  );

  const monthlySections = useMemo<MonthlySectionDefinition[]>(
    () =>
      monthlySectionMeta.map((section) => ({
        key: section.key,
        title: t(`monthly.ritual.${section.key}.title`),
        subtitle: t(`monthly.ritual.${section.key}.subtitle`),
        prompt: t(`monthly.ritual.${section.key}.prompt`),
        linkTo: section.linkTo,
        linkLabel: section.linkKey ? t(section.linkKey) : undefined,
      })),
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
      <header className="hero">
        <div>
          <p className="eyebrow">{t("monthly.hero.eyebrow")}</p>
          <h2>
            {t("monthly.hero.range", {
              start: formatDateLong(summary.monthStartDate),
              end: formatDateLong(summary.monthEndDate),
            })}
          </h2>
          <p className="hero__copy">{t("monthly.hero.copy")}</p>
        </div>
      </header>

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
          result={synthesisMatchesMonth ? synthesisResult : null}
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
              return (
                <article key={snapshot.goal.id} className="schedule-day-group">
                  <div className="schedule-day-group__header">
                    <h3>{snapshot.goal.title}</h3>
                    <span>{snapshot.goal.dimension}</span>
                  </div>
                  <div className="weekly-day-card__metrics">
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
        <div className="weekly-ritual-grid">
          {monthlySections.map((section) => (
            <article key={section.key} className="weekly-ritual-card">
              <div className="weekly-ritual-card__header">
                <div>
                  <h3>{section.title}</h3>
                  <p>{section.subtitle}</p>
                </div>
                <label className="switch-row">
                  <input
                    aria-label={t("monthly.ritual.doneAria", { section: section.title })}
                    type="checkbox"
                    checked={review.ritualChecklist[section.key]}
                    onChange={(event) => {
                      const currentReview = latestReviewRef.current;
                      if (!currentReview) {
                        return;
                      }
                      void saveReview(
                        updateMonthlyReviewChecklist(
                          currentReview,
                          section.key,
                          event.target.checked,
                        ),
                      );
                    }}
                  />
                  <span>{t("monthly.ritual.done")}</span>
                </label>
              </div>
              <p className="empty-copy">{section.prompt}</p>
              <label className="stacked-field">
                <span>{t("monthly.ritual.notesLabel", { section: section.title })}</span>
                <PersistedTextarea
                  ref={(handle) => {
                    noteRefs.current[section.key] = handle;
                  }}
                  key={`${review.monthKey}-${section.key}`}
                  rows={4}
                  debounceMs={0}
                  savedValue={review.notes[section.key]}
                  onPersist={(value) => {
                    const currentReview = latestReviewRef.current;
                    if (!currentReview) {
                      return;
                    }
                    void saveReview(updateMonthlyReviewNote(currentReview, section.key, value));
                  }}
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
