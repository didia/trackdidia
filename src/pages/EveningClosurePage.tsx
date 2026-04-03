import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  autoSuggestedMetricKeys,
  applyRoutineTransition,
  updateMetric,
  updateNote,
  updatePrinciple
} from "../domain/daily-entry";
import { useDailyEntry } from "../app/use-daily-entry";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { getTodayDate, formatDateLong } from "../lib/date";

export const EveningClosurePage = () => {
  const navigate = useNavigate();
  const { entry, loading, save } = useDailyEntry(getTodayDate());
  const latestEntryRef = useRef(entry);
  const nightReflectionRef = useRef<PersistedTextareaHandle>(null);
  const tomorrowFocusRef = useRef<PersistedTextareaHandle>(null);
  latestEntryRef.current = entry;

  if (loading || !entry) {
    return <div className="page"><p>Chargement de la fermeture du soir...</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Fermeture du soir</p>
          <h2>{formatDateLong(entry.date)}</h2>
          <p className="hero__copy">
            Referme la boucle, mesure la fidelite du jour et prepare le terrain pour demain.
          </p>
        </div>
      </header>

      <EntrySummaryStrip entry={entry} />

      <SectionCard title="Metriques du jour" subtitle="Complete les chiffres qui rendent la journee lisible.">
        <MetricGrid
          entry={entry}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={entry.suggestedMetrics}
          onChange={(key, value) => void save(updateMetric(entry, key, value))}
        />
      </SectionCard>

      <SectionCard title="Principes de vie" subtitle="Oui ou non pour chaque principe.">
        <PrincipleChecklist
          entry={entry}
          onChange={(key, value) => void save(updatePrinciple(entry, key, value))}
        />
      </SectionCard>

      <SectionCard title="Cloture" subtitle="Une lecture honnete et courte de la journee.">
        <div className="journal-grid">
          <label className="stacked-field">
            <span>Reflection du soir</span>
            <PersistedTextarea
              ref={nightReflectionRef}
              rows={5}
              savedValue={entry.nightReflection}
              onPersist={(nextValue) => {
                const current = latestEntryRef.current;
                if (!current) {
                  return;
                }
                void save(updateNote(current, "nightReflection", nextValue));
              }}
              placeholder="Qu'est-ce qui a ete fidele aujourd'hui ?"
            />
          </label>
          <label className="stacked-field">
            <span>Focus de demain</span>
            <PersistedTextarea
              ref={tomorrowFocusRef}
              rows={5}
              savedValue={entry.tomorrowFocus}
              onPersist={(nextValue) => {
                const current = latestEntryRef.current;
                if (!current) {
                  return;
                }
                void save(updateNote(current, "tomorrowFocus", nextValue));
              }}
              placeholder="Quel est le prochain acte simple qui compte ?"
            />
          </label>
        </div>
      </SectionCard>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={async () => {
            const current = latestEntryRef.current;
            if (!current) {
              return;
            }
            nightReflectionRef.current?.flush();
            tomorrowFocusRef.current?.flush();
            const night = nightReflectionRef.current?.getDraft() ?? current.nightReflection;
            const tomorrow = tomorrowFocusRef.current?.getDraft() ?? current.tomorrowFocus;
            const withNotes = updateNote(updateNote(current, "nightReflection", night), "tomorrowFocus", tomorrow);
            await save(applyRoutineTransition(withNotes, "close_day"));
            navigate("/");
          }}
        >
          Cloturer la journee
        </button>
      </div>
    </div>
  );
};
