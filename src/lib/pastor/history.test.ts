import type { AiMessage, CatalogVerse, PastorVerseBody } from "../../domain/types";
import { summarizePastorHistory } from "./history";

const PROMPT_VERSION = "pastor_verse.v1";

const catalog: CatalogVerse[] = Array.from({ length: 5 }, (_, index) => ({
  id: `verse-${index}`,
  reference: { book: "PHP", chapter: 4, verseStart: index + 1, verseEnd: index + 1 },
  principleKeys: ["priereDuSoir"],
  note: `Verset ${index}`,
}));

const body = (overrides: Partial<PastorVerseBody> = {}): PastorVerseBody => ({
  pick: "list",
  verseId: "verse-0",
  reference: { book: "PHP", chapter: 4, verseStart: 1, verseEnd: 1 },
  paraphraseFr: null,
  principleKey: null,
  intent: "reinforcement",
  title: "Titre",
  explanation: "Explication",
  practice: null,
  ...overrides,
});

const message = (overrides: Partial<AiMessage> & { date: string }): AiMessage => {
  const { date, ...rest } = overrides;
  return {
    id: `ai-message:${date}:${Math.random()}`,
    surface: "pastor_verse",
    scopeKey: `pastor:${date}`,
    stance: null,
    kind: "daily",
    inputHash: "hash",
    promptVersion: PROMPT_VERSION,
    model: "local",
    status: "ok",
    bodyJson: JSON.stringify(body()),
    bodyText: "Titre",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: `${date}T08:00:00.000Z`,
    ...rest,
  };
};

describe("summarizePastorHistory", () => {
  it("blocks verses shown in the last 7 days including today", () => {
    const messages = [
      message({ date: "2026-08-25", bodyJson: JSON.stringify(body({ verseId: "verse-1" })) }),
      message({ date: "2026-08-29", bodyJson: JSON.stringify(body({ verseId: "verse-2" })) }),
    ];

    const summary = summarizePastorHistory(messages, catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.blockedVerseIds).toContain("verse-1");
    expect(summary.blockedVerseIds).toContain("verse-2");
  });

  it("ignores shows outside the 7-day window when the catalog is large", () => {
    const messages = [
      message({ date: "2026-08-10", bodyJson: JSON.stringify(body({ verseId: "verse-1" })) }),
    ];

    const summary = summarizePastorHistory(messages, catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.blockedVerseIds).not.toContain("verse-1");
  });

  it("relaxes the blocking window when fewer than 3 catalog verses remain eligible", () => {
    const smallCatalog = catalog.slice(0, 3);
    const messages = [0, 1, 2, 3, 4, 5, 6].map((offset) =>
      message({
        date: `2026-08-${String(23 + offset).padStart(2, "0")}`,
        bodyJson: JSON.stringify(body({ verseId: `verse-${offset % 3}` })),
      }),
    );

    const summary = summarizePastorHistory(messages, smallCatalog, "2026-08-29", PROMPT_VERSION);
    // With only 3 catalog verses, a full 7-day block would leave 0 eligible; the window must
    // relax until at least something remains pickable.
    expect(smallCatalog.length - summary.blockedVerseIds.length).toBeGreaterThan(0);
  });

  it("allows an off-list pick when none happened in the previous 6 days", () => {
    const summary = summarizePastorHistory([], catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.offListAllowed).toBe(true);
  });

  it("disallows an off-list pick within 6 days of a previous off-list pick", () => {
    const messages = [
      message({
        date: "2026-08-25",
        bodyJson: JSON.stringify(
          body({
            pick: "outside",
            verseId: null,
            paraphraseFr: "Paraphrase",
            reference: { book: "GEN", chapter: 1, verseStart: 1, verseEnd: 1 },
          }),
        ),
      }),
    ];

    const summary = summarizePastorHistory(messages, catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.offListAllowed).toBe(false);
  });

  it("ignores rows on a stale prompt version", () => {
    const messages = [message({ date: "2026-08-29", promptVersion: "pastor_verse.v0" })];
    const summary = summarizePastorHistory(messages, catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.blockedVerseIds).toEqual([]);
    expect(summary.recentVerses).toEqual([]);
  });

  it("ignores rows whose scope key is not pastor:-prefixed", () => {
    const messages = [
      message({ date: "2026-08-29", scopeKey: "2026-08-29" }),
      message({ date: "2026-08-29", scopeKey: "2026-08-29#13" }),
    ];
    const summary = summarizePastorHistory(messages, catalog, "2026-08-29", PROMPT_VERSION);
    expect(summary.recentVerses).toEqual([]);
  });

  it("caps recentVerses at 30 entries", () => {
    const messages = Array.from({ length: 40 }, (_, index) => {
      const date = `2026-0${1 + Math.floor(index / 28)}-${String((index % 28) + 1).padStart(2, "0")}`;
      return message({
        date,
        bodyJson: JSON.stringify(body({ verseId: `verse-${index % 5}` })),
      });
    });

    const summary = summarizePastorHistory(messages, catalog, "2026-12-31", PROMPT_VERSION);
    expect(summary.recentVerses.length).toBeLessThanOrEqual(30);
  });
});
