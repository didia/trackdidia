import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  autoSuggestedMetricKeys,
  applyRoutineTransition,
  updateMetric,
  updateNote,
  updatePrinciple
} from "../domain/daily-entry";
import type { AiProposal, CoachPulseResult } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { useDailyEntry } from "../app/use-daily-entry";
import { CoachPulsePanel } from "../components/CoachPulsePanel";
import { applyCoachProposal } from "../lib/ai/proposals/apply-proposal";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { resolveDailySnapshotInputs } from "../lib/ai/context/preview";
import { getTodayDate, formatDateLong } from "../lib/date";

export const EveningClosurePage = () => {
  const navigate = useNavigate();
  const { repository, settings, coachService } = useAppContext();
  const { entry, loading, save } = useDailyEntry(getTodayDate());
  const [coachResult, setCoachResult] = useState<CoachPulseResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(true);
  const latestEntryRef = useRef(entry);
  const nightReflectionRef = useRef<PersistedTextareaHandle>(null);
  const tomorrowFocusRef = useRef<PersistedTextareaHandle>(null);
  latestEntryRef.current = entry;

  const loadCoach = useCallback(
    async (options: { trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      const currentEntry = latestEntryRef.current;
      if (!currentEntry) {
        return;
      }

      setCoachLoading(true);
      try {
        const snapshotInputs = await resolveDailySnapshotInputs(repository, currentEntry.date);
        const result = await coachService.buildPulse(repository, {
          stance: "close",
          entry: currentEntry,
          settings,
          snapshotInputs,
          trigger: options.trigger,
          bypassCache: options.bypassCache ?? false
        });
        setCoachResult(result);
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

    void loadCoach({ trigger: "explicit" });
  }, [entry?.date, loadCoach]);

  const handleAcceptProposal = async (proposal: AiProposal) => {
    const currentEntry = latestEntryRef.current;
    if (!currentEntry) {
      return;
    }

    try {
      const applied = await applyCoachProposal(repository, proposal, currentEntry.date);

      if (proposal.type === "tomorrow_focus_draft" && applied.text !== undefined) {
        await save(updateNote(currentEntry, "tomorrowFocus", applied.text));
        tomorrowFocusRef.current?.setDraft(applied.text);
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

      <CoachPulsePanel
        title="Coach de cloture"
        result={coachResult}
        loading={coachLoading}
        settings={settings}
        onRequestCoach={() => void loadCoach({ trigger: "explicit" })}
        onRegenerate={() => void loadCoach({ trigger: "explicit", bypassCache: true })}
        onAcceptProposal={(proposal) => void handleAcceptProposal(proposal)}
        onDismissProposal={(proposal) => void handleDismissProposal(proposal)}
      />

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
