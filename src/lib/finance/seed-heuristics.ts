// Bundled seed heuristics for merchants that are unambiguous in the Canadian/
// French context — see specs/todo/finance.md "Classification pipeline" stage
// 5. Confidence is capped at 0.7: a seed is a convenience, never an
// auto-apply, and the user's learned memory always outranks it (classify.ts
// only consults seeds when no memory entry exists at all).
//
// Patterns match against `merchant_key` (the output of `normalizeDescription`
// in `import-profile.ts`: uppercased, accents stripped), not the raw
// description, so classification and dedupe agree on identity. Order is
// irrelevant for correctness (categories do not overlap across entries), but
// is kept grouped for readability.

import { DEFAULT_FINANCE_CATEGORIES } from "./default-categories";

export interface SeedHeuristic {
  id: string;
  pattern: RegExp;
  categoryId: string;
  confidence: number;
}

const SEED_CONFIDENCE_CAP = 0.7;

const rawSeeds: Array<Omit<SeedHeuristic, "confidence"> & { confidence: number }> = [
  // Grocery chains
  {
    id: "seed:grocery",
    pattern: /\b(METRO|IGA|MAXI|PROVIGO|SUPER\s?C|COSTCO|WALMART|LOBLAWS|SOBEYS|ADONIS)\b/,
    categoryId: "fincat:alimentation.epicerie",
    confidence: 0.7,
  },
  // Fuel
  {
    id: "seed:fuel",
    pattern: /\b(SHELL|ESSO|PETRO.?CANADA|ULTRAMAR|CHEVRON|COUCHE.?TARD)\b/,
    categoryId: "fincat:transport.essence",
    confidence: 0.7,
  },
  // Telecom
  {
    id: "seed:telecom",
    pattern:
      /\b(BELL\s?(CANADA|MOBILIT\w*|ALIANT)|VIDEOTRON|ROGERS|TELUS|FIDO|FREEDOM\s?MOBILE|KOODO)\b/,
    categoryId: "fincat:logement.telecommunications",
    confidence: 0.65,
  },
  // Transit / rideshare
  {
    id: "seed:transit",
    pattern: /\b(STM|OPUS|UBER|LYFT|EXO|RTL|STO)\b/,
    categoryId: "fincat:transport.transport-collectif",
    confidence: 0.6,
  },
  // Streaming / subscriptions
  {
    id: "seed:streaming",
    pattern: /\b(NETFLIX|SPOTIFY|DISNEY\+?|CRAVE|APPLE\.COM\/BILL|GOOGLE\s?PLAY|AMAZON\s?PRIME)\b/,
    categoryId: "fincat:loisirs.abonnements",
    confidence: 0.65,
  },
  // Pharmacy
  {
    id: "seed:pharmacy",
    pattern: /\b(JEAN\s?COUTU|PHARMAPRIX|UNIPRIX|BRUNET|FAMILIPRIX)\b/,
    categoryId: "fincat:sante.pharmacie",
    confidence: 0.65,
  },
];

export const SEED_HEURISTICS: SeedHeuristic[] = rawSeeds.map((seed) => ({
  ...seed,
  confidence: Math.min(seed.confidence, SEED_CONFIDENCE_CAP),
}));

// Fails loudly in CI rather than silently pointing a seed at a category id
// that does not exist in the taxonomy (see default-categories.ts).
const KNOWN_CATEGORY_IDS = new Set(DEFAULT_FINANCE_CATEGORIES.map((category) => category.id));
for (const seed of SEED_HEURISTICS) {
  if (!KNOWN_CATEGORY_IDS.has(seed.categoryId)) {
    throw new Error(`seed-heuristics.ts: unknown category id ${seed.categoryId} for ${seed.id}`);
  }
}
