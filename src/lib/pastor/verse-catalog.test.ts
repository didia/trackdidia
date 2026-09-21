import versesJson from "../../../verses.json";
import {
  credoKeys as allCredoKeys,
  MAX_CREDO_KEYS,
  principleKeyToCredoKeys,
} from "../../domain/credo";
import { principleDefinitions } from "../../domain/definitions";
import { buildCatalogWithCustomVerses, loadVerseCatalog, parseVerseCatalog } from "./verse-catalog";

const validEntry = () => ({
  id: "test-verse",
  reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
  principleKeys: ["priereDuSoir"],
  credoKeys: ["procheDeDieu"],
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

  it("keeps explicit credoKeys as authored", () => {
    const entry = { ...validEntry(), credoKeys: ["discipline", "empathie"] };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(errors).toEqual([]);
    expect(verses[0].credoKeys).toEqual(["discipline", "empathie"]);
  });

  it("dedupes repeated credo keys, like the derived path", () => {
    const entry = { ...validEntry(), credoKeys: ["procheDeDieu", "procheDeDieu"] };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(errors).toEqual([]);
    expect(verses[0].credoKeys).toEqual(["procheDeDieu"]);
  });

  it("rejects an unknown credo key", () => {
    const entry = { ...validEntry(), credoKeys: ["notACredoItem"] };
    const { verses, errors } = parseVerseCatalog([entry]);
    expect(verses).toHaveLength(0);
    expect(errors[0]).toMatch(/unknown credo key/);
  });

  it("rejects empty or oversized credoKeys", () => {
    const empty = parseVerseCatalog([{ ...validEntry(), credoKeys: [] }]);
    expect(empty.verses).toHaveLength(0);
    expect(empty.errors[0]).toMatch(/credoKeys must have 1 to 3 entries/);

    const tooMany = parseVerseCatalog([
      {
        ...validEntry(),
        credoKeys: ["procheDeDieu", "discipline", "empathie", "amourEnActes"],
      },
    ]);
    expect(tooMany.verses).toHaveLength(0);
    expect(tooMany.errors[0]).toMatch(/credoKeys must have 1 to 3 entries/);
  });

  it("derives credoKeys from principleKeys when the field is absent", () => {
    // The legacy path: custom verses stored in `settings.aiPastorCustomVerses` before the
    // credo axis existed must keep parsing instead of being dropped.
    const { credoKeys: _omitted, ...entry } = validEntry();
    const { verses, errors } = parseVerseCatalog([{ ...entry, principleKeys: ["respectReveil"] }]);
    expect(errors).toEqual([]);
    expect(verses[0].credoKeys).toEqual(principleKeyToCredoKeys.respectReveil);
  });
});

describe("checked-in verses.json", () => {
  it("parses with zero errors (hard gate)", () => {
    const { errors } = parseVerseCatalog(versesJson);
    expect(errors).toEqual([]);
  });

  it("has between 40 and 200 entries", () => {
    const { verses } = parseVerseCatalog(versesJson);
    expect(verses.length).toBeGreaterThanOrEqual(40);
    expect(verses.length).toBeLessThanOrEqual(200);
  });

  it("authors 1 to MAX_CREDO_KEYS valid credo keys on every entry (hard gate)", () => {
    // Asserted against the raw JSON, not the parsed output: the parser derives `credoKeys` from
    // `principleKeys` whenever the field is absent, so the same check on `verses` would hold
    // even if every entry in the file had no credo key at all.
    const offenders = (versesJson as { id: string; credoKeys?: unknown }[]).filter(
      ({ credoKeys }) =>
        !Array.isArray(credoKeys) ||
        credoKeys.length === 0 ||
        credoKeys.length > MAX_CREDO_KEYS ||
        !credoKeys.every((key) => allCredoKeys.includes(key as never)),
    );
    expect(offenders.map((entry) => entry.id)).toEqual([]);
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

describe("buildCatalogWithCustomVerses", () => {
  it("returns the checked-in catalog unchanged when there are no custom verses", () => {
    const { verses, errors } = buildCatalogWithCustomVerses(undefined);
    expect(errors).toEqual([]);
    expect(verses).toEqual(loadVerseCatalog());
  });

  it("appends a valid custom verse", () => {
    const custom = validEntry();
    custom.id = "custom-php-4-6-7";
    custom.reference = { book: "PHP", chapter: 4, verseStart: 20, verseEnd: 20 };

    const { verses, errors } = buildCatalogWithCustomVerses([custom]);
    expect(errors).toEqual([]);
    expect(verses).toHaveLength(loadVerseCatalog().length + 1);
    expect(verses.some((verse) => verse.id === "custom-php-4-6-7")).toBe(true);
  });

  it("drops a custom verse whose reference duplicates a checked-in one", () => {
    const base = loadVerseCatalog()[0];
    const custom = validEntry();
    custom.id = "custom-duplicate";
    custom.reference = { ...base.reference };

    const { verses, errors } = buildCatalogWithCustomVerses([custom]);
    expect(errors.length).toBeGreaterThan(0);
    expect(verses.some((verse) => verse.id === "custom-duplicate")).toBe(false);
    expect(verses).toHaveLength(loadVerseCatalog().length);
  });

  it("drops an invalid custom verse without throwing", () => {
    const invalid = {
      id: "custom-bad",
      reference: { book: "XYZ", chapter: 1, verseStart: 1, verseEnd: 1 },
    };

    const { verses, errors } = buildCatalogWithCustomVerses([invalid]);
    expect(errors.length).toBeGreaterThan(0);
    expect(verses).toEqual(loadVerseCatalog());
  });

  it("ignores a non-array value", () => {
    const { verses, errors } = buildCatalogWithCustomVerses("not-an-array");
    expect(errors).toEqual([]);
    expect(verses).toEqual(loadVerseCatalog());
  });
});
