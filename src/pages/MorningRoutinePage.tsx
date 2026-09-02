import { useRef } from "react";
import { useTranslation } from "react-i18next";
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
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { MetricGrid } from "../components/MetricGrid";
import { PreviousDayReviewCard } from "../components/PreviousDayReviewCard";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { addDays } from "../lib/gtd/shared";
import { getTodayDate, formatDateLong } from "../lib/date";

export const MorningRoutinePage = () => {
  const { t } = useTranslation("morning");
  const navigate = useNavigate();
  const { entry, loading, save, taskStats} = useDailyEntry(getTodayDate());
  const latestEntryRef = useRef(entry);
  const intentionRef = useRef<PersistedTextareaHandle>(null);
  latestEntryRef.current = entry;

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

      <PreviousDayReviewCard date={addDays(getTodayDate(), -1)} />

      <SectionCard title={t("intention.title")} subtitle={t("intention.subtitle")}>
        <label className="stacked-field">
          <span>{t("intention.label")}</span>
          <PersistedTextarea
            ref={intentionRef}
            rows={4}
            savedValue={entry.morningIntention}
            onPersist={(nextValue) => {
              void save((current) => updateNote(current, "morningIntention", nextValue));
            }}
            placeholder={t("intention.placeholder")}
          />
        </label>
      </SectionCard>

      <SectionCard title={t("principles.title")} subtitle={t("principles.subtitle")}>
        <PrincipleChecklist
          entry={entry}
          keys={morningPrincipleKeys}
          onChange={(key, value) => void save((current) => updatePrinciple(current, key, value))}
        />
      </SectionCard>

      <SectionCard
        title={t("gtd.title")}
        subtitle={t("gtd.subtitle")}
      >
        <MetricGrid
          entry={entry}
          keys={["tachesDebut", "tachesAjoutes"]}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={{
            tachesDebut: taskStats?.tasksAtStart ?? resolveMetricValue(entry, "tachesDebut"),
            tachesAjoutes: taskStats?.tasksAdded ?? resolveMetricValue(entry, "tachesAjoutes")
          }}
          onChange={(key, value) => void save((current) => updateMetric(current, key, value))}
        />
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
            intentionRef.current?.flush();
            const intention = intentionRef.current?.getDraft() ?? current.morningIntention;
            await save((latest) =>
              applyRoutineTransition(updateNote(latest, "morningIntention", intention), "complete_morning")
            );
            navigate("/");
          }}
        >
          {t("completeMorning")}
        </button>
      </div>
    </div>
  );
};
