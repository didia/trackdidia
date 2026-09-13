import { bibleBooks, formatReferenceFr, isKnownBibleBook, maxChaptersForBook } from "./bible-books";

describe("bibleBooks", () => {
  it("lists 66 protocanonical books plus 7 deuterocanonical books with unique codes", () => {
    expect(bibleBooks).toHaveLength(73);
    const codes = new Set(bibleBooks.map((book) => book.code));
    expect(codes.size).toBe(73);
  });

  it("spot-checks well-known chapter counts", () => {
    expect(maxChaptersForBook("PSA")).toBe(150);
    expect(maxChaptersForBook("GEN")).toBe(50);
    expect(maxChaptersForBook("SIR")).toBe(51);
  });

  it("uses the wider Catholic numbering for edition-sensitive books", () => {
    expect(maxChaptersForBook("JOL")).toBe(4);
    expect(maxChaptersForBook("MAL")).toBe(4);
    expect(maxChaptersForBook("DAN")).toBe(14);
    expect(maxChaptersForBook("BAR")).toBe(6);
    expect(maxChaptersForBook("EST")).toBe(16);
  });

  it("reports unknown books as unknown", () => {
    expect(isKnownBibleBook("XYZ")).toBe(false);
    expect(maxChaptersForBook("XYZ")).toBeNull();
  });

  it("formats a French reference label with a verse range", () => {
    expect(formatReferenceFr({ book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 })).toBe(
      "Philippiens 4, 6-7",
    );
  });

  it("formats a French reference label for a single verse", () => {
    expect(formatReferenceFr({ book: "MRK", chapter: 1, verseStart: 35, verseEnd: 35 })).toBe(
      "Marc 1, 35",
    );
  });
});
