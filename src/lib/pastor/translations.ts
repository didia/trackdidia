import type { CatalogVerse, TranslationCode } from "../../domain/types";

export const TRANSLATION_LABELS: Record<TranslationCode, string> = {
  NRSVue: "NRSVue",
  NABRE: "NABRE",
  AELF: "AELF",
  LSG1910: "Louis Segond 1910",
};

/** Shown only when the corresponding translation's text is actually displayed. */
export const TRANSLATION_NOTICES: Partial<Record<TranslationCode, string>> = {
  NRSVue:
    "Texte NRSVue (National Council of Churches) : confirme les conditions de citation avant toute diffusion publique.",
  NABRE:
    "Texte NABRE (USCCB) : confirme les conditions de citation avant toute diffusion publique.",
  AELF: "Texte AELF : confirme les conditions de citation avant toute diffusion publique.",
};

const TRANSLATION_ORDER: TranslationCode[] = ["NRSVue", "NABRE", "AELF", "LSG1910"];

export interface ResolvedVerseText {
  text: string;
  translation: TranslationCode;
}

/** First available translation in preference order, or `null` when no text has been added yet. */
export const resolveVerseText = (verse: CatalogVerse): ResolvedVerseText | null => {
  if (!verse.translations) {
    return null;
  }

  for (const translation of TRANSLATION_ORDER) {
    const text = verse.translations[translation];
    if (text?.trim()) {
      return { text: text.trim(), translation };
    }
  }

  return null;
};
