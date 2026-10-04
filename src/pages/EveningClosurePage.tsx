import { useProposalDecisions } from "../app/use-proposal-decisions";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { useCoachPulse } from "../app/use-coach-pulse";
import { useDailyEntry } from "../app/use-daily-entry";
import { CoachPulsePanel } from "../components/CoachPulsePanel";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { MetricGrid } from "../components/MetricGrid";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  applyRoutineTransition,
  autoSuggestedMetricKeys,
  updateMetric,
  updateNote,
  updatePrinciple,
} from "../domain/daily-entry";
import { formatDateLong, getTodayDate } from "../lib/date";

export const EveningClosurePage = () => {
  const { t } = useTranslation("evening");
  const navigate = useNavigate();
  const { settings } = useAppContext();
  const { entry, loading, save, applyProposal } = useDailyEntry(getTodayDate());
  const {
    result: coachResult,
    loading: coachLoading,
    refresh: loadCoach,
    setResult: setCoachResult,
  } = useCoachPulse({ date: entry?.date, entry, stance: "close" });
  const latestEntryRef = useRef(entry);
  const nightReflectionRef = useRef<PersistedTextareaHandle>(null);
  const tomorrowFocusRef = useRef<PersistedTextareaHandle>(null);
  latestEntryRef.current = entry;

  const decisions = useProposalDecisions(coachResult, setCoachResult, {
    onAccept: async (proposal) => {
      const currentEntry = latestEntryRef.current;
      if (!currentEntry) return {};
      const applied = await applyProposal(proposal);
      if (
        applied.proposal &&
        applied.dailyNote &&
        applied.dailyNote.field === "tomorrowFocus" &&
        latestEntryRef.current?.date === currentEntry.date
      )
        tomorrowFocusRef.current?.setDraft(applied.dailyNote.text);
      return applied;
    },
  });

  if (loading || !entry) {
    return (
      <div className="page">
        <p>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t("hero.eyebrow")}
        title={formatDateLong(entry.date)}
        copy={t("hero.copy")}
      />

      <EntrySummaryStrip entry={entry} />

      <CoachPulsePanel
        title={t("coachTitle")}
        result={coachResult}
        loading={coachLoading}
        settings={settings}
        autoloadAi
        onRegenerate={() => void loadCoach({ trigger: "explicit", bypassCache: true })}
        decisions={decisions}
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
                "close_day",
              ),
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
