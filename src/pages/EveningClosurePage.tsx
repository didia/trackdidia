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
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { getTodayDate, formatDateLong } from "../lib/date";

export const EveningClosurePage = () => {
  const navigate = useNavigate();
  const { entry, loading, save } = useDailyEntry(getTodayDate());

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

      <SectionCard title="Principes de vie" subtitle="Oui, non ou plus tard pour chaque principe.">
        <PrincipleChecklist
          entry={entry}
          onChange={(key, value) => void save(updatePrinciple(entry, key, value))}
        />
      </SectionCard>

      <SectionCard title="Cloture" subtitle="Une lecture honnete et courte de la journee.">
        <div className="journal-grid">
          <label className="stacked-field">
            <span>Reflection du soir</span>
            <textarea
              rows={5}
              value={entry.nightReflection}
              onChange={(event) => void save(updateNote(entry, "nightReflection", event.target.value))}
              placeholder="Qu'est-ce qui a ete fidele aujourd'hui ?"
            />
          </label>
          <label className="stacked-field">
            <span>Focus de demain</span>
            <textarea
              rows={5}
              value={entry.tomorrowFocus}
              onChange={(event) => void save(updateNote(entry, "tomorrowFocus", event.target.value))}
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
            await save(applyRoutineTransition(entry, "close_day"));
            navigate("/");
          }}
        >
          Cloturer la journee
        </button>
      </div>
    </div>
  );
};
