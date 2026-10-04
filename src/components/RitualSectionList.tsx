import type { MutableRefObject, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { RitualSection } from "../app/reviews/ritual-sections";
import { PersistedTextarea, type PersistedTextareaHandle } from "./PersistedTextarea";

export interface RitualSectionListLabels {
  done: string;
  doneAria: (section: string) => string;
  notesLabel: (section: string) => string;
}

interface RitualSectionListProps<K extends string> {
  sections: ReadonlyArray<RitualSection<K>>;
  /** Class of the wrapping stack, which differs per review surface. */
  className: string;
  /** Identifies the reviewed period; remounts each note field when it changes. */
  scopeKey: string;
  checklist: Record<K, boolean>;
  notes: Record<K, string>;
  /** Filled with each section's note handle so callers can refresh a draft in place. */
  noteRefs: MutableRefObject<Partial<Record<K, PersistedTextareaHandle | null>>>;
  labels: RitualSectionListLabels;
  onToggle: (key: K, checked: boolean) => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors PersistedTextarea's `void | Promise` contract.
  onPersistNote: (key: K, value: string) => void | Promise<unknown>;
  notesPlaceholder?: (section: RitualSection<K>) => string;
  /** Extra content rendered under a section's note field (e.g. next week's Dimanche notes). */
  renderAfterNotes?: (section: RitualSection<K>) => ReactNode;
}

/** Checklist + notes card per ritual section, shared by the weekly and monthly reviews. */
export const RitualSectionList = <K extends string>({
  sections,
  className,
  scopeKey,
  checklist,
  notes,
  noteRefs,
  labels,
  onToggle,
  onPersistNote,
  notesPlaceholder,
  renderAfterNotes,
}: RitualSectionListProps<K>) => (
  <div className={className}>
    {sections.map((section) => (
      <article key={section.key} className="weekly-ritual-card">
        <div className="weekly-ritual-card__header">
          <div>
            <h3>{section.title}</h3>
            <p>{section.subtitle}</p>
          </div>
          <label className="switch-row">
            <input
              aria-label={labels.doneAria(section.title)}
              type="checkbox"
              checked={checklist[section.key]}
              onChange={(event) => onToggle(section.key, event.target.checked)}
            />
            <span>{labels.done}</span>
          </label>
        </div>
        <p className="empty-copy">{section.prompt}</p>
        <label className="stacked-field">
          <span>{labels.notesLabel(section.title)}</span>
          <PersistedTextarea
            key={`${scopeKey}-${section.key}`}
            ref={(handle) => {
              noteRefs.current[section.key] = handle;
            }}
            rows={4}
            debounceMs={0}
            savedValue={notes[section.key]}
            onPersist={(value) => onPersistNote(section.key, value)}
            placeholder={notesPlaceholder?.(section)}
          />
        </label>
        {renderAfterNotes?.(section)}
        {section.linkTo && section.linkLabel ? (
          <div className="section-actions">
            <Link className="button button--ghost" to={section.linkTo}>
              {section.linkLabel}
            </Link>
          </div>
        ) : null}
      </article>
    ))}
  </div>
);
