import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  autoSuggestedMetricKeys,
  applyRoutineTransition,
  resolveMetricValue,
  updateMetric,
  updateNote,
  updatePrinciple
} from "../domain/daily-entry";
import { morningPrincipleKeys } from "../domain/definitions";
import { useDailyEntry } from "../app/use-daily-entry";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { getTodayDate, formatDateLong } from "../lib/date";

export const MorningRoutinePage = () => {
  const navigate = useNavigate();
  const { entry, loading, save, taskStats} = useDailyEntry(getTodayDate());
  const [intentionDraft, setIntentionDraft] = useState("");
  const intentionSaveTimeoutRef = useRef<number | null>(null);
  const intentionDirtyRef = useRef(false);
  const latestEntryRef = useRef(entry);
  const lastSavedIntentionRef = useRef("");

  latestEntryRef.current = entry;

  useEffect(() => {
    if (!entry) {
      return;
    }
    lastSavedIntentionRef.current = entry.morningIntention;
    if (!intentionDirtyRef.current) {
      setIntentionDraft(entry.morningIntention);
    }
  }, [entry]);

  useEffect(() => {
    return () => {
      if (intentionSaveTimeoutRef.current !== null) {
        window.clearTimeout(intentionSaveTimeoutRef.current);
      }
    };
  }, []);

  if (loading || !entry) {
    return <div className="page"><p>Chargement de la routine du matin...</p></div>;
  }

  const persistIntention = (nextValue: string) => {
    const currentEntry = latestEntryRef.current;
    if (!currentEntry) {
      return;
    }
    if (nextValue === lastSavedIntentionRef.current) {
      intentionDirtyRef.current = false;
      return;
    }
    lastSavedIntentionRef.current = nextValue;
    intentionDirtyRef.current = false;
    void save(updateNote(currentEntry, "morningIntention", nextValue));
  };

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Routine du matin</p>
          <h2>{formatDateLong(entry.date)}</h2>
          <p className="hero__copy">
            Ouvre la journee avec intention, clarte et une premiere structure realiste.
          </p>
        </div>
      </header>

      <EntrySummaryStrip entry={entry} />

      <SectionCard title="Intention du jour" subtitle="Une phrase suffit. Cherche le ton juste, pas la perfection.">
        <label className="stacked-field">
          <span>Intention</span>
          <textarea
            rows={4}
            value={intentionDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              intentionDirtyRef.current = true;
              setIntentionDraft(nextValue);
              if (intentionSaveTimeoutRef.current !== null) {
                window.clearTimeout(intentionSaveTimeoutRef.current);
              }
              intentionSaveTimeoutRef.current = window.setTimeout(() => {
                persistIntention(nextValue);
                intentionSaveTimeoutRef.current = null;
              }, 450);
            }}
            onBlur={() => {
              if (intentionSaveTimeoutRef.current !== null) {
                window.clearTimeout(intentionSaveTimeoutRef.current);
                intentionSaveTimeoutRef.current = null;
              }
              persistIntention(intentionDraft);
            }}
            placeholder="Quelle posture veux-tu garder aujourd'hui ?"
          />
        </label>
      </SectionCard>

      <SectionCard title="Ancrages du matin" subtitle="Quelques signaux forts pour bien demarrer.">
        <PrincipleChecklist
          entry={entry}
          keys={morningPrincipleKeys}
          onChange={(key, value) => void save(updatePrinciple(entry, key, value))}
        />
      </SectionCard>

      <SectionCard
        title="Charge de travail GTD"
        subtitle="Le moteur GTD propose ces valeurs automatiquement, mais tu peux les ajuster si ta lecture du jour differe."
      >
        <MetricGrid
          entry={entry}
          keys={["tachesDebut", "tachesAjoutes"]}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={{
            tachesDebut: taskStats?.tasksAtStart ?? resolveMetricValue(entry, "tachesDebut"),
            tachesAjoutes: taskStats?.tasksAdded ?? resolveMetricValue(entry, "tachesAjoutes")
          }}
          onChange={(key, value) => void save(updateMetric(entry, key, value))}
        />
      </SectionCard>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          onClick={async () => {
            await save(applyRoutineTransition(entry, "complete_morning"));
            navigate("/");
          }}
        >
          Marquer le matin comme complete
        </button>
      </div>
    </div>
  );
};
