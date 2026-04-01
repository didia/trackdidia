import { buildEntrySummary, deriveStatusLabel } from "../domain/daily-entry";
import type { DailyEntry } from "../domain/types";
import { formatPercent } from "../lib/format";

export const EntrySummaryStrip = ({ entry }: { entry: DailyEntry }) => {
  const summary = buildEntrySummary(entry);

  return (
    <div className="summary-strip">
      <article className="summary-pill">
        <span>Statut</span>
        <strong>{deriveStatusLabel(entry.status)}</strong>
      </article>
      <article className="summary-pill">
        <span>Discipline</span>
        <strong>{formatPercent(summary.disciplineScore)}</strong>
      </article>
      <article className="summary-pill">
        <span>Completion</span>
        <strong>{formatPercent(summary.completionPercent)}</strong>
      </article>
    </div>
  );
};

