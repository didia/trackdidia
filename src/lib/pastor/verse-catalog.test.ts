import versesJson from "../../../verses.json";
import { principleDefinitions } from "../../domain/definitions";
import { loadVerseCatalog, parseVerseCatalog } from "./verse-catalog";

const validEntry = () => ({
  id: "test-verse",
  reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
  principleKeys: ["priereDuSoir"],
  themes: ["paix"],
  note: "Une reflexion originale sur la paix.",
});

describe("parseVerseCatalog", () => {
  it("accepts a minimal valid entry with no translations", () => {
    const { verses, errors } = parseVerseCatalog([validEntry()]);
    expect(errors).toEqual([]);
    expect(verses).toHaveLength(1);
    expect(verses[0].translations).toBeUndefined();
  });

  it("rejects an unknown book", () => {
    const entry = validEntry();
    entry.reference = { ...entry.reference, book: "XYZ" };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/unknown book/);
  });

  it("rejects an out-of-range chapter", () => {
    const entry = validEntry();
    entry.reference = { ...entry.reference, chapter: 99 };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/chapter out of range/);
  });

  it("rejects a non-integer chapter", () => {
    const entry = validEntry();
    entry.reference = { ...entry.reference, chapter: 4.5 };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/chapter out of range/);
  });

  it("rejects verseEnd before verseStart", () => {
    const entry = validEntry();
    entry.reference = { ...entry.reference, verseStart: 10, verseEnd: 5 };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/verseEnd must be/);
  });

  it("rejects a duplicate id", () => {
    const { verses, errors } = parseVerseCatalog([validEntry(), validEntry()]);
    expect(verses).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate id/);
  });

  it("rejects a duplicate reference across different ids", () => {
    const second = { ...validEntry(), id: "test-verse-2" };
    const { verses, errors } = parseVerseCatalog([validEntry(), second]);
    expect(verses).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate reference/);
  });

  it("rejects a bad principle key", () => {
    const entry = { ...validEntry(), principleKeys: ["notAPrinciple"] };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/principleKeys/);
  });

  it("rejects a missing note", () => {
    const entry = { ...validEntry(), note: "" };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/note is required/);
  });

  it("rejects an unknown translation code", () => {
    const entry = { ...validEntry(), translations: { KJV: "texte" } };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/invalid translation entry/);
  });

  it("accepts a populated translations object", () => {
    const entry = { ...validEntry(), translations: { LSG1910: "Texte verifie." } };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(errors).toEqual([]);
    expect(verses[0].translations).toEqual({ LSG1910: "Texte verifie." });
  });
});

describe("checked-in verses.json", () => {
  it("parses with zero errors (hard gate)", () => {
    const { errors } = parseVerseCatalog(versesJson);
    expect(errors).toEqual([]);
  });

  it("has between 40 and 80 entries", () => {
    const { verses } = parseVerseCatalog(versesJson);
    expect(verses.length).toBeGreaterThanOrEqual(40);
    expect(verses.length).toBeLessThanOrEqual(80);
  });

  it("covers all 14 principles at least once (soft report, not a gate)", () => {
    const { verses } = parseVerseCatalog(versesJson);
    const covered = new Set(verses.flatMap((verse) => verse.principleKeys));
    const missing = principleDefinitions
      .map((definition) => definition.key)
      .filter((key) => !covered.has(key));

    if (missing.length > 0) {
      console.warn(`verses.json is missing coverage for: ${missing.join(", ")}`);
    }
    expect(covered.size).toBeGreaterThan(0);
  });

  it("never ships translation text (per seeding policy)", () => {
    const { verses } = parseVerseCatalog(versesJson);
    expect(verses.every((verse) => !verse.translations)).toBe(true);
  });
});

describe("loadVerseCatalog", () => {
  it("caches and returns the checked-in catalog", () => {
    const first = loadVerseCatalog();
    const second = loadVerseCatalog();
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});
