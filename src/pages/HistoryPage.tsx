import { useEffect, useState } from "react";
import {
  applyDailyPomodoroStats,
  applyRoutineTransition,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  autoSuggestedMetricKeys,
  deriveStatusLabel,
  updateMetric,
  updateNote,
  updatePrinciple
} from "../domain/daily-entry";
import type { DailyEntry } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateShort, getTodayDate } from "../lib/date";

export const HistoryPage = () => {
  const { repository } = useAppContext();
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [selectedEntry, setSelectedEntry] = useState<DailyEntry | null>(null);

  const loadEntries = async () => {
    const list = await repository.listDailyEntries(90);
    setEntries(list);
  };

  const loadEntry = async (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return;
    }

    setSelectedDate(date);
    const [existing, stats, pomodoroStats] = await Promise.all([
      repository.getDailyEntry(date),
      repository.computeDailyTaskStats(date),
      repository.computeDailyPomodoroStats(date)
    ]);
    setSelectedEntry(
      existing
        ? applyDailyPomodoroStats(applyDailyTaskStats(existing, stats), pomodoroStats)
        : applyDailyPomodoroStats(applyDailyTaskStats(createEmptyDailyEntry(date), stats), pomodoroStats)
    );
  };

  useEffect(() => {
    void loadEntries();
    void loadEntry(selectedDate);
  }, [repository]);

  if (!selectedEntry) {
    return <div className="page"><p>Chargement de l'historique...</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Historique quotidien</p>
          <h2>Relire, corriger, reouvrir si necessaire.</h2>
          <p className="hero__copy">
            Une vue compacte des derniers jours avec edition complete sur la date choisie.
          </p>
        </div>
      </header>

      <SectionCard title="Choisir une date" subtitle="Ouvre une journee existante ou cree une date manquante.">
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>Date a ouvrir</span>
            <input
              aria-label="Date a ouvrir"
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button className="button" type="button" onClick={() => void loadEntry(selectedDate)}>
            Charger la date
          </button>
        </div>

        <div className="history-list">
          {entries.length === 0 ? (
            <p className="empty-copy">Aucune journee enregistree pour l'instant.</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.date}
                type="button"
                className={`history-item${selectedDate === entry.date ? " history-item--active" : ""}`}
                onClick={() => void loadEntry(entry.date)}
              >
                <strong>{formatDateShort(entry.date)}</strong>
                <span>{deriveStatusLabel(entry.status)}</span>
              </button>
            ))
          )}
        </div>
      </SectionCard>

      <SectionCard title={formatDateLong(selectedEntry.date)} subtitle="Edition complete de la journee selectionnee.">
        <EntrySummaryStrip entry={selectedEntry} />

        <div className="journal-grid">
          <label className="stacked-field">
            <span>Intention du matin</span>
            <textarea
              rows={3}
              value={selectedEntry.morningIntention}
              onChange={(event) => setSelectedEntry(updateNote(selectedEntry, "morningIntention", event.target.value))}
            />
          </label>
          <label className="stacked-field">
            <span>Reflection du soir</span>
            <textarea
              rows={3}
              value={selectedEntry.nightReflection}
              onChange={(event) => setSelectedEntry(updateNote(selectedEntry, "nightReflection", event.target.value))}
            />
          </label>
          <label className="stacked-field">
            <span>Focus de demain</span>
            <textarea
              rows={3}
              value={selectedEntry.tomorrowFocus}
              onChange={(event) => setSelectedEntry(updateNote(selectedEntry, "tomorrowFocus", event.target.value))}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Metriques" subtitle="Toutes les metriques du suivi quotidien.">
        <MetricGrid
          entry={selectedEntry}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={selectedEntry.suggestedMetrics}
          onChange={(key, value) => setSelectedEntry(updateMetric(selectedEntry, key, value))}
        />
      </SectionCard>

      <SectionCard title="Principes de vie" subtitle="Revise ce qui a ete respecte ce jour-la.">
        <PrincipleChecklist
          entry={selectedEntry}
          onChange={(key, value) => setSelectedEntry(updatePrinciple(selectedEntry, key, value))}
        />
      </SectionCard>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={async () => {
            await repository.saveDailyEntry(selectedEntry);
            await loadEntries();
          }}
        >
          Enregistrer les modifications
        </button>
        <button
          className="button"
          type="button"
          onClick={() => setSelectedEntry(applyRoutineTransition(selectedEntry, "reopen_day"))}
        >
          Reouvrir
        </button>
        <button
          className="button"
          type="button"
          onClick={() => setSelectedEntry(applyRoutineTransition(selectedEntry, "close_day"))}
        >
          Marquer comme cloturee
        </button>
      </div>
    </div>
  );
};
