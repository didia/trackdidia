import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { loadLatestClosePulseForDate } from "../lib/ai/coach-pulse-loader";
import { resolveDailySnapshotInputs } from "../lib/ai/context/preview";
import { resolveDueCommitmentsOnClose } from "../lib/ai/memory/lifecycle";
import { getTodayDate, formatDateLong } from "../lib/date";
import { nowIso } from "../lib/gtd/shared";

export const EveningClosurePage = () => {
  const { t } = useTranslation("evening");
  const navigate = useNavigate();
  const { repository, settings, coachService } = useAppContext();
  const { entry, loading, save } = useDailyEntry(getTodayDate());
  const [coachResult, setCoachResult] = useState<CoachPulseResult | null>(null);
  const [coachLoading, setCoachLoading] = useState(true);
  const latestEntryRef = useRef(entry);
  const nightReflectionRef = useRef<PersistedTextareaHandle>(null);
  const tomorrowFocusRef = useRef<PersistedTextareaHandle>(null);
  latestEntryRef.current = entry;

  const loadCoachFromStore = useCallback(async () => {
    const currentEntry = latestEntryRef.current;
    if (!currentEntry) {
      return;
    }

    setCoachLoading(true);
    try {
      await resolveDueCommitmentsOnClose(repository, currentEntry.date, currentEntry, nowIso());

      const stored = await loadLatestClosePulseForDate(repository, coachService, currentEntry.date);
      if (stored) {
        setCoachResult(stored);
      }

      const snapshotInputs = await resolveDailySnapshotInputs(
        repository,
        currentEntry.date,
        new Date().toISOString(),
        undefined,
        { skipRescueTimeFetch: true }
      );

      if (!settings.aiEnabled || !settings.aiApiKey.trim()) {
        if (!stored) {
          const localResult = await coachService.buildPulse(repository, {
            stance: "close",
            entry: currentEntry,
            settings,
            snapshotInputs,
            trigger: "auto",
            localOnly: true
          });
          setCoachResult(localResult);
        }
        return;
      }

      const aiResult = await coachService.buildPulse(repository, {
        stance: "close",
        entry: currentEntry,
        settings,
        snapshotInputs,
        trigger: "auto"
      });
      setCoachResult(aiResult);
    } catch (error) {
      console.error("Failed to load evening coach pulse", error);
    } finally {
      setCoachLoading(false);
    }
  }, [coachService, repository, settings]);

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
      } catch (error) {
        console.error("Failed to load evening coach pulse", error);
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
  }, [entry?.date, loadCoachFromStore]);

  const handleAcceptProposal = async (proposal: AiProposal) => {
    const currentEntry = latestEntryRef.current;
    if (!currentEntry) {
      return;
    }

    try {
      const applied = await applyCoachProposal(repository, proposal, currentEntry.date);

      if (proposal.type === "tomorrow_focus_draft" && applied.text !== undefined) {
        const tomorrowFocus = applied.text;
        await save((latest) => updateNote(latest, "tomorrowFocus", tomorrowFocus));
        tomorrowFocusRef.current?.setDraft(tomorrowFocus);
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
    return <div className="page"><p>{t("loading")}</p></div>;
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{formatDateLong(entry.date)}</h2>
          <p className="hero__copy">
            {t("hero.copy")}
          </p>
        </div>
      </header>

      <EntrySummaryStrip entry={entry} />

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

      <SectionCard title={t("metrics.title")} subtitle={t("metrics.subtitle")}>
        <MetricGrid
          entry={entry}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={entry.suggestedMetrics}
          onChange={(key, value) => void save((current) => updateMetric(current, key, value))}
        />
      </SectionCard>

      <SectionCard title={t("principles.title")} subtitle={t("principles.subtitle")}>
        <PrincipleChecklist
          entry={entry}
          onChange={(key, value) => void save((current) => updatePrinciple(current, key, value))}
        />
      </SectionCard>

      <SectionCard title={t("closure.title")} subtitle={t("closure.subtitle")}>
        <div className="journal-grid">
          <label className="stacked-field">
            <span>{t("closure.nightReflection")}</span>
            <PersistedTextarea
              ref={nightReflectionRef}
              rows={5}
              savedValue={entry.nightReflection}
              onPersist={(nextValue) => {
                void save((current) => updateNote(current, "nightReflection", nextValue));
              }}
              placeholder={t("closure.nightPlaceholder")}
            />
          </label>
          <label className="stacked-field">
            <span>{t("closure.tomorrowFocus")}</span>
            <PersistedTextarea
              ref={tomorrowFocusRef}
              rows={5}
              savedValue={entry.tomorrowFocus}
              onPersist={(nextValue) => {
                void save((current) => updateNote(current, "tomorrowFocus", nextValue));
              }}
              placeholder={t("closure.tomorrowPlaceholder")}
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
            await save((latest) =>
              applyRoutineTransition(
                updateNote(updateNote(latest, "nightReflection", night), "tomorrowFocus", tomorrow),
                "close_day"
              )
            );
            navigate("/");
          }}
        >
          {t("closeDay")}
        </button>
      </div>
    </div>
  );
};
