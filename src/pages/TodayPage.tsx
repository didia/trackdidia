import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { useDailyEntry } from "../app/use-daily-entry";
import { usePastorVerse } from "../app/use-pastor-verse";
import { CoachPulsePanel } from "../components/CoachPulsePanel";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { PastorVerseCard } from "../components/PastorVerseCard";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { resolveMetricValue, updateNote } from "../domain/daily-entry";
import { getDefaultMonthlyReviewMonthKey, isFirstSaturdayOfMonth } from "../domain/monthly-review";
import { getDefaultWeeklyReviewWeekStart } from "../domain/weekly-review";
import type { AiProposal, CoachPulseResult } from "../domain/types";
import { loadLatestCoachPulseForDate } from "../lib/ai/coach-pulse-loader";
import { resolveDailySnapshotInputs } from "../lib/ai/context/preview";
import { applyCoachProposal } from "../lib/ai/proposals/apply-proposal";
import { formatDateLong, formatDateTimeShort, getTodayDate } from "../lib/date";
import { formatTimestamp } from "../lib/format";
import { bucketLabelKeys } from "../lib/gtd/labels";
import { getWeekStartSunday, isSunday, isWednesday } from "../lib/gtd/shared";
import type { DailyTaskBreakdown } from "../lib/storage/repository";

export const TodayPage = () => {
  const { t } = useTranslation("today");
  const today = getTodayDate();
  const { entry, loading, save } = useDailyEntry(today);
  const {
    repository,
    settings,
    syncSettings,
    coachService,
    browserPreview,
    pomodoro,
    pulseRevision,
  } = useAppContext();
  const pastorVerse = usePastorVerse(today, settings, repository, syncSettings);
  const [coachResult, setCoachResult] = useState<CoachPulseResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(true);
  const [taskBreakdown, setTaskBreakdown] = useState<DailyTaskBreakdown | null>(null);
  const [openTaskPanel, setOpenTaskPanel] = useState<"added" | "completed" | null>(null);
  const entryRef = useRef(entry);
  const morningIntentionRef = useRef<PersistedTextareaHandle>(null);
  const passiveRequestIdRef = useRef(0);
  const explicitRequestIdRef = useRef(0);
  const explicitInFlightRef = useRef(false);
  entryRef.current = entry;

  const isCurrentPassiveRequest = (requestId: number) =>
    requestId === passiveRequestIdRef.current && !explicitInFlightRef.current;

  const loadCoachFromStore = useCallback(async () => {
    const currentEntry = entryRef.current;
    if (!currentEntry || explicitInFlightRef.current) {
      return;
    }

    const requestId = ++passiveRequestIdRef.current;
    setCoachLoading(true);
    try {
      const stored = await loadLatestCoachPulseForDate(repository, coachService, currentEntry.date);
      if (!isCurrentPassiveRequest(requestId)) {
        return;
      }
      if (stored) {
        setCoachResult(stored);
        return;
      }

      const fastInputs = await resolveDailySnapshotInputs(
        repository,
        currentEntry.date,
        new Date().toISOString(),
        undefined,
        { skipRescueTimeFetch: true, entry: currentEntry },
      );
      const localResult = await coachService.buildPulse(repository, {
        stance: "open",
        entry: currentEntry,
        settings,
        snapshotInputs: fastInputs,
        trigger: "auto",
        localOnly: true,
      });
      if (!isCurrentPassiveRequest(requestId)) {
        return;
      }
      setCoachResult(localResult);

      // Scheduled pulses own persistence when the pulse engine is enabled.
      if (settings.aiPulseEnabled) {
        return;
      }

      if (!settings.aiEnabled || !settings.aiApiKey.trim()) {
        return;
      }

      const fullInputs = await resolveDailySnapshotInputs(
        repository,
        currentEntry.date,
        new Date().toISOString(),
        undefined,
        { entry: currentEntry },
      );
      const aiResult = await coachService.buildPulse(repository, {
        stance: "open",
        entry: currentEntry,
        settings,
        snapshotInputs: fullInputs,
        trigger: "auto",
      });
      if (!isCurrentPassiveRequest(requestId)) {
        return;
      }
      setCoachResult(aiResult);
    } catch (error) {
      console.error("Failed to load coach pulse", error);
    } finally {
      if (isCurrentPassiveRequest(requestId)) {
        setCoachLoading(false);
      }
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

      const requestId = ++explicitRequestIdRef.current;
      explicitInFlightRef.current = true;
      setCoachLoading(true);
      try {
        const snapshotInputs = await resolveDailySnapshotInputs(
          repository,
          currentEntry.date,
          new Date().toISOString(),
          undefined,
          { skipRescueTimeFetch: options.skipRescueTimeFetch ?? false, entry: currentEntry },
        );
        const latest = await loadLatestCoachPulseForDate(
          repository,
          coachService,
          currentEntry.date,
        );
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
          slotHour: Number.isFinite(slotHour) ? slotHour : undefined,
        });
        if (requestId !== explicitRequestIdRef.current) {
          return;
        }
        setCoachResult(result);
      } catch (error) {
        console.error("Failed to load coach pulse", error);
      } finally {
        if (requestId === explicitRequestIdRef.current) {
          explicitInFlightRef.current = false;
          setCoachLoading(false);
        }
      }
    },
    [coachService, repository, settings],
  );

  const entryDate = entry?.date;
  useEffect(() => {
    if (!entryDate) {
      return;
    }

    if (explicitInFlightRef.current) {
      return;
    }

    void loadCoachFromStore();
  }, [entryDate, loadCoachFromStore, pulseRevision]);

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
          applied.memoryId ?? currentEntry.date,
        );
      }
      setCoachResult((current) =>
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
              item.id === proposal.id
                ? { ...item, status: "dismissed", decidedAt: new Date().toISOString() }
                : item,
            ),
          }
        : current,
    );
  };

  if (loading || !entry) {
    return (
      <div className="page">
        <p>{t("loading")}</p>
      </div>
    );
  }

  const visibleTasks =
    openTaskPanel === "added"
      ? (taskBreakdown?.addedTasks ?? [])
      : openTaskPanel === "completed"
        ? (taskBreakdown?.completedTasks ?? [])
        : [];
  const completedPomodoroCount = pomodoro.sessions.filter(
    (session) => session.kind === "focus" && session.status === "completed",
  ).length;
  const totalFocusedSeconds = pomodoro.taskSummaries.reduce(
    (sum, summary) => sum + summary.totalSeconds,
    0,
  );
  const totalFocusedHours = (totalFocusedSeconds / 3600).toFixed(1);
  const completedPomodoroTasks = (taskBreakdown?.completedTasks ?? []).filter((task) =>
    pomodoro.taskSummaries.some((summary) => summary.taskId === task.id),
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow={t("hero.eyebrow")}
        title={formatDateLong(entry.date)}
        copy={t("hero.copy")}
        actions={
          <>
            <Link className="button button--primary" to="/routine-matin">
              {t("hero.openMorning")}
            </Link>
            <Link className="button" to="/fermeture-soir">
              {t("hero.closeEvening")}
            </Link>
          </>
        }
      />

      {browserPreview ? <div className="banner">{t("banner.browserPreview")}</div> : null}

      <EntrySummaryStrip entry={entry} />

      {isSunday(entry.date) ? (
        <SectionCard title={t("sunday.title")} subtitle={t("sunday.subtitle")}>
          <p className="empty-copy">{t("sunday.body")}</p>
          <div className="section-actions">
            <Link
              className="button button--primary"
              to={`/semaine?date=${getDefaultWeeklyReviewWeekStart(entry.date)}`}
            >
              {t("sunday.openWeekly")}
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {isWednesday(entry.date) ? (
        <SectionCard title={t("wednesday.title")} subtitle={t("wednesday.subtitle")}>
          <p className="empty-copy">{t("wednesday.body")}</p>
          <div className="section-actions">
            <Link
              className="button button--primary"
              to={`/semaine?date=${getWeekStartSunday(entry.date)}`}
            >
              {t("wednesday.openWeekly")}
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {isFirstSaturdayOfMonth(entry.date) ? (
        <SectionCard title={t("monthly.title")} subtitle={t("monthly.subtitle")}>
          <p className="empty-copy">{t("monthly.body")}</p>
          <div className="section-actions">
            <Link
              className="button button--primary"
              to={`/mois?month=${getDefaultMonthlyReviewMonthKey(entry.date)}`}
            >
              {t("monthly.openMonthly")}
            </Link>
            <Link className="button" to="/objectifs-annuels">
              {t("monthly.openGoals")}
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {settings.aiPastorEnabled ? (
        <PastorVerseCard
          title={t("pastor.title")}
          result={pastorVerse.result}
          loading={pastorVerse.loading}
          regenerating={pastorVerse.regenerating}
          settings={settings}
          aiConfigured={pastorVerse.aiConfigured}
          onRegenerate={() => void pastorVerse.regenerate()}
          onAddToCatalog={() => void pastorVerse.addToCatalog()}
          addingToCatalog={pastorVerse.addingToCatalog}
          addedToCatalog={pastorVerse.addedToCatalog}
          addToCatalogError={pastorVerse.addToCatalogError}
        />
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

      <SectionCard title={t("pomodoro.title")} subtitle={t("pomodoro.subtitle")}>
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
            onClick={() =>
              setOpenTaskPanel((current) => (current === "completed" ? null : "completed"))
            }
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
                <strong>
                  {openTaskPanel === "added"
                    ? t("gtd.addedPanelTitle")
                    : t("gtd.completedPanelTitle")}
                </strong>
                <p>{t("gtd.panelCount", { count: visibleTasks.length })}</p>
              </div>
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setOpenTaskPanel(null)}
              >
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
                      {t(bucketLabelKeys[task.bucket])}
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
