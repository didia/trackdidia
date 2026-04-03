import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CoachMessage, Task } from "../domain/types";
import { resolveMetricValue } from "../domain/daily-entry";
import { useAppContext } from "../app/app-context";
import { useDailyEntry } from "../app/use-daily-entry";
import { CoachCard } from "../components/CoachCard";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateTimeShort, getTodayDate } from "../lib/date";
import { formatTimestamp } from "../lib/format";
import type { DailyTaskBreakdown } from "../lib/storage/repository";

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
  const { entry, loading } = useDailyEntry(today);
  const { repository, settings, coachService, browserPreview, pomodoro } = useAppContext();
  const [morningCoach, setMorningCoach] = useState<CoachMessage | null>(null);
  const [eveningCoach, setEveningCoach] = useState<CoachMessage | null>(null);
  const [taskBreakdown, setTaskBreakdown] = useState<DailyTaskBreakdown | null>(null);
  const [openTaskPanel, setOpenTaskPanel] = useState<"added" | "completed" | null>(null);

  useEffect(() => {
    if (!entry) {
      return;
    }

    let cancelled = false;

    const loadCoach = async () => {
      const recentEntries = await repository.listDailyEntries(7);
      const [morning, evening] = await Promise.all([
        coachService.buildMessage("morning", entry, recentEntries, settings),
        coachService.buildMessage("evening", entry, recentEntries, settings)
      ]);

      if (!cancelled) {
        setMorningCoach(morning);
        setEveningCoach(evening);
      }
    };

    void loadCoach();

    return () => {
      cancelled = true;
    };
  }, [coachService, entry, repository, settings]);

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

      <div className="two-column">
        <CoachCard message={morningCoach} />
        <CoachCard message={eveningCoach} />
      </div>

      <SectionCard title="Etat de la journee" subtitle="Point de repere avant de replonger dans la routine.">
        <div className="status-grid">
          <article className="status-card">
            <span>Intention du matin</span>
            <strong>{entry.morningIntention || "Pas encore definie"}</strong>
          </article>
          <article className="status-card">
            <span>Reflection du soir</span>
            <strong>{entry.nightReflection || "Pas encore ecrite"}</strong>
          </article>
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
