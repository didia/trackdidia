import { type MutableRefObject, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RitualSection } from "../app/reviews/ritual-sections";
import { PersistedTextarea, type PersistedTextareaHandle } from "./PersistedTextarea";

export interface RitualSectionListLabels {
  done: string;
  doneAria: (section: string) => string;
  notesLabel: (section: string) => string;
  /** Badge on a section whose note must be filled in. */
  required: string;
  /** Toggle that reveals the note of an optional section. */
  addNote: string;
  hideNote: string;
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
  /** Sections whose note is required; every other note stays folded away until asked for. */
  requiredKeys?: ReadonlyArray<K>;
  /** Extra content rendered under a section's note field (e.g. next week's Dimanche notes). */
  renderAfterNotes?: (section: RitualSection<K>) => ReactNode;
}

interface OptionalNoteProps {
  hasNote: boolean;
  addLabel: string;
  hideLabel: string;
  children: ReactNode;
}

/** Keeps an optional note folded until it has content or the user opens it. */
const OptionalNote = ({ hasNote, addLabel, hideLabel, children }: OptionalNoteProps) => {
  const [expanded, setExpanded] = useState(hasNote);
  useEffect(() => {
    if (hasNote) {
      setExpanded(true);
    }
  }, [hasNote]);
  const open = expanded;
  return (
    <div className="ritual-note">
      <button
        type="button"
        className="button button--ghost ritual-note__toggle"
        aria-expanded={open}
        disabled={hasNote}
        onClick={() => setExpanded((current) => !current)}
      >
        {open ? hideLabel : addLabel}
      </button>
      <div className="ritual-note__body" hidden={!open}>
        {children}
      </div>
    </div>
  );
};

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
  requiredKeys = [],
  renderAfterNotes,
}: RitualSectionListProps<K>) => (
  <div className={className}>
    {sections.map((section) => {
      const required = requiredKeys.includes(section.key);
      const noteField = (
        <label className="note-field">
          <span className="note-field__label">{labels.notesLabel(section.title)}</span>
          <PersistedTextarea
            key={`${scopeKey}-${section.key}`}
            ref={(handle) => {
              noteRefs.current[section.key] = handle;
            }}
            rows={required ? 10 : 6}
            debounceMs={0}
            savedValue={notes[section.key]}
            onPersist={(value) => onPersistNote(section.key, value)}
            placeholder={notesPlaceholder?.(section)}
          />
        </label>
      );
      return (
        <article
          key={section.key}
          className={`weekly-ritual-card${required ? " weekly-ritual-card--required" : ""}`}
        >
          <div className="weekly-ritual-card__header">
            <div>
              <h3>
                {section.title}
                {required ? <span className="ritual-badge">{labels.required}</span> : null}
              </h3>
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
          {required ? (
            noteField
          ) : (
            <OptionalNote
              hasNote={notes[section.key].trim() !== ""}
              addLabel={labels.addNote}
              hideLabel={labels.hideNote}
            >
              {noteField}
            </OptionalNote>
          )}
          {renderAfterNotes?.(section)}
          {section.linkTo && section.linkLabel ? (
            <div className="section-actions">
              <Link className="button button--ghost" to={section.linkTo}>
                {section.linkLabel}
              </Link>
            </div>
          ) : null}
        </article>
      );
    })}
  </div>
);
