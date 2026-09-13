import type { CatalogVerse } from "../../domain/types";
import { resolveVerseText, TRANSLATION_LABELS } from "./translations";

const baseVerse = (translations?: CatalogVerse["translations"]): CatalogVerse => ({
  id: "test-verse",
  reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
  principleKeys: ["priereDuSoir"],
  note: "Une reflexion.",
  ...(translations ? { translations } : {}),
});

describe("resolveVerseText", () => {
  it("returns null when translations are absent", () => {
    expect(resolveVerseText(baseVerse())).toBeNull();
  });

  it("returns null when translations is an empty object", () => {
    expect(resolveVerseText(baseVerse({}))).toBeNull();
  });

  it("prefers NRSVue over other translations", () => {
    const verse = baseVerse({ NRSVue: "Texte NRSVue", LSG1910: "Texte LSG" });
    expect(resolveVerseText(verse)).toEqual({ text: "Texte NRSVue", translation: "NRSVue" });
  });

  it("falls back through NABRE, AELF, then LSG1910 in order", () => {
    expect(resolveVerseText(baseVerse({ AELF: "Texte AELF", LSG1910: "Texte LSG" }))).toEqual({
      text: "Texte AELF",
      translation: "AELF",
    });
    expect(resolveVerseText(baseVerse({ LSG1910: "Texte LSG" }))).toEqual({
      text: "Texte LSG",
      translation: "LSG1910",
    });
  });

  it("has a label for every translation code", () => {
    expect(TRANSLATION_LABELS.LSG1910).toBe("Louis Segond 1910");
    expect(Object.keys(TRANSLATION_LABELS)).toHaveLength(4);
  });
});
