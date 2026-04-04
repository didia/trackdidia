import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { deriveStatusLabel } from "../domain/daily-entry";
import {
  applyWeeklyReviewTransition,
  buildWeekDates,
  createEmptyWeeklyReview,
  updateWeeklyReviewChecklist,
  updateWeeklyReviewNote
} from "../domain/weekly-review";
import type { WeeklyReview, WeeklyReviewSummary, WeeklyRitualSectionKey } from "../domain/types";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateShort, getTodayDate } from "../lib/date";
import { formatPercent, formatTimestamp } from "../lib/format";
import { addDays } from "../lib/gtd/shared";

interface RitualSectionDefinition {
  key: WeeklyRitualSectionKey;
  title: string;
  subtitle: string;
  prompt: string;
  linkTo?: string;
  linkLabel?: string;
}

const ritualSections: RitualSectionDefinition[] = [
  {
    key: "bilan",
    title: "Bilan",
    subtitle: "Achievements, challenges, weekly notes et apprentissages.",
    prompt: "Qu'est-ce qui a marche cette semaine ? Qu'est-ce qui a coince ?"
  },
  {
    key: "budget",
    title: "Budget",
    subtitle: "Reality, stability, resilience, creation et flexibility.",
    prompt: "Que doit faire l'argent avant la prochaine paie et quels ajustements sont necessaires ?"
  },
  {
    key: "tempsEtPlan",
    title: "Temps et plan",
    subtitle: "Time usage, life tracking plan et weekly journal.",
    prompt: "Qu'est-ce que ton temps raconte vraiment et quel cap garder la semaine prochaine ?"
  },
  {
    key: "collecte",
    title: "Collecte",
    subtitle: "Collect and process perso, pro et reseaux sociaux.",
    prompt: "Qu'est-ce qu'il reste a vider, clarifier, deleguer ou archiver ?",
    linkTo: "/inbox",
    linkLabel: "Ouvrir l'inbox"
  },
  {
    key: "calendrier",
    title: "Calendrier",
    subtitle: "Revue du passe recent et du calendrier a venir.",
    prompt: "Y a-t-il des suivis oublies, deadlines ou preparations a lancer ?",
    linkTo: "/scheduled",
    linkLabel: "Voir le calendrier"
  },
  {
    key: "gtd",
    title: "GTD",
    subtitle: "Action lists, waiting-for et projets.",
    prompt: "Chaque projet a-t-il un prochain pas clair ?",
    linkTo: "/next-actions",
    linkLabel: "Voir les next actions"
  },
  {
    key: "alignement",
    title: "Alignement",
    subtitle: "Goals, areas of focus, mission statement et objectifs du mois.",
    prompt: "Ton systeme de la semaine reste-t-il aligne avec ce qui compte vraiment ?",
    linkTo: "/projects",
    linkLabel: "Voir les projets"
  },
  {
    key: "dimanche",
    title: "Dimanche",
    subtitle: "Cloturer la semaine passee et preparer la suivante.",
    prompt: "Quels apprentissages emporter et quel ton poser pour la semaine qui arrive ?",
    linkTo: "/historique",
    linkLabel: "Ouvrir l'historique"
  }
];

const formatWholePercent = (value: number): string => `${Math.round(value)}%`;

const deriveWeeklyStatusLabel = (status: WeeklyReview["status"]): string =>
  status === "closed" ? "Revue cloturee" : "Brouillon";

export const WeeklyReviewPage = () => {
  const { repository } = useAppContext();
  const [selectedWeekStart, setSelectedWeekStart] = useState(buildWeekDates(getTodayDate()));
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [summary, setSummary] = useState<WeeklyReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const latestReviewRef = useRef<WeeklyReview | null>(null);

  const loadWeek = useCallback(
    async (requestedWeekStart: string) => {
      const normalized = buildWeekDates(requestedWeekStart);
      setLoading(true);
      const [existingReview, computedSummary] = await Promise.all([
        repository.getWeeklyReview(normalized),
        repository.computeWeeklyReviewSummary(normalized)
      ]);
      const nextReview = existingReview ?? createEmptyWeeklyReview(normalized);
      latestReviewRef.current = nextReview;
      setSelectedWeekStart(normalized);
      setReview(nextReview);
      setSummary(computedSummary);
      setLoading(false);
    },
    [repository]
  );

  useEffect(() => {
    void loadWeek(selectedWeekStart);
  }, [loadWeek]);

  const saveReview = useCallback(
    async (nextReview: WeeklyReview) => {
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      await repository.saveWeeklyReview(nextReview);
    },
    [repository]
  );

  const hasValidSelectedWeek = useMemo(
    () => /^\d{4}-\d{2}-\d{2}$/.test(selectedWeekStart),
    [selectedWeekStart]
  );
  const weekEndDate = useMemo(
    () => (hasValidSelectedWeek ? addDays(selectedWeekStart, 6) : ""),
    [hasValidSelectedWeek, selectedWeekStart]
  );

  if (loading || !review || !summary) {
    return <div className="page"><p>Chargement de la revue hebdomadaire...</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Semaine</p>
          <h2>
            {formatDateLong(summary.weekStartDate)} au {formatDateLong(summary.weekEndDate)}
          </h2>
          <p className="hero__copy">
            Cloture la semaine passee, lis les signaux du quotidien et prepare la suivante sans perdre le fil.
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
            Semaine precedente
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
            Semaine suivante
          </button>
        </div>
      </header>

      <SectionCard
        title="Choisir la semaine"
        subtitle="La semaine metier suit le rythme dimanche -> samedi, aligne avec ton rituel du dimanche."
      >
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>Debut de semaine</span>
            <input
              aria-label="Debut de semaine"
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
              Charger la semaine
            </button>
            <button className="button" type="button" onClick={() => void loadWeek(buildWeekDates(getTodayDate()))}>
              Revenir a cette semaine
            </button>
          </div>
        </div>
        <p className="empty-copy">
          {hasValidSelectedWeek
            ? `Fenetre courante: ${formatDateShort(selectedWeekStart)} -> ${formatDateShort(weekEndDate)}.`
            : "Saisis un dimanche pour charger une semaine."}
        </p>
      </SectionCard>

      <SectionCard title="Vue d'ensemble" subtitle="Le coeur quantifie de la semaine, calcule a partir du quotidien.">
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>Statut</span>
            <strong>{deriveWeeklyStatusLabel(review.status)}</strong>
          </article>
          <article className="status-card">
            <span>Score hebdo</span>
            <strong>{formatPercent(summary.weeklyScore)}</strong>
          </article>
          <article className="status-card">
            <span>Sommeil moyen</span>
            <strong>{Math.round(summary.sleepAverage)} / 100</strong>
          </article>
          <article className="status-card">
            <span>TRC respecte</span>
            <strong>{summary.trcDaysRespected} / 7</strong>
          </article>
          <article className="status-card">
            <span>Temps d'ecran</span>
            <strong>{summary.screenTimeTotalMinutes} min</strong>
          </article>
          <article className="status-card">
            <span>Pomodoris</span>
            <strong>{summary.pomodorisTotal}</strong>
          </article>
          <article className="status-card">
            <span>Discipline moyenne</span>
            <strong>{formatWholePercent(summary.disciplineAverage * 100)}</strong>
          </article>
          <article className="status-card">
            <span>Taches</span>
            <strong>
              {summary.tasksCompletedTotal} / {summary.tasksAddedTotal}
            </strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard title="Axes automatiques" subtitle="Scores derives des metriques quotidiennes de la semaine.">
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>Sommeil</span>
            <strong>{formatWholePercent(summary.sleepQuality)}</strong>
          </article>
          <article className="status-card">
            <span>Respect TRC</span>
            <strong>{formatWholePercent(summary.respectTrc)}</strong>
          </article>
          <article className="status-card">
            <span>Score temps d'ecran</span>
            <strong>{formatWholePercent(summary.phoneScreenTime)}</strong>
          </article>
          <article className="status-card">
            <span>Score pomodoris</span>
            <strong>{formatWholePercent(summary.pomodoris)}</strong>
          </article>
          <article className="status-card">
            <span>Score discipline</span>
            <strong>{formatWholePercent(summary.discipline)}</strong>
          </article>
          <article className="status-card">
            <span>Taux de completion</span>
            <strong>{formatWholePercent(summary.tasksCompletionRate)}</strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard title="Vue 7 jours" subtitle="Relis la semaine comme une sequence, pas seulement comme une moyenne.">
        <div className="weekly-day-grid">
          {summary.days.map((day) => (
            <article key={day.date} className="schedule-day-group">
              <div className="schedule-day-group__header">
                <h3>{formatDateShort(day.date)}</h3>
                <span>{deriveStatusLabel(day.status)}</span>
              </div>
              <div className="weekly-day-card__metrics">
                <span>Sommeil: {day.sleepQuality === null ? "—" : `${Math.round(day.sleepQuality)} / 100`}</span>
                <span>TRC: {day.trcRespected ? "Oui" : "Non"}</span>
                <span>Ecran: {day.screenTimeMinutes} min</span>
                <span>Pomodoris: {day.pomodoris}</span>
                <span>Discipline: {formatWholePercent(day.disciplineScore * 100)}</span>
                <span>
                  Taches: {day.tasksCompleted}/{day.tasksAdded}
                </span>
              </div>
            </article>
          ))}
        </div>
        <div className="section-actions">
          <Link className="button" to="/historique">
            Ouvrir l'historique quotidien
          </Link>
        </div>
      </SectionCard>

      <SectionCard
        title="Rituel hebdomadaire"
        subtitle="Chaque bloc reste manuel pour l'instant, mais l'ecran rassemble tout ton rituel du dimanche."
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
                    aria-label={`Marquer ${section.title} comme fait`}
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
                  <span>Fait</span>
                </label>
              </div>
              <p className="empty-copy">{section.prompt}</p>
              <label className="stacked-field">
                <span>{`Notes ${section.title}`}</span>
                <PersistedTextarea
                  key={`${review.weekStartDate}-${section.key}`}
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
                  placeholder={`Notes ${section.title.toLowerCase()}...`}
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

      <SectionCard title="Etat de la revue" subtitle="Ferme la revue quand tu as boucle la semaine et pose la suite.">
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>Derniere mise a jour</span>
            <strong>{formatTimestamp(review.updatedAt)}</strong>
          </article>
          <article className="status-card">
            <span>Debut</span>
            <strong>{formatDateLong(summary.weekStartDate)}</strong>
          </article>
          <article className="status-card">
            <span>Fin</span>
            <strong>{formatDateLong(summary.weekEndDate)}</strong>
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
            void saveReview(applyWeeklyReviewTransition(currentReview, "closed"));
          }}
        >
          Cloturer la revue
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
          Reouvrir la revue
        </button>
      </div>
    </div>
  );
};
