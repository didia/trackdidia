import { metricDefinitions } from "../domain/definitions";
import { resolveMetricValue } from "../domain/daily-entry";
import type { DailyEntry, MetricKey, SuggestedMetrics } from "../domain/types";

interface MetricGridProps {
  entry: DailyEntry;
  keys?: MetricKey[];
  suggestedValues?: SuggestedMetrics;
  suggestionKeys?: MetricKey[];
  onChange: (key: MetricKey, value: number | null) => void;
}

export const MetricGrid = ({ entry, keys, suggestedValues, suggestionKeys = [], onChange }: MetricGridProps) => {
  const definitions = metricDefinitions.filter((definition) => !keys || keys.includes(definition.key));
  const suggestionSet = new Set(suggestionKeys);

  return (
    <div className="metric-grid">
      {definitions.map((definition) => (
        <label key={definition.key} className="field-card">
          <span className="field-card__label">{definition.label}</span>
          <span className="field-card__helper">
            {definition.helper}
            {suggestionSet.has(definition.key) ? " Suggestion auto, modifiable si besoin." : ""}
          </span>
          <div className="field-card__control">
            <input
              type="number"
              value={entry.metrics[definition.key] ?? ""}
              min={definition.min}
              max={definition.max}
              step={definition.step ?? 1}
              placeholder={
                suggestionSet.has(definition.key)
                  ? String(suggestedValues?.[definition.key] ?? resolveMetricValue(entry, definition.key) ?? "")
                  : undefined
              }
              onChange={(event) => {
                const value = event.target.value.trim();
                onChange(definition.key, value === "" ? null : Number(value));
              }}
            />
            {definition.unit ? <small>{definition.unit}</small> : null}
          </div>
        </label>
      ))}
    </div>
  );
};
