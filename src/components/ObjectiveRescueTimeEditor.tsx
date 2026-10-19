import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RescueTimeTaxonomyEntry, WeeklyObjective } from "../domain/types";

export type ObjectiveRescueTimeKind = "activity" | "category";

export interface ObjectiveRescueTimeMapping {
  rescuetimeKind: ObjectiveRescueTimeKind;
  rescuetimeThing: string;
}

interface ObjectiveRescueTimeEditorProps {
  objective: WeeklyObjective;
  /** Names RescueTime actually reports for the given kind, most-used first. */
  loadEntries: (kind: ObjectiveRescueTimeKind) => Promise<RescueTimeTaxonomyEntry[]>;
  onSave: (mapping: ObjectiveRescueTimeMapping) => Promise<void>;
}

const MAX_VISIBLE_OPTIONS = 100;

const initialKind = (objective: WeeklyObjective): ObjectiveRescueTimeKind =>
  objective.rescuetimeKind === "category" ? "category" : "activity";

/** Lets the user point a time objective at a RescueTime activity or category that exists. */
export const ObjectiveRescueTimeEditor = ({
  objective,
  loadEntries,
  onSave,
}: ObjectiveRescueTimeEditorProps) => {
  const { t } = useTranslation("reviews");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ObjectiveRescueTimeKind>(initialKind(objective));
  const [entries, setEntries] = useState<RescueTimeTaxonomyEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(objective.rescuetimeThing ?? "");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Callers pass an inline function; keeping it out of the effect deps avoids refetching per render.
  const loadEntriesRef = useRef(loadEntries);
  loadEntriesRef.current = loadEntries;

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setEntries(null);
    setLoadFailed(false);
    loadEntriesRef
      .current(kind)
      .then((loaded) => {
        if (!cancelled) {
          setEntries(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = (entries ?? []).filter(
      (entry) => !needle || entry.name.toLowerCase().includes(needle),
    );
    return matching.slice(0, MAX_VISIBLE_OPTIONS);
  }, [entries, filter]);

  const currentMapping = `${initialKind(objective)}:${objective.rescuetimeThing ?? ""}`;
  const canSave = selected !== "" && `${kind}:${selected}` !== currentMapping && !saving;

  if (!open) {
    return (
      <button className="button button--ghost" type="button" onClick={() => setOpen(true)}>
        {t("weekly.standing.mapping.edit")}
      </button>
    );
  }

  return (
    <div className="stacked-field">
      <label className="stacked-field">
        <span>{t("weekly.standing.mapping.kind")}</span>
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ObjectiveRescueTimeKind);
            setSelected("");
          }}
        >
          <option value="activity">{t("weekly.standing.mapping.kindActivity")}</option>
          <option value="category">{t("weekly.standing.mapping.kindCategory")}</option>
        </select>
      </label>
      <label className="stacked-field">
        <span>{t("weekly.standing.mapping.filter")}</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      {loadFailed ? <p className="empty-copy">{t("weekly.standing.mapping.loadFailed")}</p> : null}
      {entries === null && !loadFailed ? (
        <p className="empty-copy">{t("weekly.standing.mapping.loading")}</p>
      ) : null}
      {entries !== null ? (
        <label className="stacked-field">
          <span>{t("weekly.standing.mapping.choose")}</span>
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">{t("weekly.standing.mapping.placeholder")}</option>
            {visible.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {t("weekly.standing.mapping.option", {
                  name: entry.name,
                  hours: Math.round(entry.hours * 10) / 10,
                })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {saveFailed ? <p className="empty-copy">{t("weekly.standing.mapping.saveFailed")}</p> : null}
      <div className="section-actions">
        <button
          className="button"
          type="button"
          disabled={!canSave}
          onClick={() => {
            setSaving(true);
            setSaveFailed(false);
            onSave({ rescuetimeKind: kind, rescuetimeThing: selected })
              .then(() => setOpen(false))
              .catch(() => setSaveFailed(true))
              .finally(() => setSaving(false));
          }}
        >
          {t("weekly.standing.mapping.save")}
        </button>
        <button className="button button--ghost" type="button" onClick={() => setOpen(false)}>
          {t("weekly.standing.mapping.cancel")}
        </button>
      </div>
    </div>
  );
};
