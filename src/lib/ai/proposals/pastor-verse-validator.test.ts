import type { CatalogVerse } from "../../../domain/types";
import { parsePastorVerseJson, type PastorVerseValidationContext } from "./pastor-verse-validator";

const catalog: CatalogVerse[] = [
  {
    id: "php-4-6-7",
    reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
    principleKeys: ["priereDuSoir"],
    note: "Note",
  },
  {
    id: "verse-blocked",
    reference: { book: "ROM", chapter: 8, verseStart: 28, verseEnd: 28 },
    principleKeys: ["retroJournalier"],
    note: "Note",
  },
];

const baseCtx = (
  overrides: Partial<PastorVerseValidationContext> = {},
): PastorVerseValidationContext => ({
  catalog,
  blockedVerseIds: ["verse-blocked"],
  offListAllowed: true,
  ...overrides,
});

const validListPayload = () =>
  JSON.stringify({
    pick: "list",
    verseId: "php-4-6-7",
    principleKey: null,
    intent: "reinforcement",
    title: "Philippiens 4, 6-7",
    explanation: "Ancrage bref. Enseignement bref.",
    practice: null,
  });

describe("parsePastorVerseJson", () => {
  it("accepts a valid list pick", () => {
    const parsed = parsePastorVerseJson(validListPayload(), baseCtx());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.verseId).toBe("php-4-6-7");
      expect(parsed.value.reference).toEqual({
        book: "PHP",
        chapter: 4,
        verseStart: 6,
        verseEnd: 7,
      });
    }
  });

  it("rejects a blocked verseId", () => {
    const payload = JSON.stringify({
      pick: "list",
      verseId: "verse-blocked",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown verseId", () => {
    const payload = JSON.stringify({
      pick: "list",
      verseId: "does-not-exist",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("includes the valid book codes in the repair hint for an unknown book", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "XYZ", chapter: 1, verseStart: 1, verseEnd: 1 },
      paraphraseFr: "Une paraphrase.",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("PHP=Philippiens");
    }
  });

  it("rejects a non-integer chapter or verse number", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "GEN", chapter: 1.5, verseStart: 1, verseEnd: 1 },
      paraphraseFr: "Une paraphrase.",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("rejects an off-list pick when offListAllowed is false", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "GEN", chapter: 1, verseStart: 1, verseEnd: 1 },
      paraphraseFr: "Une paraphrase.",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx({ offListAllowed: false }));
    expect(parsed.ok).toBe(false);
  });

  it("requires paraphraseFr for an off-list pick", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "GEN", chapter: 1, verseStart: 1, verseEnd: 1 },
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("accepts a valid off-list pick with a paraphrase", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "GEN", chapter: 1, verseStart: 1, verseEnd: 1 },
      paraphraseFr: "Une paraphrase courte.",
      principleKey: null,
      intent: "new_teaching",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.pick).toBe("outside");
      expect(parsed.value.verseId).toBeNull();
    }
  });

  it("normalizes an off-list pick that exactly matches a catalog reference", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
      paraphraseFr: "Une paraphrase.",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.pick).toBe("list");
      expect(parsed.value.verseId).toBe("php-4-6-7");
      expect(parsed.value.paraphraseFr).toBeNull();
    }
  });

  it("rejects a normalized exact match when that catalog verse is blocked", () => {
    const payload = JSON.stringify({
      pick: "outside",
      reference: { book: "ROM", chapter: 8, verseStart: 28, verseEnd: 28 },
      paraphraseFr: "Une paraphrase.",
      principleKey: null,
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("rejects an invalid enum value", () => {
    const payload = JSON.stringify({
      pick: "list",
      verseId: "php-4-6-7",
      principleKey: "notARealPrinciple",
      intent: "reinforcement",
      title: "Titre",
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("rejects a title over the length cap", () => {
    const payload = JSON.stringify({
      pick: "list",
      verseId: "php-4-6-7",
      principleKey: null,
      intent: "reinforcement",
      title: "x".repeat(81),
      explanation: "Explication",
    });
    const parsed = parsePastorVerseJson(payload, baseCtx());
    expect(parsed.ok).toBe(false);
  });

  it("rejects invalid JSON", () => {
    const parsed = parsePastorVerseJson("not json", baseCtx());
    expect(parsed.ok).toBe(false);
  });
});
