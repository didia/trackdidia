import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AiProposal, CoachPulseResult, Task } from "../domain/types";
import { resolveMetricValue, updateNote } from "../domain/daily-entry";
import { useAppContext } from "../app/app-context";
import { useDailyEntry } from "../app/use-daily-entry";
import { CoachPulsePanel } from "../components/CoachPulsePanel";
import { applyCoachProposal } from "../lib/ai/proposals/apply-proposal";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { resolveDailySnapshotInputs } from "../lib/ai/context/preview";
import { loadLatestCoachPulseForDate } from "../lib/ai/coach-pulse-loader";
import { formatDateLong, formatDateTimeShort, getTodayDate } from "../lib/date";
import { formatTimestamp } from "../lib/format";
import type { DailyTaskBreakdown } from "../lib/storage/repository";
import { isSunday } from "../lib/gtd/shared";
import { isFirstSaturdayOfMonth } from "../domain/monthly-review";

export const TodayPage = () => {
  const { t } = useTranslation("today");
  const today = getTodayDate();
  const { entry, loading, save } = useDailyEntry(today);
  const { repository, settings, coachService, browserPreview, pomodoro, pulseRevision } = useAppContext();
  const [coachResult, setCoachResult] = useState<CoachPulseResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(true);
  const [taskBreakdown, setTaskBreakdown] = useState<DailyTaskBreakdown | null>(null);
  const [openTaskPanel, setOpenTaskPanel] = useState<"added" | "completed" | null>(null);
  const entryRef = useRef(entry);
  const morningIntentionRef = useRef<PersistedTextareaHandle>(null);
  entryRef.current = entry;

  const loadCoachFromStore = useCallback(async () => {
    const currentEntry = entryRef.current;
    if (!currentEntry) {
      return;
    }

    setCoachLoading(true);
    try {
      const stored = await loadLatestCoachPulseForDate(repository, coachService, currentEntry.date);
      if (stored) {
        setCoachResult(stored);
        return;
      }

      const fastInputs = await resolveDailySnapshotInputs(
        repository,
        currentEntry.date,
        new Date().toISOString(),
        undefined,
        { skipRescueTimeFetch: true }
      );
      const localResult = await coachService.buildPulse(repository, {
        stance: "open",
        entry: currentEntry,
        settings,
        snapshotInputs: fastInputs,
        trigger: "auto",
        localOnly: true
      });
      setCoachResult(localResult);

      // Scheduled pulses own persistence when the pulse engine is enabled.
      if (settings.aiPulseEnabled) {
        return;
      }

      if (!settings.aiEnabled || !settings.aiApiKey.trim()) {
        return;
      }

      const fullInputs = await resolveDailySnapshotInputs(repository, currentEntry.date);
      const aiResult = await coachService.buildPulse(repository, {
        stance: "open",
        entry: currentEntry,
        settings,
        snapshotInputs: fullInputs,
        trigger: "auto"
      });
      setCoachResult(aiResult);
    } catch (error) {
      console.error("Failed to load coach pulse", error);
    } finally {
      setCoachLoading(false);
    }
  }, [coachService, repository, settings]);

  const loadCoach = useCallback(
    async (options: {
      trigger: "auto" | "explicit";
      bypassCache?: boolean;
      skipRescueTimeFetch?: boolean;
      stance?: CoachPulseResult["pulse"]["stance"];
      slotHour?: number;
    }) => {
      const currentEntry = entryRef.current;
      if (!currentEntry) {
        return;
      }

      setCoachLoading(true);
      try {
        const snapshotInputs = await resolveDailySnapshotInputs(
          repository,
          currentEntry.date,
          new Date().toISOString(),
          undefined,
          { skipRescueTimeFetch: options.skipRescueTimeFetch ?? false }
        );
        const latest = await loadLatestCoachPulseForDate(repository, coachService, currentEntry.date);
        const stance = options.stance ?? latest?.pulse.stance ?? "open";
        const slotHour =
          options.slotHour ??
          (latest?.message.scopeKey.includes("#")
            ? Number(latest.message.scopeKey.split("#")[1])
            : undefined);

        const result = await coachService.buildPulse(repository, {
          stance,
          entry: currentEntry,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache ?? false,
          slotHour: Number.isFinite(slotHour) ? slotHour : undefined
        });
        setCoachResult(result);
      } catch (error) {
        console.error("Failed to load coach pulse", error);
      } finally {
        setCoachLoading(false);
      }
    },
    [coachService, repository, settings]
  );

  useEffect(() => {
    if (!entry) {
      return;
    }

    void loadCoachFromStore();
  }, [entry?.date, loadCoachFromStore, pulseRevision]);

  useEffect(() => {
    if (!entry) {
      return;
    }

    let cancelled = false;

    const loadBreakdown = async () => {
      const breakdown = await repository.getDailyTaskBreakdown(entry.date);
      if (!cancelled) {
        setTaskBreakdown(breakdown);
      }
    };

    void loadBreakdown();

    return () => {
      cancelled = true;
    };
  }, [entry, repository]);

  const handleAcceptProposal = async (proposal: AiProposal) => {
    const currentEntry = entryRef.current;
    if (!currentEntry) {
      return;
    }

    try {
      const applied = await applyCoachProposal(repository, proposal, currentEntry.date);

      if (proposal.type === "intention_draft" && applied.text !== undefined) {
        const intention = applied.text;
        await save((latest) => updateNote(latest, "morningIntention", intention));
        morningIntentionRef.current?.setDraft(intention);
      }

      if (!applied.proposalDecided) {
        await repository.decideAiProposal(
          proposal.id,
          "accepted",
          applied.memoryId ?? currentEntry.date
        );
      }
      setCoachResult((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.id === proposal.id ? { ...item, status: "accepted", decidedAt: new Date().toISOString() } : item
              )
            }
          : current
      );
    } catch (error) {
      console.error("Failed to accept coach proposal", error);
    }
  };

  const handleDismissProposal = async (proposal: AiProposal) => {
    await repository.decideAiProposal(proposal.id, "dismissed");
    setCoachResult((current) =>
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

  const bucketLabels: Record<Task["bucket"], string> = {
    inbox: t("buckets.inbox"),
    next_action: t("buckets.nextAction"),
    scheduled: t("buckets.scheduled"),
    waiting_for: t("buckets.waitingFor"),
    someday_maybe: t("buckets.somedayMaybe"),
    reference: t("buckets.reference")
  };

  if (loading || !entry) {
    return <div className="page"><p>{t("loading")}</p></div>;
  }

  const visibleTasks =
    openTaskPanel === "added"
      ? taskBreakdown?.addedTasks ?? []
      : openTaskPanel === "completed"
        ? taskBreakdown?.completedTasks ?? []
        : [];
  const completedPomodoroCount = pomodoro.sessions.filter(
    (session) => session.kind === "focus" && session.status === "completed"
  ).length;
  const totalFocusedSeconds = pomodoro.taskSummaries.reduce((sum, summary) => sum + summary.totalSeconds, 0);
  const totalFocusedHours = (totalFocusedSeconds / 3600).toFixed(1);
  const completedPomodoroTasks = (taskBreakdown?.completedTasks ?? []).filter((task) =>
    pomodoro.taskSummaries.some((summary) => summary.taskId === task.id)
  );

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{formatDateLong(entry.date)}</h2>
          <p className="hero__copy">
            {t("hero.copy")}
          </p>
        </div>
        <div className="hero__actions">
          <Link className="button button--primary" to="/routine-matin">
            {t("hero.openMorning")}
          </Link>
          <Link className="button" to="/fermeture-soir">
            {t("hero.closeEvening")}
          </Link>
        </div>
      </header>

      {browserPreview ? (
        <div className="banner">
          {t("banner.browserPreview")}
        </div>
      ) : null}

      <EntrySummaryStrip entry={entry} />

      {isSunday(entry.date) ? (
        <SectionCard
          title={t("sunday.title")}
          subtitle={t("sunday.subtitle")}
        >
          <p className="empty-copy">
            {t("sunday.body")}
          </p>
          <div className="section-actions">
            <Link className="button button--primary" to="/semaine">
              {t("sunday.openWeekly")}
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {isFirstSaturdayOfMonth(entry.date) ? (
        <SectionCard
          title={t("monthly.title")}
          subtitle={t("monthly.subtitle")}
        >
          <p className="empty-copy">
            {t("monthly.body")}
          </p>
          <div className="section-actions">
            <Link className="button button--primary" to="/mois">
              {t("monthly.openMonthly")}
            </Link>
            <Link className="button" to="/objectifs-annuels">
              {t("monthly.openGoals")}
            </Link>
          </div>
        </SectionCard>
      ) : null}

      <CoachPulsePanel
        title={t("coachTitle")}
        result={coachResult}
        loading={coachLoading}
        settings={settings}
        autoloadAi
        onRegenerate={() => void loadCoach({ trigger: "explicit", bypassCache: true })}
        onAcceptProposal={(proposal) => void handleAcceptProposal(proposal)}
        onDismissProposal={(proposal) => void handleDismissProposal(proposal)}
      />

      <SectionCard title={t("state.title")} subtitle={t("state.subtitle")}>
        <div className="journal-grid">
          <label className="stacked-field">
            <span>{t("state.morningIntention")}</span>
            <PersistedTextarea
              ref={morningIntentionRef}
              rows={4}
              savedValue={entry.morningIntention}
              onPersist={(nextValue) => {
                void save((current) => updateNote(current, "morningIntention", nextValue));
              }}
              placeholder={t("state.morningPlaceholder")}
            />
          </label>
          <label className="stacked-field">
            <span>{t("state.nightReflection")}</span>
            <PersistedTextarea
              rows={4}
              savedValue={entry.nightReflection}
              onPersist={(nextValue) => {
                void save((current) => updateNote(current, "nightReflection", nextValue));
              }}
              placeholder={t("state.nightPlaceholder")}
            />
          </label>
        </div>
        <div className="status-grid">
          <article className="status-card">
            <span>{t("state.updatedAt")}</span>
            <strong>{formatTimestamp(entry.updatedAt)}</strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard
        title={t("pomodoro.title")}
        subtitle={t("pomodoro.subtitle")}
      >
        <div className="pomodoro-widget__summary">
          <article className="status-card">
            <span>{t("pomodoro.completedCount")}</span>
            <strong>{completedPomodoroCount}</strong>
          </article>
          <article className="status-card">
            <span>{t("pomodoro.focusedHours")}</span>
            <strong>{t("pomodoro.hoursUnit", { n: totalFocusedHours })}</strong>
          </article>
          <article className="status-card">
            <span>{t("pomodoro.tasksCompleted")}</span>
            <strong>{completedPomodoroTasks.length}</strong>
          </article>
        </div>

        <div className="daily-task-panel">
          <div className="daily-task-panel__header">
            <div>
              <strong>{t("pomodoro.completedPanelTitle")}</strong>
              <p>{t("pomodoro.completedPanelCopy")}</p>
            </div>
          </div>
          {completedPomodoroTasks.length === 0 ? (
            <p className="empty-copy">{t("pomodoro.completedPanelEmpty")}</p>
          ) : (
            <div className="pomodoro-history__segments">
              {completedPomodoroTasks.map((task) => (
                <span key={task.id} className="tag-chip">
                  {task.title}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="section-actions">
          <Link className="button" to="/pomodoro">
            {t("pomodoro.openPage")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("gtd.title")} subtitle={t("gtd.subtitle")}>
        <div className="status-grid">
          <article className="status-card">
            <span>{t("gtd.start")}</span>
            <strong>{resolveMetricValue(entry, "tachesDebut") ?? 0}</strong>
          </article>
          <button
            className={`status-card status-card--interactive${openTaskPanel === "added" ? " status-card--active" : ""}`}
            type="button"
            onClick={() => setOpenTaskPanel((current) => (current === "added" ? null : "added"))}
            aria-expanded={openTaskPanel === "added"}
          >
            <span>{t("gtd.added")}</span>
            <strong>{resolveMetricValue(entry, "tachesAjoutes") ?? 0}</strong>
          </button>
          <button
            className={`status-card status-card--interactive${openTaskPanel === "completed" ? " status-card--active" : ""}`}
            type="button"
            onClick={() => setOpenTaskPanel((current) => (current === "completed" ? null : "completed"))}
            aria-expanded={openTaskPanel === "completed"}
          >
            <span>{t("gtd.completed")}</span>
            <strong>{resolveMetricValue(entry, "tachesRealises") ?? 0}</strong>
          </button>
          <article className="status-card">
            <span>{t("gtd.remaining")}</span>
            <strong>{resolveMetricValue(entry, "tachesFin") ?? 0}</strong>
          </article>
        </div>

        {openTaskPanel ? (
          <div className="daily-task-panel">
            <div className="daily-task-panel__header">
              <div>
                <strong>{openTaskPanel === "added" ? t("gtd.addedPanelTitle") : t("gtd.completedPanelTitle")}</strong>
                <p>
                  {t("gtd.panelCount", { count: visibleTasks.length })}
                </p>
              </div>
              <button className="button button--ghost" type="button" onClick={() => setOpenTaskPanel(null)}>
                {t("gtd.panelClose")}
              </button>
            </div>

            {visibleTasks.length === 0 ? (
              <p className="empty-copy">{t("gtd.panelEmpty")}</p>
            ) : (
              <div className="daily-task-list">
                {visibleTasks.map((task) => (
                  <article key={`${openTaskPanel}-${task.id}`} className="daily-task-item">
                    <strong>{task.title}</strong>
                    <span>
                      {bucketLabels[task.bucket]}
                      {task.scheduledFor ? ` • ${formatDateTimeShort(task.scheduledFor)}` : ""}
                    </span>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <div className="section-actions">
          <Link className="button" to="/inbox">
            {t("gtd.openInbox")}
          </Link>
          <Link className="button" to="/next-actions">
            {t("gtd.openNextActions")}
          </Link>
          <Link className="button" to="/scheduled">
            {t("gtd.openScheduled")}
          </Link>
        </div>
      </SectionCard>

    </div>
  );
};
