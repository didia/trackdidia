import type { PastorVerseBody } from "../../domain/types";
import { loadVerseCatalog } from "./verse-catalog";
import { addCustomVerse, buildCustomVerseFromOffListPick } from "./custom-verse";

const offListBody = (overrides: Partial<PastorVerseBody> = {}): PastorVerseBody => ({
  pick: "outside",
  verseId: null,
  reference: { book: "GEN", chapter: 50, verseStart: 20, verseEnd: 20 },
  paraphraseFr: "Une paraphrase.",
  principleKey: "managedSolitude",
  intent: "new_teaching",
  title: "Genèse 50, 20",
  explanation: "Ce que d'autres ont voulu pour du mal, Dieu l'a change en bien.",
  practice: null,
  ...overrides,
});

describe("buildCustomVerseFromOffListPick", () => {
  it("builds a catalog entry from an off-list pick", () => {
    const verse = buildCustomVerseFromOffListPick(offListBody());
    expect(verse).toEqual({
      id: "custom-gen-50-20",
      reference: { book: "GEN", chapter: 50, verseStart: 20, verseEnd: 20 },
      principleKeys: ["managedSolitude"],
      note: "Ce que d'autres ont voulu pour du mal, Dieu l'a change en bien.",
    });
  });

  it("includes the verse span in the id for a multi-verse reference", () => {
    const verse = buildCustomVerseFromOffListPick(
      offListBody({ reference: { book: "GEN", chapter: 50, verseStart: 19, verseEnd: 21 } }),
    );
    expect(verse?.id).toBe("custom-gen-50-19-21");
  });

  it("returns null for a list pick", () => {
    expect(buildCustomVerseFromOffListPick(offListBody({ pick: "list" }))).toBeNull();
  });

  it("returns null when there is no reference", () => {
    expect(buildCustomVerseFromOffListPick(offListBody({ reference: null }))).toBeNull();
  });

  it("returns null when there is no principle key", () => {
    expect(buildCustomVerseFromOffListPick(offListBody({ principleKey: null }))).toBeNull();
  });

  it("returns null when the explanation is empty", () => {
    expect(buildCustomVerseFromOffListPick(offListBody({ explanation: "   " }))).toBeNull();
  });

  it("never uses the AI paraphrase as verse text", () => {
    const verse = buildCustomVerseFromOffListPick(offListBody());
    expect(verse?.note).not.toContain("paraphrase");
    expect(verse && "translations" in verse).toBe(false);
  });
});

describe("addCustomVerse", () => {
  const candidate = () => buildCustomVerseFromOffListPick(offListBody())!;

  it("appends the candidate to an empty list", () => {
    const result = addCustomVerse([], candidate());
    expect(result.added).toBe(true);
    expect(result.customVerses).toEqual([candidate()]);
  });

  it("appends the candidate after existing custom verses", () => {
    const existing = buildCustomVerseFromOffListPick(
      offListBody({ reference: { book: "JOB", chapter: 42, verseStart: 10, verseEnd: 10 } }),
    )!;
    const result = addCustomVerse([existing], candidate());
    expect(result.added).toBe(true);
    expect(result.customVerses).toEqual([existing, candidate()]);
  });

  it("is a no-op when the reference is already a custom verse", () => {
    const result = addCustomVerse([candidate()], candidate());
    expect(result.added).toBe(false);
    expect(result.customVerses).toEqual([candidate()]);
  });

  it("is a no-op when the reference already exists in the checked-in catalog", () => {
    const base = loadVerseCatalog()[0];
    const duplicate = buildCustomVerseFromOffListPick(offListBody({ reference: base.reference }))!;
    const result = addCustomVerse([], duplicate);
    expect(result.added).toBe(false);
    expect(result.customVerses).toEqual([]);
  });

  it("treats a non-array existing value as an empty list", () => {
    const result = addCustomVerse(undefined, candidate());
    expect(result.added).toBe(true);
    expect(result.customVerses).toEqual([candidate()]);
  });
});
