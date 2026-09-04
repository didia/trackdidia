import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  applyDailyPomodoroStats,
  applyRoutineTransition,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  autoSuggestedMetricKeys,
  deriveStatusLabel,
  updateMetric,
  updateNote,
  updatePrinciple,
} from "../domain/daily-entry";
import type { DailyEntry } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { EntrySummaryStrip } from "../components/EntrySummaryStrip";
import { PersistedTextarea } from "../components/PersistedTextarea";
import { MetricGrid } from "../components/MetricGrid";
import { PrincipleChecklist } from "../components/PrincipleChecklist";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateShort, getTodayDate } from "../lib/date";

type DailyNoteKey = "morningIntention" | "nightReflection" | "tomorrowFocus";

export const HistoryPage = () => {
  const { t } = useTranslation("history");
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
      repository.computeDailyPomodoroStats(date),
    ]);
    setSelectedEntry(
      existing
        ? applyDailyPomodoroStats(applyDailyTaskStats(existing, stats), pomodoroStats)
        : applyDailyPomodoroStats(
            applyDailyTaskStats(createEmptyDailyEntry(date), stats),
            pomodoroStats,
          ),
    );
  };

  const persistNoteDraft = (key: DailyNoteKey, value: string) => {
    setSelectedEntry((current) => (current ? updateNote(current, key, value) : current));
  };

  const saveNoteOnBlur = async (key: DailyNoteKey, value: string) => {
    const current = selectedEntry;
    if (!current) {
      return;
    }

    const next = updateNote(current, key, value);
    setSelectedEntry(next);
    await repository.saveDailyEntry(next);
    await loadEntries();
  };

  useEffect(() => {
    void loadEntries();
    void loadEntry(selectedDate);
  }, [repository]);

  if (!selectedEntry) {
    return (
      <div className="page">
        <p>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">{t("hero.copy")}</p>
        </div>
      </header>

      <SectionCard title={t("picker.title")} subtitle={t("picker.subtitle")}>
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>{t("picker.dateLabel")}</span>
            <input
              aria-label={t("picker.dateLabel")}
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
          </label>
          <button className="button" type="button" onClick={() => void loadEntry(selectedDate)}>
            {t("picker.load")}
          </button>
        </div>

        <div className="history-list">
          {entries.length === 0 ? (
            <p className="empty-copy">{t("picker.empty")}</p>
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

      <SectionCard title={formatDateLong(selectedEntry.date)} subtitle={t("editor.subtitle")}>
        <EntrySummaryStrip entry={selectedEntry} />

        <div className="journal-grid">
          <label className="stacked-field">
            <span>{t("editor.morningIntention")}</span>
            <PersistedTextarea
              key={`${selectedEntry.date}-morningIntention`}
              rows={3}
              debounceMs={0}
              savedValue={selectedEntry.morningIntention}
              onPersist={(value) => persistNoteDraft("morningIntention", value)}
              onBlur={(event) => {
                void saveNoteOnBlur("morningIntention", event.currentTarget.value);
              }}
            />
          </label>
          <label className="stacked-field">
            <span>{t("editor.nightReflection")}</span>
            <PersistedTextarea
              key={`${selectedEntry.date}-nightReflection`}
              rows={3}
              debounceMs={0}
              savedValue={selectedEntry.nightReflection}
              onPersist={(value) => persistNoteDraft("nightReflection", value)}
              onBlur={(event) => {
                void saveNoteOnBlur("nightReflection", event.currentTarget.value);
              }}
            />
          </label>
          <label className="stacked-field">
            <span>{t("editor.tomorrowFocus")}</span>
            <PersistedTextarea
              key={`${selectedEntry.date}-tomorrowFocus`}
              rows={3}
              debounceMs={0}
              savedValue={selectedEntry.tomorrowFocus}
              onPersist={(value) => persistNoteDraft("tomorrowFocus", value)}
              onBlur={(event) => {
                void saveNoteOnBlur("tomorrowFocus", event.currentTarget.value);
              }}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title={t("metrics.title")} subtitle={t("metrics.subtitle")}>
        <MetricGrid
          entry={selectedEntry}
          suggestionKeys={[...autoSuggestedMetricKeys]}
          suggestedValues={selectedEntry.suggestedMetrics}
          onChange={(key, value) => setSelectedEntry(updateMetric(selectedEntry, key, value))}
        />
      </SectionCard>

      <SectionCard title={t("principles.title")} subtitle={t("principles.subtitle")}>
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
          {t("actions.save")}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => setSelectedEntry(applyRoutineTransition(selectedEntry, "reopen_day"))}
        >
          {t("actions.reopen")}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => setSelectedEntry(applyRoutineTransition(selectedEntry, "close_day"))}
        >
          {t("actions.close")}
        </button>
      </div>
    </div>
  );
};
