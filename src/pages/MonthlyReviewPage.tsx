import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  updateMonthlyReviewNote
} from "../domain/monthly-review";
import type { AnnualGoalSnapshot, MonthlyReview, MonthlyReviewSectionKey, MonthlyReviewSummary } from "../domain/types";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, getTodayDate } from "../lib/date";
import { formatPercent } from "../lib/format";
import { formatTimestamp } from "../lib/format";

interface MonthlySectionDefinition {
  key: MonthlyReviewSectionKey;
  title: string;
  subtitle: string;
  prompt: string;
  linkTo?: string;
  linkLabel?: string;
}

const monthlySections: MonthlySectionDefinition[] = [
  {
    key: "bilan",
    title: "Bilan",
    subtitle: "Achievements, challenges et revue du mois.",
    prompt: "Qu'est-ce qui a ete accompli, qu'est-ce qui a freine, et qu'as-tu appris ?"
  },
  {
    key: "journaux",
    title: "Journaux",
    subtitle: "Monthly journal et weekly notes.",
    prompt: "Que racontent les journaux et les notes hebdo une fois relus ensemble ?",
    linkTo: "/semaine",
    linkLabel: "Voir les semaines"
  },
  {
    key: "finances",
    title: "Finances",
    subtitle: "Review last month finances.",
    prompt: "Que dit le mois passe sur l'argent, les tensions et les ajustements ?"
  },
  {
    key: "temps",
    title: "Temps",
    subtitle: "Review last month time usage.",
    prompt: "Ou le temps est-il alle, et etait-ce coherent avec les priorites ?"
  },
  {
    key: "progressionObjectifs",
    title: "Progression des objectifs",
    subtitle: "Reflect on goals and objectives progress.",
    prompt: "Quels objectifs avancent, lesquels stagnent, et pourquoi ?",
    linkTo: "/objectifs-annuels",
    linkLabel: "Ouvrir les objectifs annuels"
  },
  {
    key: "missionObjectifs",
    title: "Mission et objectifs",
    subtitle: "Review mission statement, goals and objectives.",
    prompt: "Faut-il recalibrer le systeme ou juste mieux l'executer ?"
  },
  {
    key: "nettoyageListes",
    title: "Nettoyage des listes",
    subtitle: "Clean up and update GTD lists.",
    prompt: "Quelles listes doivent etre nettoyees, fermees ou relancees ?",
    linkTo: "/projects",
    linkLabel: "Voir Projects"
  },
  {
    key: "calendrier",
    title: "Calendrier",
    subtitle: "Review past month and preview next month.",
    prompt: "Quels loose ends, deadlines ou engagements dois-tu absorber maintenant ?",
    linkTo: "/scheduled",
    linkLabel: "Ouvrir Scheduled"
  },
  {
    key: "grosProjets",
    title: "Gros projets",
    subtitle: "Plan for big projects.",
    prompt: "Quels gros chantiers doivent etre decomposes ou bloques au calendrier ?",
    linkTo: "/next-actions",
    linkLabel: "Voir Next Actions"
  },
  {
    key: "developpement",
    title: "Developpement personnel",
    subtitle: "Learning, skills and growth areas.",
    prompt: "Quelles competences veux-tu nourrir le mois prochain et comment ?"
  }
];

const deriveMonthlyStatusLabel = (status: MonthlyReview["status"]): string =>
  status === "closed" ? "Revue cloturee" : "Brouillon";

export const MonthlyReviewPage = () => {
  const { repository } = useAppContext();
  const today = getTodayDate();
  const initialMonth = isFirstSaturdayOfMonth(today) ? getPreviousMonthKey(today) : getMonthKey(today);
  const [selectedMonthKey, setSelectedMonthKey] = useState(initialMonth);
  const [review, setReview] = useState<MonthlyReview | null>(null);
  const [summary, setSummary] = useState<MonthlyReviewSummary | null>(null);
  const [goalSnapshots, setGoalSnapshots] = useState<AnnualGoalSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const latestReviewRef = useRef<MonthlyReview | null>(null);

  const loadMonth = useCallback(
    async (requestedMonthKey: string) => {
      if (!/^\d{4}-\d{2}$/.test(requestedMonthKey)) {
        return;
      }

      setLoading(true);
      const [existingReview, computedSummary, annualSnapshots] = await Promise.all([
        repository.getMonthlyReview(requestedMonthKey),
        repository.computeMonthlyReviewSummary(requestedMonthKey),
        repository.computeAnnualGoalSnapshots(Number(requestedMonthKey.slice(0, 4)))
      ]);
      const nextReview = existingReview ?? createEmptyMonthlyReview(requestedMonthKey);
      latestReviewRef.current = nextReview;
      setSelectedMonthKey(requestedMonthKey);
      setReview(nextReview);
      setSummary(computedSummary);
      setGoalSnapshots(annualSnapshots);
      setLoading(false);
    },
    [repository]
  );

  useEffect(() => {
    void loadMonth(selectedMonthKey);
  }, [loadMonth]);

  const saveReview = useCallback(
    async (nextReview: MonthlyReview) => {
      latestReviewRef.current = nextReview;
      setReview(nextReview);
      await repository.saveMonthlyReview(nextReview);
    },
    [repository]
  );

  const selectedGoalSnapshots = useMemo(
    () => goalSnapshots.filter((snapshot) => snapshot.monthlyProgress.some((point) => point.monthKey === selectedMonthKey)),
    [goalSnapshots, selectedMonthKey]
  );

  if (loading || !review || !summary) {
    return <div className="page"><p>Chargement de la revue mensuelle...</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Mois</p>
          <h2>
            {formatDateLong(summary.monthStartDate)} au {formatDateLong(summary.monthEndDate)}
          </h2>
          <p className="hero__copy">
            Reprends le mois dans son ensemble, boucle la trajectoire et prepare le suivant avec plus de clarte.
          </p>
        </div>
      </header>

      <SectionCard
        title="Choisir le mois"
        subtitle="La cloture mensuelle se fait idealement le premier samedi du mois suivant."
      >
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>Mois a relire</span>
            <input
              aria-label="Mois a relire"
              type="month"
              value={selectedMonthKey}
              onChange={(event) => setSelectedMonthKey(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="button" type="button" onClick={() => void loadMonth(selectedMonthKey)}>
              Charger le mois
            </button>
            <button className="button" type="button" onClick={() => void loadMonth(initialMonth)}>
              Revenir au mois courant
            </button>
          </div>
        </div>
        <p className="empty-copy">
          Fenetre courante: {getMonthStartDate(selectedMonthKey)} {"->"} {getMonthEndDate(selectedMonthKey)}.
        </p>
      </SectionCard>

      <SectionCard title="Synthese mensuelle" subtitle="Les chiffres du mois calcules depuis le quotidien et les semaines.">
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>Statut</span>
            <strong>{deriveMonthlyStatusLabel(review.status)}</strong>
          </article>
          <article className="status-card">
            <span>Jours tracés</span>
            <strong>{summary.daysTracked}</strong>
          </article>
          <article className="status-card">
            <span>Semaines couvertes</span>
            <strong>{summary.weeksCovered}</strong>
          </article>
          <article className="status-card">
            <span>Revues hebdo cloturees</span>
            <strong>{summary.weeklyReviewsCompleted}</strong>
          </article>
          <article className="status-card">
            <span>Sommeil moyen</span>
            <strong>{Math.round(summary.sleepAverage)} / 100</strong>
          </article>
          <article className="status-card">
            <span>TRC</span>
            <strong>{Math.round(summary.trcRate)}%</strong>
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
            <strong>{Math.round(summary.disciplineAverage * 100)}%</strong>
          </article>
          <article className="status-card">
            <span>Completion taches</span>
            <strong>{Math.round(summary.tasksCompletionRate)}%</strong>
          </article>
          <article className="status-card">
            <span>Score hebdo moyen</span>
            <strong>{formatPercent(summary.weeklyScoreAverage)}</strong>
          </article>
        </div>
      </SectionCard>

      <SectionCard title="Semaines du mois" subtitle="Relis les semaines pour reconnecter les notes hebdo au tableau d'ensemble.">
        <div className="weekly-day-grid">
          {summary.weeks.map((week) => (
            <article key={week.weekStartDate} className="schedule-day-group">
              <div className="schedule-day-group__header">
                <h3>{week.weekStartDate}</h3>
                <span>{week.reviewStatus === "missing" ? "Pas de revue" : week.reviewStatus === "closed" ? "Cloturee" : "Brouillon"}</span>
              </div>
              <div className="weekly-day-card__metrics">
                <span>Fin: {week.weekEndDate}</span>
                <span>Score: {formatPercent(week.weeklyScore)}</span>
                <span>Notes: {week.noteCount}</span>
              </div>
            </article>
          ))}
        </div>
        <div className="section-actions">
          <Link className="button" to="/semaine">
            Ouvrir la revue hebdomadaire
          </Link>
        </div>
      </SectionCard>

      <SectionCard
        title="Objectifs annuels"
        subtitle="Le mois doit te montrer ce qui nourrit vraiment les objectifs, pas seulement ce qui a rempli les cases."
      >
        <div className="weekly-day-grid">
          {selectedGoalSnapshots.length === 0 ? (
            <p className="empty-copy">Aucun objectif annuel relie pour l'instant.</p>
          ) : (
            selectedGoalSnapshots.map((snapshot) => {
              const monthPoint = snapshot.monthlyProgress.find((point) => point.monthKey === selectedMonthKey) ?? null;
              const evaluation = snapshot.goal.evaluations[selectedMonthKey] ?? null;
              return (
                <article key={snapshot.goal.id} className="schedule-day-group">
                  <div className="schedule-day-group__header">
                    <h3>{snapshot.goal.title}</h3>
                    <span>{snapshot.goal.dimension}</span>
                  </div>
                  <div className="weekly-day-card__metrics">
                    <span>Actuel: {snapshot.currentValue === null ? "—" : `${Math.round(snapshot.currentValue)} ${snapshot.goal.unit}`.trim()}</span>
                    <span>Cible: {snapshot.goal.targetValue === null ? "—" : `${snapshot.goal.targetValue} ${snapshot.goal.unit}`.trim()}</span>
                    <span>Mois: {monthPoint?.value === null || monthPoint?.value === undefined ? "—" : `${Math.round(monthPoint.value)} ${snapshot.goal.unit}`.trim()}</span>
                    <span>Evaluation: {evaluation?.score === null || evaluation?.score === undefined ? "—" : `${evaluation.score}/100`}</span>
                  </div>
                </article>
              );
            })
          )}
        </div>
        <div className="section-actions">
          <Link className="button button--primary" to="/objectifs-annuels">
            Gerer les objectifs annuels
          </Link>
        </div>
      </SectionCard>

      <SectionCard
        title="Rituel mensuel"
        subtitle="Les blocs ci-dessous reprennent ta revue mensuelle de facon structuree, avec notes courtes et etat fait / pas fait."
      >
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
                    aria-label={`Marquer ${section.title} comme fait`}
                    type="checkbox"
                    checked={review.ritualChecklist[section.key]}
                    onChange={(event) => {
                      const currentReview = latestReviewRef.current;
                      if (!currentReview) {
                        return;
                      }
                      void saveReview(updateMonthlyReviewChecklist(currentReview, section.key, event.target.checked));
                    }}
                  />
                  <span>Fait</span>
                </label>
              </div>
              <p className="empty-copy">{section.prompt}</p>
              <label className="stacked-field">
                <span>{`Notes ${section.title}`}</span>
                <PersistedTextarea
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

      <SectionCard title="Etat de la revue" subtitle="Cloture le mois une fois la boucle faite et le suivant clarifie.">
        <div className="weekly-overview-grid">
          <article className="status-card">
            <span>Derniere mise a jour</span>
            <strong>{formatTimestamp(review.updatedAt)}</strong>
          </article>
          <article className="status-card">
            <span>Debut</span>
            <strong>{summary.monthStartDate}</strong>
          </article>
          <article className="status-card">
            <span>Fin</span>
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
          Cloturer la revue du mois
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
          Reouvrir la revue
        </button>
      </div>
    </div>
  );
};
