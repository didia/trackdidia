import versesJson from "../../../verses.json";
import { principleDefinitions } from "../../domain/definitions";
import type {
  BibleReference,
  CatalogVerse,
  PrincipleKey,
  TranslationCode,
} from "../../domain/types";
import { logDebug } from "../debug";
import { isKnownBibleBook, maxChaptersForBook } from "./bible-books";

const principleKeySet = new Set<PrincipleKey>(
  principleDefinitions.map((definition) => definition.key),
);
const translationCodes = new Set<TranslationCode>(["NRSVue", "NABRE", "AELF", "LSG1910"]);

/** Mirrors the off-list validator cap (`pastor-verse-validator.ts`) but is looser for catalog authors. */
const MAX_VERSE_SPAN = 15;

export interface VerseCatalogParseResult {
  verses: CatalogVerse[];
  errors: string[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateReference = (
  raw: unknown,
  label: string,
): { ok: true; value: BibleReference } | { ok: false; error: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: `${label}: reference must be an object` };
  }

  const record = raw as Record<string, unknown>;
  const book = record.book;
  if (typeof book !== "string" || !isKnownBibleBook(book)) {
    return { ok: false, error: `${label}: unknown book "${String(book)}"` };
  }

  const maxChapters = maxChaptersForBook(book) ?? 0;
  const chapter = record.chapter;
  if (
    typeof chapter !== "number" ||
    !Number.isInteger(chapter) ||
    chapter < 1 ||
    chapter > maxChapters
  ) {
    return { ok: false, error: `${label}: chapter out of range for ${book}` };
  }

  const verseStart = record.verseStart;
  if (typeof verseStart !== "number" || !Number.isInteger(verseStart) || verseStart < 1) {
    return { ok: false, error: `${label}: verseStart must be >= 1` };
  }

  const verseEnd = record.verseEnd;
  if (typeof verseEnd !== "number" || !Number.isInteger(verseEnd) || verseEnd < verseStart) {
    return { ok: false, error: `${label}: verseEnd must be >= verseStart` };
  }

  if (verseEnd - verseStart > MAX_VERSE_SPAN) {
    return { ok: false, error: `${label}: verse span too large (max ${MAX_VERSE_SPAN})` };
  }

  return { ok: true, value: { book, chapter, verseStart, verseEnd } };
};

/**
 * Pure parser for the `verses.json` shape. Never throws — invalid entries are reported as
 * `errors` and dropped so a single bad row never crashes the pastor feature at runtime.
 */
export const parseVerseCatalog = (raw: unknown): VerseCatalogParseResult => {
  const verses: CatalogVerse[] = [];
  const errors: string[] = [];

  if (!Array.isArray(raw)) {
    return { verses, errors: ["verses.json must be an array"] };
  }

  const seenIds = new Set<string>();
  const seenReferences = new Set<string>();

  raw.forEach((entry, index) => {
    const label = `entry ${index}`;

    if (typeof entry !== "object" || entry === null) {
      errors.push(`${label}: must be an object`);
      return;
    }

    const record = entry as Record<string, unknown>;

    if (!isNonEmptyString(record.id)) {
      errors.push(`${label}: id is required`);
      return;
    }
    const id = record.id.trim();
    if (seenIds.has(id)) {
      errors.push(`${label} (${id}): duplicate id`);
      return;
    }

    const referenceResult = validateReference(record.reference, `${label} (${id})`);
    if (!referenceResult.ok) {
      errors.push(referenceResult.error);
      return;
    }
    const reference = referenceResult.value;
    const referenceKey = `${reference.book}:${reference.chapter}:${reference.verseStart}-${reference.verseEnd}`;
    if (seenReferences.has(referenceKey)) {
      errors.push(`${label} (${id}): duplicate reference ${referenceKey}`);
      return;
    }

    if (
      !Array.isArray(record.principleKeys) ||
      record.principleKeys.length === 0 ||
      record.principleKeys.length > 3
    ) {
      errors.push(`${label} (${id}): principleKeys must have 1 to 3 entries`);
      return;
    }
    const rawPrincipleKeys = record.principleKeys as unknown[];
    const validPrincipleKeys = rawPrincipleKeys.every(
      (key) => typeof key === "string" && principleKeySet.has(key as PrincipleKey),
    );
    if (!validPrincipleKeys) {
      errors.push(`${label} (${id}): principleKeys contains an unknown principle key`);
      return;
    }

    if (!isNonEmptyString(record.note)) {
      errors.push(`${label} (${id}): note is required`);
      return;
    }

    let translations: Partial<Record<TranslationCode, string>> | undefined;
    if (record.translations !== undefined) {
      if (typeof record.translations !== "object" || record.translations === null) {
        errors.push(`${label} (${id}): translations must be an object`);
        return;
      }
      const translationRecord = record.translations as Record<string, unknown>;
      const parsedTranslations: Partial<Record<TranslationCode, string>> = {};
      for (const [code, text] of Object.entries(translationRecord)) {
        if (!translationCodes.has(code as TranslationCode) || !isNonEmptyString(text)) {
          errors.push(`${label} (${id}): invalid translation entry "${code}"`);
          return;
        }
        parsedTranslations[code as TranslationCode] = text.trim();
      }
      if (Object.keys(parsedTranslations).length > 0) {
        translations = parsedTranslations;
      }
    }

    let themes: string[] | undefined;
    if (record.themes !== undefined) {
      if (
        !Array.isArray(record.themes) ||
        !record.themes.every((theme) => typeof theme === "string")
      ) {
        errors.push(`${label} (${id}): themes must be an array of strings`);
        return;
      }
      themes = record.themes.length > 0 ? (record.themes as string[]) : undefined;
    }

    seenIds.add(id);
    seenReferences.add(referenceKey);
    verses.push({
      id,
      reference,
      principleKeys: rawPrincipleKeys as PrincipleKey[],
      ...(themes ? { themes } : {}),
      ...(translations ? { translations } : {}),
      note: record.note.trim(),
    });
  });

  return { verses, errors };
};

let cachedCatalog: VerseCatalogParseResult | null = null;

/** Parses and caches the checked-in `verses.json`, logging (not throwing on) invalid entries. */
export const loadVerseCatalog = (): CatalogVerse[] => {
  if (!cachedCatalog) {
    cachedCatalog = parseVerseCatalog(versesJson);
    for (const error of cachedCatalog.errors) {
      logDebug("warn", "pastor.catalog", "Entrée verses.json invalide ignorée", error);
    }
  }
  return cachedCatalog.verses;
};
