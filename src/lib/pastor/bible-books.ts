import type { BibleReference } from "../../domain/types";

export interface BibleBookDefinition {
  /** USFM-style book code, e.g. `"PHP"`. Matches `verses.json` `reference.book` values. */
  code: string;
  nameFr: string;
  nameEn: string;
  /**
   * Highest chapter count across NRSVue and Catholic editions (spec: lenient on purpose).
   * `Joel`, `Malachi`, `Daniel`, `Baruch`, and `Esther` use the wider Catholic numbering so a
   * verse valid in either edition never fails validation.
   */
  maxChapters: number;
}

/** 66 protocanonical books plus 7 deuterocanonical books (Tobit, Judith, Wisdom, Sirach, Baruch, 1–2 Maccabees). */
export const bibleBooks: BibleBookDefinition[] = [
  { code: "GEN", nameFr: "Genèse", nameEn: "Genesis", maxChapters: 50 },
  { code: "EXO", nameFr: "Exode", nameEn: "Exodus", maxChapters: 40 },
  { code: "LEV", nameFr: "Lévitique", nameEn: "Leviticus", maxChapters: 27 },
  { code: "NUM", nameFr: "Nombres", nameEn: "Numbers", maxChapters: 36 },
  { code: "DEU", nameFr: "Deutéronome", nameEn: "Deuteronomy", maxChapters: 34 },
  { code: "JOS", nameFr: "Josué", nameEn: "Joshua", maxChapters: 24 },
  { code: "JDG", nameFr: "Juges", nameEn: "Judges", maxChapters: 21 },
  { code: "RUT", nameFr: "Ruth", nameEn: "Ruth", maxChapters: 4 },
  { code: "1SA", nameFr: "1 Samuel", nameEn: "1 Samuel", maxChapters: 31 },
  { code: "2SA", nameFr: "2 Samuel", nameEn: "2 Samuel", maxChapters: 24 },
  { code: "1KI", nameFr: "1 Rois", nameEn: "1 Kings", maxChapters: 22 },
  { code: "2KI", nameFr: "2 Rois", nameEn: "2 Kings", maxChapters: 25 },
  { code: "1CH", nameFr: "1 Chroniques", nameEn: "1 Chronicles", maxChapters: 29 },
  { code: "2CH", nameFr: "2 Chroniques", nameEn: "2 Chronicles", maxChapters: 36 },
  { code: "EZR", nameFr: "Esdras", nameEn: "Ezra", maxChapters: 10 },
  { code: "NEH", nameFr: "Néhémie", nameEn: "Nehemiah", maxChapters: 13 },
  { code: "EST", nameFr: "Esther", nameEn: "Esther", maxChapters: 16 },
  { code: "JOB", nameFr: "Job", nameEn: "Job", maxChapters: 42 },
  { code: "PSA", nameFr: "Psaumes", nameEn: "Psalms", maxChapters: 150 },
  { code: "PRO", nameFr: "Proverbes", nameEn: "Proverbs", maxChapters: 31 },
  { code: "ECC", nameFr: "Ecclésiaste", nameEn: "Ecclesiastes", maxChapters: 12 },
  { code: "SNG", nameFr: "Cantique des cantiques", nameEn: "Song of Songs", maxChapters: 8 },
  { code: "ISA", nameFr: "Isaïe", nameEn: "Isaiah", maxChapters: 66 },
  { code: "JER", nameFr: "Jérémie", nameEn: "Jeremiah", maxChapters: 52 },
  { code: "LAM", nameFr: "Lamentations", nameEn: "Lamentations", maxChapters: 5 },
  { code: "EZK", nameFr: "Ézéchiel", nameEn: "Ezekiel", maxChapters: 48 },
  { code: "DAN", nameFr: "Daniel", nameEn: "Daniel", maxChapters: 14 },
  { code: "HOS", nameFr: "Osée", nameEn: "Hosea", maxChapters: 14 },
  { code: "JOL", nameFr: "Joël", nameEn: "Joel", maxChapters: 4 },
  { code: "AMO", nameFr: "Amos", nameEn: "Amos", maxChapters: 9 },
  { code: "OBA", nameFr: "Abdias", nameEn: "Obadiah", maxChapters: 1 },
  { code: "JON", nameFr: "Jonas", nameEn: "Jonah", maxChapters: 4 },
  { code: "MIC", nameFr: "Michée", nameEn: "Micah", maxChapters: 7 },
  { code: "NAM", nameFr: "Nahum", nameEn: "Nahum", maxChapters: 3 },
  { code: "HAB", nameFr: "Habacuc", nameEn: "Habakkuk", maxChapters: 3 },
  { code: "ZEP", nameFr: "Sophonie", nameEn: "Zephaniah", maxChapters: 3 },
  { code: "HAG", nameFr: "Aggée", nameEn: "Haggai", maxChapters: 2 },
  { code: "ZEC", nameFr: "Zacharie", nameEn: "Zechariah", maxChapters: 14 },
  { code: "MAL", nameFr: "Malachie", nameEn: "Malachi", maxChapters: 4 },
  { code: "MAT", nameFr: "Matthieu", nameEn: "Matthew", maxChapters: 28 },
  { code: "MRK", nameFr: "Marc", nameEn: "Mark", maxChapters: 16 },
  { code: "LUK", nameFr: "Luc", nameEn: "Luke", maxChapters: 24 },
  { code: "JHN", nameFr: "Jean", nameEn: "John", maxChapters: 21 },
  { code: "ACT", nameFr: "Actes des Apôtres", nameEn: "Acts", maxChapters: 28 },
  { code: "ROM", nameFr: "Romains", nameEn: "Romans", maxChapters: 16 },
  { code: "1CO", nameFr: "1 Corinthiens", nameEn: "1 Corinthians", maxChapters: 16 },
  { code: "2CO", nameFr: "2 Corinthiens", nameEn: "2 Corinthians", maxChapters: 13 },
  { code: "GAL", nameFr: "Galates", nameEn: "Galatians", maxChapters: 6 },
  { code: "EPH", nameFr: "Éphésiens", nameEn: "Ephesians", maxChapters: 6 },
  { code: "PHP", nameFr: "Philippiens", nameEn: "Philippians", maxChapters: 4 },
  { code: "COL", nameFr: "Colossiens", nameEn: "Colossians", maxChapters: 4 },
  { code: "1TH", nameFr: "1 Thessaloniciens", nameEn: "1 Thessalonians", maxChapters: 5 },
  { code: "2TH", nameFr: "2 Thessaloniciens", nameEn: "2 Thessalonians", maxChapters: 3 },
  { code: "1TI", nameFr: "1 Timothée", nameEn: "1 Timothy", maxChapters: 6 },
  { code: "2TI", nameFr: "2 Timothée", nameEn: "2 Timothy", maxChapters: 4 },
  { code: "TIT", nameFr: "Tite", nameEn: "Titus", maxChapters: 3 },
  { code: "PHM", nameFr: "Philémon", nameEn: "Philemon", maxChapters: 1 },
  { code: "HEB", nameFr: "Hébreux", nameEn: "Hebrews", maxChapters: 13 },
  { code: "JAS", nameFr: "Jacques", nameEn: "James", maxChapters: 5 },
  { code: "1PE", nameFr: "1 Pierre", nameEn: "1 Peter", maxChapters: 5 },
  { code: "2PE", nameFr: "2 Pierre", nameEn: "2 Peter", maxChapters: 3 },
  { code: "1JN", nameFr: "1 Jean", nameEn: "1 John", maxChapters: 5 },
  { code: "2JN", nameFr: "2 Jean", nameEn: "2 John", maxChapters: 1 },
  { code: "3JN", nameFr: "3 Jean", nameEn: "3 John", maxChapters: 1 },
  { code: "JUD", nameFr: "Jude", nameEn: "Jude", maxChapters: 1 },
  { code: "REV", nameFr: "Apocalypse", nameEn: "Revelation", maxChapters: 22 },
  { code: "TOB", nameFr: "Tobie", nameEn: "Tobit", maxChapters: 14 },
  { code: "JDT", nameFr: "Judith", nameEn: "Judith", maxChapters: 16 },
  { code: "WIS", nameFr: "Sagesse", nameEn: "Wisdom", maxChapters: 19 },
  { code: "SIR", nameFr: "Siracide (Ecclésiastique)", nameEn: "Sirach", maxChapters: 51 },
  { code: "BAR", nameFr: "Baruch", nameEn: "Baruch", maxChapters: 6 },
  { code: "1MA", nameFr: "1 Maccabées", nameEn: "1 Maccabees", maxChapters: 16 },
  { code: "2MA", nameFr: "2 Maccabées", nameEn: "2 Maccabees", maxChapters: 15 },
];

const bookByCode = new Map(bibleBooks.map((book) => [book.code, book]));

export const isKnownBibleBook = (code: string): boolean => bookByCode.has(code);

export const maxChaptersForBook = (code: string): number | null =>
  bookByCode.get(code)?.maxChapters ?? null;

export const bibleBookLabelFr = (code: string): string | null =>
  bookByCode.get(code)?.nameFr ?? null;

/** e.g. `{ book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 }` → `"Philippiens 4, 6-7"`. */
export const formatReferenceFr = (reference: BibleReference): string => {
  const label = bibleBookLabelFr(reference.book) ?? reference.book;
  const verses =
    reference.verseEnd > reference.verseStart
      ? `${reference.verseStart}-${reference.verseEnd}`
      : `${reference.verseStart}`;
  return `${label} ${reference.chapter}, ${verses}`;
};

/**
 * Compact `CODE=Nom français` list of every accepted `reference.book` code, e.g.
 * `"GEN=Genèse, EXO=Exode, ..."`. Used in AI-facing prompts/errors (off-list picks,
 * repair hints) so the model can see and pick a valid code instead of guessing one.
 */
export const formatBibleBookCodeList = (): string =>
  bibleBooks.map((book) => `${book.code}=${book.nameFr}`).join(", ");

/** Identity key for a reference (book/chapter/verse span), used to detect duplicate verses. */
export const referenceKey = (reference: BibleReference): string =>
  `${reference.book}:${reference.chapter}:${reference.verseStart}-${reference.verseEnd}`;
