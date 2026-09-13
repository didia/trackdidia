import { loadVerseCatalog } from "./verse-catalog";
import { MAX_VERSE_NUMBER_IN_BIBLE, maxVerseCeilingForBook } from "./bible-verse-counts";

describe("maxVerseCeilingForBook", () => {
  it("rejects a fabricated verse number (Genesis 1 has 31 verses)", () => {
    expect(999).toBeGreaterThan(maxVerseCeilingForBook("GEN"));
  });

  it("admits Psalm 119:176, the longest chapter in the Bible", () => {
    expect(176).toBeLessThanOrEqual(maxVerseCeilingForBook("PSA"));
  });

  it("admits Matthew 26:75", () => {
    expect(75).toBeLessThanOrEqual(maxVerseCeilingForBook("MAT"));
  });

  it("admits Acts 7:60", () => {
    expect(60).toBeLessThanOrEqual(maxVerseCeilingForBook("ACT"));
  });

  it("admits Ephesians 4:26 (the checked-in verses.json reference)", () => {
    expect(26).toBeLessThanOrEqual(maxVerseCeilingForBook("EPH"));
  });

  it("is 176 for every book (a single global ceiling — see the module doc comment)", () => {
    expect(maxVerseCeilingForBook("GEN")).toBe(MAX_VERSE_NUMBER_IN_BIBLE);
    expect(maxVerseCeilingForBook("REV")).toBe(MAX_VERSE_NUMBER_IN_BIBLE);
  });

  it("every reference in the checked-in verses.json satisfies its book's ceiling", () => {
    const catalog = loadVerseCatalog();
    expect(catalog.length).toBeGreaterThan(0);

    for (const verse of catalog) {
      const ceiling = maxVerseCeilingForBook(verse.reference.book);
      expect(verse.reference.verseEnd).toBeLessThanOrEqual(ceiling);
    }
  });
});
