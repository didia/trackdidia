import { principleDefinitions } from "../../../domain/definitions";
import type {
  BibleReference,
  CatalogVerse,
  PastorVerseBody,
  PastorVerseIntent,
  PrincipleKey,
} from "../../../domain/types";
import {
  formatBibleBookCodeList,
  isKnownBibleBook,
  maxChaptersForBook,
} from "../../pastor/bible-books";

const principleKeys = new Set<PrincipleKey>(
  principleDefinitions.map((definition) => definition.key),
);
const intents = new Set<PastorVerseIntent>(["reinforcement", "new_teaching", "both"]);
const pastorVersePicks = new Set(["list", "outside"]);

const MAX_OFF_LIST_VERSE_SPAN = 10;
const MAX_TITLE_LENGTH = 80;
const MAX_EXPLANATION_LENGTH = 900;
const MAX_PRACTICE_LENGTH = 160;
const MAX_PARAPHRASE_LENGTH = 400;

export interface PastorVerseValidationContext {
  catalog: CatalogVerse[];
  blockedVerseIds: string[];
  offListAllowed: boolean;
}

type ParseResult = { ok: true; value: PastorVerseBody } | { ok: false; error: string };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isWithinLength = (value: string, max: number): boolean => value.trim().length <= max;

const validateReferenceShape = (
  value: unknown,
): { ok: true; value: BibleReference } | { ok: false; error: string } => {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "reference must be an object" };
  }

  const record = value as Record<string, unknown>;
  const book = record.book;
  if (typeof book !== "string" || !isKnownBibleBook(book)) {
    return {
      ok: false,
      error: `reference.book is unknown; valid codes: ${formatBibleBookCodeList()}`,
    };
  }

  const maxChapters = maxChaptersForBook(book) ?? 0;
  const chapter = record.chapter;
  if (
    typeof chapter !== "number" ||
    !Number.isInteger(chapter) ||
    chapter < 1 ||
    chapter > maxChapters
  ) {
    return { ok: false, error: "reference.chapter is out of range" };
  }

  const verseStart = record.verseStart;
  if (typeof verseStart !== "number" || !Number.isInteger(verseStart) || verseStart < 1) {
    return { ok: false, error: "reference.verseStart must be >= 1" };
  }

  const verseEnd = record.verseEnd;
  if (typeof verseEnd !== "number" || !Number.isInteger(verseEnd) || verseEnd < verseStart) {
    return { ok: false, error: "reference.verseEnd must be >= verseStart" };
  }

  if (verseEnd - verseStart > MAX_OFF_LIST_VERSE_SPAN) {
    return { ok: false, error: "reference span is too large" };
  }

  return { ok: true, value: { book, chapter, verseStart, verseEnd } };
};

const sameReference = (left: BibleReference, right: BibleReference): boolean =>
  left.book === right.book &&
  left.chapter === right.chapter &&
  left.verseStart === right.verseStart &&
  left.verseEnd === right.verseEnd;

export const validatePastorVerseResponse = (
  payload: unknown,
  ctx: PastorVerseValidationContext,
): ParseResult => {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: "Response must be a JSON object" };
  }

  const record = payload as Record<string, unknown>;

  if (record.pick !== "list" && record.pick !== "outside") {
    return { ok: false, error: "pick must be 'list' or 'outside'" };
  }

  if (
    record.principleKey !== null &&
    record.principleKey !== undefined &&
    !principleKeys.has(String(record.principleKey) as PrincipleKey)
  ) {
    return { ok: false, error: "principleKey must be a valid principle key or null" };
  }
  const principleKey = (record.principleKey ?? null) as PrincipleKey | null;

  if (!intents.has(String(record.intent) as PastorVerseIntent)) {
    return { ok: false, error: "intent is invalid" };
  }
  const intent = record.intent as PastorVerseIntent;

  if (!isNonEmptyString(record.title) || !isWithinLength(record.title, MAX_TITLE_LENGTH)) {
    return {
      ok: false,
      error: `title is required and must be at most ${MAX_TITLE_LENGTH} characters`,
    };
  }
  const title = record.title.trim();

  if (
    !isNonEmptyString(record.explanation) ||
    !isWithinLength(record.explanation, MAX_EXPLANATION_LENGTH)
  ) {
    return {
      ok: false,
      error: `explanation is required and must be at most ${MAX_EXPLANATION_LENGTH} characters`,
    };
  }
  const explanation = record.explanation.trim();

  if (
    record.practice !== undefined &&
    record.practice !== null &&
    (typeof record.practice !== "string" || !isWithinLength(record.practice, MAX_PRACTICE_LENGTH))
  ) {
    return { ok: false, error: `practice must be at most ${MAX_PRACTICE_LENGTH} characters` };
  }
  const practice = isNonEmptyString(record.practice) ? record.practice.trim() : null;

  if (record.pick === "list") {
    if (!isNonEmptyString(record.verseId)) {
      return { ok: false, error: "verseId is required for a list pick" };
    }
    const verseId = record.verseId.trim();
    if (ctx.blockedVerseIds.includes(verseId)) {
      return { ok: false, error: `verseId "${verseId}" was shown too recently` };
    }
    const verse = ctx.catalog.find((item) => item.id === verseId);
    if (!verse) {
      return { ok: false, error: `verseId "${verseId}" is not in the catalog` };
    }

    return {
      ok: true,
      value: {
        pick: "list",
        verseId,
        reference: verse.reference,
        paraphraseFr: null,
        principleKey,
        intent,
        title,
        explanation,
        practice,
      },
    };
  }

  if (!ctx.offListAllowed) {
    return { ok: false, error: "off-list picks are not allowed right now" };
  }

  const referenceResult = validateReferenceShape(record.reference);
  if (!referenceResult.ok) {
    return referenceResult;
  }

  if (
    !isNonEmptyString(record.paraphraseFr) ||
    !isWithinLength(record.paraphraseFr, MAX_PARAPHRASE_LENGTH)
  ) {
    return {
      ok: false,
      error: `paraphraseFr is required for an off-list pick and must be at most ${MAX_PARAPHRASE_LENGTH} characters`,
    };
  }

  const exactMatch = ctx.catalog.find((verse) =>
    sameReference(verse.reference, referenceResult.value),
  );
  if (exactMatch) {
    if (ctx.blockedVerseIds.includes(exactMatch.id)) {
      return {
        ok: false,
        error: `matched catalog verse "${exactMatch.id}" was shown too recently`,
      };
    }

    return {
      ok: true,
      value: {
        pick: "list",
        verseId: exactMatch.id,
        reference: exactMatch.reference,
        paraphraseFr: null,
        principleKey,
        intent,
        title,
        explanation,
        practice,
      },
    };
  }

  return {
    ok: true,
    value: {
      pick: "outside",
      verseId: null,
      reference: referenceResult.value,
      paraphraseFr: record.paraphraseFr.trim(),
      principleKey,
      intent,
      title,
      explanation,
      practice,
    },
  };
};

export const parsePastorVerseJson = (
  raw: string,
  ctx: PastorVerseValidationContext,
): ParseResult => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validatePastorVerseResponse(parsed, ctx);
  } catch {
    return { ok: false, error: "Response is not valid JSON" };
  }
};

/**
 * Lenient shape-only parser for already-normalized stored rows (loader/history reads). No
 * catalog/blocked context is needed or applied here — that validation already happened once,
 * when the row was written.
 */
export const parseStoredPastorBody = (raw: string | null): PastorVerseBody | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!pastorVersePicks.has(String(parsed.pick))) {
      return null;
    }
    if (!intents.has(String(parsed.intent) as PastorVerseIntent)) {
      return null;
    }
    if (typeof parsed.title !== "string" || typeof parsed.explanation !== "string") {
      return null;
    }

    let reference: BibleReference | null = null;
    if (parsed.reference && typeof parsed.reference === "object") {
      const record = parsed.reference as Record<string, unknown>;
      if (
        typeof record.book === "string" &&
        typeof record.chapter === "number" &&
        typeof record.verseStart === "number" &&
        typeof record.verseEnd === "number"
      ) {
        reference = {
          book: record.book,
          chapter: record.chapter,
          verseStart: record.verseStart,
          verseEnd: record.verseEnd,
        };
      }
    }

    return {
      pick: parsed.pick as PastorVerseBody["pick"],
      verseId: typeof parsed.verseId === "string" ? parsed.verseId : null,
      reference,
      paraphraseFr: typeof parsed.paraphraseFr === "string" ? parsed.paraphraseFr : null,
      principleKey:
        parsed.principleKey && principleKeys.has(String(parsed.principleKey) as PrincipleKey)
          ? (parsed.principleKey as PrincipleKey)
          : null,
      intent: parsed.intent as PastorVerseIntent,
      title: parsed.title,
      explanation: parsed.explanation,
      practice: typeof parsed.practice === "string" ? parsed.practice : null,
    };
  } catch {
    return null;
  }
};
