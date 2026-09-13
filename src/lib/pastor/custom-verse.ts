import type { CatalogVerse, PastorVerseBody } from "../../domain/types";
import { referenceKey } from "./bible-books";
import { buildCatalogWithCustomVerses } from "./verse-catalog";

/**
 * Builds a catalog-shaped entry from an off-list AI suggestion so it can be saved to
 * `settings.aiPastorCustomVerses` ("Ajouter à ma liste"). Returns `null` when the body isn't an
 * eligible off-list pick (not `"outside"`, no reference, no principle, or an empty explanation).
 *
 * `note` reuses the AI's own explanation, never `paraphraseFr` as `translations` text: the
 * `pastor_verse` prompt forbids quoting Scripture verbatim in the explanation, but `translations`
 * is reserved for verified Scripture text pasted in by the user (see `verse-catalog.ts`), and a
 * model paraphrase must never be stored as if it were that.
 */
export const buildCustomVerseFromOffListPick = (body: PastorVerseBody): CatalogVerse | null => {
  if (body.pick !== "outside" || !body.reference || !body.principleKey) {
    return null;
  }

  const note = body.explanation.trim();
  if (!note) {
    return null;
  }

  const { book, chapter, verseStart, verseEnd } = body.reference;
  const span = verseEnd !== verseStart ? `-${verseEnd}` : "";

  return {
    id: `custom-${book.toLowerCase()}-${chapter}-${verseStart}${span}`,
    reference: body.reference,
    principleKeys: [body.principleKey],
    note,
  };
};

export interface AddCustomVerseResult {
  /** `false` when the reference already exists in the catalog (checked-in or custom). */
  added: boolean;
  /** The full `aiPastorCustomVerses` array to persist — unchanged when `added` is `false`. */
  customVerses: CatalogVerse[];
}

/**
 * Pure: appends `candidate` to `existingCustomVerses` unless a verse with the same reference
 * already exists anywhere in the merged catalog (checked-in `verses.json` or prior custom
 * additions), so re-adding an already-preferred verse is a harmless no-op rather than a
 * duplicate row.
 */
export const addCustomVerse = (
  existingCustomVerses: unknown,
  candidate: CatalogVerse,
): AddCustomVerseResult => {
  const current = Array.isArray(existingCustomVerses)
    ? (existingCustomVerses as CatalogVerse[])
    : [];
  const merged = buildCatalogWithCustomVerses(current).verses;
  const candidateKey = referenceKey(candidate.reference);
  const alreadyPresent = merged.some((verse) => referenceKey(verse.reference) === candidateKey);

  if (alreadyPresent) {
    return { added: false, customVerses: current };
  }

  return { added: true, customVerses: [...current, candidate] };
};
