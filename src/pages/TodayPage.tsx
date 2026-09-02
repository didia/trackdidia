import { useCallback, useEffect, useRef, useState } from "react";
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

const bucketLabels: Record<Task["bucket"], string> = {
  inbox: "Inbox",
  next_action: "Next Action",
  scheduled: "Scheduled",
  waiting_for: "Waiting For",
  someday_maybe: "Someday / Maybe",
  reference: "References"
};

export const TodayPage = () => {
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
        await save(updateNote(currentEntry, "morningIntention", applied.text));
        morningIntentionRef.current?.setDraft(applied.text);
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

  if (loading || !entry) {
    return <div className="page"><p>Chargement de la journee...</p></div>;
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
          <p className="eyebrow">Aujourd'hui</p>
          <h2>{formatDateLong(entry.date)}</h2>
          <p className="hero__copy">
            Une vue rapide pour ouvrir, tenir et fermer la journee sans casser ton rythme.
          </p>
        </div>
        <div className="hero__actions">
          <Link className="button button--primary" to="/routine-matin">
            Ouvrir le matin
          </Link>
          <Link className="button" to="/fermeture-soir">
            Fermer le soir
          </Link>
        </div>
      </header>

      {browserPreview ? (
        <div className="banner">
          Mode apercu navigateur: le runtime Tauri n'est pas detecte, donc le stockage utilise une memoire temporaire.
        </div>
      ) : null}

      <EntrySummaryStrip entry={entry} />

      {isSunday(entry.date) ? (
        <SectionCard
          title="Rituel du dimanche"
          subtitle="Cloture la semaine passee, note les apprentissages et prepare la suivante."
        >
          <p className="empty-copy">
            La revue hebdomadaire consolide sommeil, TRC, temps d'ecran, pomodoris, discipline et taches avant ton rituel de reset.
          </p>
          <div className="section-actions">
            <Link className="button button--primary" to="/semaine">
              Ouvrir la revue hebdomadaire
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {isFirstSaturdayOfMonth(entry.date) ? (
        <SectionCard
          title="Cloture mensuelle"
          subtitle="Premier samedi du mois: il est temps de relire le mois passe et recalibrer les objectifs."
        >
          <p className="empty-copy">
            La revue mensuelle relie tes semaines, tes journaux et tes objectifs annuels pour voir ce qui nourrit vraiment le prochain mois.
          </p>
          <div className="section-actions">
            <Link className="button button--primary" to="/mois">
              Ouvrir la revue mensuelle
            </Link>
            <Link className="button" to="/objectifs-annuels">
              Ouvrir les objectifs annuels
            </Link>
          </div>
        </SectionCard>
      ) : null}

      <CoachPulsePanel
        title="Coach du jour"
        result={coachResult}
        loading={coachLoading}
        settings={settings}
        autoloadAi
        onRegenerate={() => void loadCoach({ trigger: "explicit", bypassCache: true })}
        onAcceptProposal={(proposal) => void handleAcceptProposal(proposal)}
        onDismissProposal={(proposal) => void handleDismissProposal(proposal)}
      />

      <SectionCard title="Etat de la journee" subtitle="Point de repere avant de replonger dans la routine.">
        <div className="journal-grid">
          <label className="stacked-field">
            <span>Intention du matin</span>
            <PersistedTextarea
              ref={morningIntentionRef}
              rows={4}
              savedValue={entry.morningIntention}
              onPersist={(nextValue) => {
                const current = entryRef.current;
                if (!current) {
                  return;
                }
                void save(updateNote(current, "morningIntention", nextValue));
              }}
              placeholder="Quelle est ton intention pour aujourd'hui ?"
            />
          </label>
          <label className="stacked-field">
            <span>Reflection du soir</span>
            <PersistedTextarea
              rows={4}
              savedValue={entry.nightReflection}
              onPersist={(nextValue) => {
                const current = entryRef.current;
                if (!current) {
                  return;
                }
                void save(updateNote(current, "nightReflection", nextValue));
              }}
              placeholder="Qu'est-ce qui a ete fidele aujourd'hui ?"
            />
          </label>
        </div>
        <div className="status-grid">
          <article className="status-card">
            <span>Mise a jour</span>
            <strong>{formatTimestamp(entry.updatedAt)}</strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard
        title="Pomodoro du jour"
        subtitle="Resume simple de ce qui a ete produit en focus aujourd'hui."
      >
        <div className="pomodoro-widget__summary">
          <article className="status-card">
            <span>Pomodoris completes</span>
            <strong>{completedPomodoroCount}</strong>
          </article>
          <article className="status-card">
            <span>Heures focused</span>
            <strong>{totalFocusedHours} h</strong>
          </article>
          <article className="status-card">
            <span>Taches completees en pomodoro</span>
            <strong>{completedPomodoroTasks.length}</strong>
          </article>
        </div>

        <div className="daily-task-panel">
          <div className="daily-task-panel__header">
            <div>
              <strong>Taches completees pendant une journee avec focus</strong>
              <p>Liste des taches terminees aujourd'hui qui ont recu du temps de pomodoro.</p>
            </div>
          </div>
          {completedPomodoroTasks.length === 0 ? (
            <p className="empty-copy">Aucune tache completee via le flux pomodoro aujourd'hui.</p>
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
            Ouvrir la page Pomodoro
          </Link>
        </div>
      </SectionCard>

      <SectionCard title="Charge GTD du jour" subtitle="Les valeurs viennent du moteur GTD, avec possibilite d'override dans la routine et l'historique.">
        <div className="status-grid">
          <article className="status-card">
            <span>Debut</span>
            <strong>{resolveMetricValue(entry, "tachesDebut") ?? 0}</strong>
          </article>
          <button
            className={`status-card status-card--interactive${openTaskPanel === "added" ? " status-card--active" : ""}`}
            type="button"
            onClick={() => setOpenTaskPanel((current) => (current === "added" ? null : "added"))}
            aria-expanded={openTaskPanel === "added"}
          >
            <span>Ajoutees</span>
            <strong>{resolveMetricValue(entry, "tachesAjoutes") ?? 0}</strong>
          </button>
          <button
            className={`status-card status-card--interactive${openTaskPanel === "completed" ? " status-card--active" : ""}`}
            type="button"
            onClick={() => setOpenTaskPanel((current) => (current === "completed" ? null : "completed"))}
            aria-expanded={openTaskPanel === "completed"}
          >
            <span>Realisees</span>
            <strong>{resolveMetricValue(entry, "tachesRealises") ?? 0}</strong>
          </button>
          <article className="status-card">
            <span>Restantes</span>
            <strong>{resolveMetricValue(entry, "tachesFin") ?? 0}</strong>
          </article>
        </div>

        {openTaskPanel ? (
          <div className="daily-task-panel">
            <div className="daily-task-panel__header">
              <div>
                <strong>{openTaskPanel === "added" ? "Taches ajoutees aujourd'hui" : "Taches completees aujourd'hui"}</strong>
                <p>
                  {visibleTasks.length} tache(s) dans cette vue.
                </p>
              </div>
              <button className="button button--ghost" type="button" onClick={() => setOpenTaskPanel(null)}>
                Fermer
              </button>
            </div>

            {visibleTasks.length === 0 ? (
              <p className="empty-copy">Aucune tache pour ce compteur aujourd'hui.</p>
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
            Ouvrir l'inbox
          </Link>
          <Link className="button" to="/next-actions">
            Voir les next actions
          </Link>
          <Link className="button" to="/scheduled">
            Voir le calendrier
          </Link>
        </div>
      </SectionCard>

    </div>
  );
};
