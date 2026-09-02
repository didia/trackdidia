import { useTranslation } from "react-i18next";
import { buildEntrySummary, deriveStatusLabel } from "../domain/daily-entry";
import type { DailyEntry } from "../domain/types";
import { formatPercent } from "../lib/format";

export const EntrySummaryStrip = ({ entry }: { entry: DailyEntry }) => {
  const { t } = useTranslation("today");
  const summary = buildEntrySummary(entry);

  return (
    <div className="summary-strip">
      <article className="summary-pill">
        <span>{t("summary.status")}</span>
        <strong>{deriveStatusLabel(entry.status)}</strong>
      </article>
      <article className="summary-pill">
        <span>{t("summary.discipline")}</span>
        <strong>{formatPercent(summary.disciplineScore)}</strong>
      </article>
      <article className="summary-pill">
        <span>{t("summary.tasksCompleted")}</span>
        <strong>{formatPercent(summary.taskCompletionPercent)}</strong>
      </article>
    </div>
  );
};
