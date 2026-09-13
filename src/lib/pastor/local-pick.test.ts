import type { CatalogVerse } from "../../domain/types";
import { pickLocalVerse } from "./local-pick";

const catalog: CatalogVerse[] = [
  {
    id: "verse-generic-1",
    reference: { book: "PHP", chapter: 4, verseStart: 13, verseEnd: 13 },
    principleKeys: ["objectifsAtteints"],
    note: "Note 1",
  },
  {
    id: "verse-generic-2",
    reference: { book: "ROM", chapter: 8, verseStart: 28, verseEnd: 28 },
    principleKeys: ["retroJournalier"],
    note: "Note 2",
  },
  {
    id: "verse-struggling",
    reference: { book: "EPH", chapter: 5, verseStart: 25, verseEnd: 25 },
    principleKeys: ["attentionAMonEpouse"],
    note: "Note 3",
  },
];

describe("pickLocalVerse", () => {
  it("is deterministic for the same date and inputs", () => {
    const first = pickLocalVerse("2026-08-29", catalog, [], []);
    const second = pickLocalVerse("2026-08-29", catalog, [], []);
    expect(first).toEqual(second);
  });

  it("prefers a verse tagged with the struggling principle when one exists", () => {
    const result = pickLocalVerse("2026-08-29", catalog, ["attentionAMonEpouse"], []);
    expect(result.verseId).toBe("verse-struggling");
    expect(result.principleKey).toBe("attentionAMonEpouse");
  });

  it("falls back to the whole catalog when no verse matches the struggling principle", () => {
    const result = pickLocalVerse("2026-08-29", catalog, ["respectTrc"], []);
    expect(catalog.map((verse) => verse.id)).toContain(result.verseId);
  });

  it("skips blocked verses", () => {
    const result = pickLocalVerse(
      "2026-08-29",
      catalog,
      ["attentionAMonEpouse"],
      ["verse-struggling"],
    );
    expect(result.verseId).not.toBe("verse-struggling");
  });

  it("falls back to the full catalog when every unblocked verse would otherwise be empty", () => {
    const ids = catalog.map((verse) => verse.id);
    const result = pickLocalVerse("2026-08-29", catalog, [], ids);
    expect(ids).toContain(result.verseId);
  });

  it("returns an empty-catalog body with no reference when the catalog is empty", () => {
    const result = pickLocalVerse("2026-08-29", [], [], []);
    expect(result.verseId).toBeNull();
    expect(result.reference).toBeNull();
    expect(result.title).toBeTruthy();
    expect(result.explanation).toBeTruthy();
  });
});
