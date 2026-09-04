import { useTranslation } from "react-i18next";
import { resolveMetricValue } from "../domain/daily-entry";
import { metricDefinitions } from "../domain/definitions";
import type { DailyEntry, MetricKey, SuggestedMetrics } from "../domain/types";
import { t as translate } from "../i18n";

interface MetricGridProps {
  entry: DailyEntry;
  keys?: MetricKey[];
  suggestedValues?: SuggestedMetrics;
  suggestionKeys?: MetricKey[];
  onChange: (key: MetricKey, value: number | null) => void;
}

export const MetricGrid = ({
  entry,
  keys,
  suggestedValues,
  suggestionKeys = [],
  onChange,
}: MetricGridProps) => {
  const { t } = useTranslation("metrics");
  const definitions = keys
    ? keys.flatMap((key) => {
        const definition = metricDefinitions.find((item) => item.key === key);
        return definition ? [definition] : [];
      })
    : metricDefinitions;
  const suggestionSet = new Set(suggestionKeys);

  return (
    <div className="metric-grid">
      {definitions.map((definition) => (
        <label key={definition.key} className="field-card">
          <span className="field-card__label">
            {translate(`${definition.key}.label`, { ns: "metrics" })}
          </span>
          <span className="field-card__helper">
            {translate(`${definition.key}.helper`, { ns: "metrics" })}
            {suggestionSet.has(definition.key) ? t("suggestionHint") : ""}
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
                  ? String(
                      suggestedValues?.[definition.key] ??
                        resolveMetricValue(entry, definition.key) ??
                        "",
                    )
                  : undefined
              }
              onChange={(event) => {
                const value = event.target.value.trim();
                onChange(definition.key, value === "" ? null : Number(value));
              }}
            />
            {definition.unit ? (
              <small>{translate(`${definition.key}.unit`, { ns: "metrics" })}</small>
            ) : null}
          </div>
        </label>
      ))}
    </div>
  );
};
