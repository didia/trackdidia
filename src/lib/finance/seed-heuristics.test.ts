import { DEFAULT_FINANCE_CATEGORIES } from "./default-categories";
import { merchantKey } from "./import-profile";
import { SEED_HEURISTICS } from "./seed-heuristics";

describe("SEED_HEURISTICS", () => {
  it("caps every confidence at 0.7", () => {
    for (const seed of SEED_HEURISTICS) {
      expect(seed.confidence).toBeLessThanOrEqual(0.7);
    }
  });

  it("points every categoryId at a known default category", () => {
    const ids = new Set(DEFAULT_FINANCE_CATEGORIES.map((category) => category.id));
    for (const seed of SEED_HEURISTICS) {
      expect(ids.has(seed.categoryId)).toBe(true);
    }
  });

  it("has unique seed ids", () => {
    const ids = SEED_HEURISTICS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  const cases: Array<[string, string]> = [
    ["IGA #1234 MONTREAL", "fincat:alimentation.epicerie"],
    ["METRO PLUS", "fincat:alimentation.epicerie"],
    ["COSTCO WHOLESALE", "fincat:alimentation.epicerie"],
    ["SHELL C12345", "fincat:transport.essence"],
    ["PETRO-CANADA", "fincat:transport.essence"],
    ["VIDEOTRON LTEE", "fincat:logement.telecommunications"],
    ["BELL MOBILITE", "fincat:logement.telecommunications"],
    ["STM MONTREAL", "fincat:transport.transport-collectif"],
    ["UBER TRIP", "fincat:transport.transport-collectif"],
    ["NETFLIX.COM", "fincat:loisirs.abonnements"],
    ["SPOTIFY P1A2B3", "fincat:loisirs.abonnements"],
    ["PHARMACIE JEAN COUTU", "fincat:sante.pharmacie"],
    ["UNIPRIX ST LAURENT", "fincat:sante.pharmacie"],
  ];

  for (const [description, categoryId] of cases) {
    it(`matches ${description} to ${categoryId}`, () => {
      const key = merchantKey(description);
      const match = SEED_HEURISTICS.find((seed) => seed.pattern.test(key));
      expect(match?.categoryId).toBe(categoryId);
    });
  }

  it("does not match an unrelated merchant", () => {
    const key = merchantKey("ACME WIDGET CORP");
    const match = SEED_HEURISTICS.find((seed) => seed.pattern.test(key));
    expect(match).toBeUndefined();
  });
});
