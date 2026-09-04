import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { useDailyEntry } from "../app/use-daily-entry";
import {
  autoSuggestedMetricKeys,
  findMissingMetricKeys,
  findUnansweredPrincipleKeys,
  updateMetric,
  updateNote,
  updatePrinciple,
} from "../domain/daily-entry";
import type { DailyEntry, MetricKey, PrincipleKey } from "../domain/types";
import { formatDateLong } from "../lib/date";
import { MetricGrid } from "./MetricGrid";
import { PersistedTextarea } from "./PersistedTextarea";
import { PrincipleChecklist } from "./PrincipleChecklist";
import { SectionCard } from "./SectionCard";

interface MissingFields {
  metricKeys: MetricKey[];
  principleKeys: PrincipleKey[];
  nightReflection: boolean;
}

interface PreviousDayReviewCardProps {
  date: string;
}

export const PreviousDayReviewCard = ({ date }: PreviousDayReviewCardProps) => {
  const { t } = useTranslation("today");
  const { entry, loading, save } = useDailyEntry(date);
  const { settings, saveSettings } = useAppContext();
  const [draft, setDraft] = useState<DailyEntry | null>(null);
  const [missing, setMissing] = useState<MissingFields | null>(null);

  useEffect(() => {
    if (draft !== null || !entry) {
      return;
    }

    setDraft(entry);
    setMissing({
      metricKeys: findMissingMetricKeys(entry),
      principleKeys: findUnansweredPrincipleKeys(entry),
      nightReflection: entry.nightReflection.trim() === "",
    });
  }, [draft, entry]);

  if (loading || !entry || settings.previousDayReviewDoneDate === date) {
    return null;
  }

  if (!draft || !missing) {
    return null;
  }

  const hasNothingMissing =
    missing.metricKeys.length === 0 &&
    missing.principleKeys.length === 0 &&
    !missing.nightReflection;

  if (hasNothingMissing) {
    return null;
  }

  const handleSave = async () => {
    const hasChanges =
      missing.metricKeys.some((key) => draft.metrics[key] !== null) ||
      missing.principleKeys.some((key) => draft.principleChecks[key] !== null) ||
      draft.nightReflection.trim() !== entry.nightReflection.trim();

    if (hasChanges) {
      await save(draft);
    }

    await saveSettings({ ...settings, previousDayReviewDoneDate: date });
  };

  return (
    <SectionCard
      title={t("previousDay.title")}
      subtitle={t("previousDay.subtitle", { date: formatDateLong(date) })}
    >
      <div className="section-stack">
        {missing.metricKeys.length > 0 ? (
          <MetricGrid
            entry={draft}
            keys={missing.metricKeys}
            suggestionKeys={[...autoSuggestedMetricKeys]}
            suggestedValues={draft.suggestedMetrics}
            onChange={(key, value) => setDraft(updateMetric(draft, key, value))}
          />
        ) : null}

        {missing.principleKeys.length > 0 ? (
          <PrincipleChecklist
            entry={draft}
            keys={missing.principleKeys}
            onChange={(key, value) => setDraft(updatePrinciple(draft, key, value))}
          />
        ) : null}

        {missing.nightReflection ? (
          <label className="stacked-field">
            <span>{t("previousDay.nightReflection")}</span>
            <PersistedTextarea
              rows={4}
              debounceMs={0}
              savedValue={draft.nightReflection}
              onPersist={(value) => setDraft(updateNote(draft, "nightReflection", value))}
            />
          </label>
        ) : null}

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            onClick={() => void handleSave()}
          >
            {t("previousDay.save")}
          </button>
        </div>
      </div>
    </SectionCard>
  );
};
