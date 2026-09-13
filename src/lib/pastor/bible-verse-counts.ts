/**
 * A single global verse-number ceiling, used only to reject clearly fabricated off-list
 * references (e.g. `{ book: "GEN", chapter: 1, verseStart: 999, verseEnd: 999 }` — Genesis 1 has
 * 31 verses). Psalm 119 (176 verses) is the longest chapter in the entire Bible, across every
 * book and every mainstream numbering scheme (NRSVue, Catholic, etc.) — no real reference in any
 * book ever has a verse number above 176, so this ceiling can never reject a real reference while
 * still catching grossly fabricated verse numbers like the one above.
 *
 * This intentionally replaces an earlier per-book table. Hand-authoring accurate per-book
 * ceilings from memory turned out to be unreliable: roughly 20 of the 73 books had a ceiling
 * tighter than their real longest chapter, which silently rejected real off-list references —
 * e.g. `verses.json` ships `EPH 4:26`, but the earlier table capped Ephesians at 25 (its real
 * longest chapter, Ephesians 4, has 32 verses). A single verified constant is safer than a large
 * table that cannot be checked against an external source in this environment. If tighter
 * per-book or per-chapter bounds are wanted later, source them from a vetted table rather than
 * reintroducing hand-authored numbers.
 */
export const MAX_VERSE_NUMBER_IN_BIBLE = 176;

/**
 * Generous upper bound on verse numbers, regardless of book or chapter — see the module doc
 * comment above. Takes `book` for call-site stability even though every book currently shares the
 * same ceiling.
 */
export const maxVerseCeilingForBook = (_book: string): number => MAX_VERSE_NUMBER_IN_BIBLE;
