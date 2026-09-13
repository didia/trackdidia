import type { CatalogVerse, PastorVerseBody, PrincipleKey } from "../../domain/types";
import { t } from "../../i18n";
import { hashString } from "../hash";
import { formatReferenceFr } from "./bible-books";

/**
 * Deterministic, AI-free pick: prefers verses tagged with the day's first struggling principle,
 * falls back to the whole (unblocked) catalog, and picks a stable index from a hash of `date` so
 * repeated calls for the same day return the same verse.
 */
export const pickLocalVerse = (
  date: string,
  catalog: CatalogVerse[],
  strugglingPrincipleKeys: PrincipleKey[],
  blockedVerseIds: string[],
): PastorVerseBody => {
  if (catalog.length === 0) {
    return {
      pick: "list",
      verseId: null,
      reference: null,
      paraphraseFr: null,
      principleKey: null,
      intent: "reinforcement",
      title: t("pastor.emptyCatalogTitle", { ns: "today" }),
      explanation: t("pastor.emptyCatalogExplanation", { ns: "today" }),
      practice: null,
    };
  }

  const blocked = new Set(blockedVerseIds);
  const unblocked = catalog.filter((verse) => !blocked.has(verse.id));
  const strugglingPool = unblocked.filter((verse) =>
    verse.principleKeys.some((key) => strugglingPrincipleKeys.includes(key)),
  );
  const pool =
    strugglingPool.length > 0 ? strugglingPool : unblocked.length > 0 ? unblocked : catalog;

  const index = hashString(date) % pool.length;
  const verse = pool[index];

  return {
    pick: "list",
    verseId: verse.id,
    reference: verse.reference,
    paraphraseFr: null,
    principleKey: verse.principleKeys[0] ?? null,
    intent: "reinforcement",
    title: formatReferenceFr(verse.reference),
    explanation: verse.note,
    practice: null,
  };
};
