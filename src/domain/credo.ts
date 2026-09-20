import type { PrincipleKey } from "./types";

/**
 * The ten items of the personal credo, in its written order. A different axis from the fourteen
 * daily `PrincipleKey` checkboxes: principles are what gets checked off each day and feeds the
 * discipline score, while the credo is the standing statement the `verses.json` catalog is
 * curated against.
 *
 * Only the keys live here. The credo's own wording is personal first-person writing and this
 * repository is public, so the statements are deliberately not committed — they are the author's
 * to keep. The short glosses below exist to make the keys legible and say no more than the key
 * names already do:
 *
 * 1 prayer and daily meditation · 2 acting only on what is within reach · 3 refusing worry
 * 4 failure as material to learn from · 5 discipline as the source of freedom
 * 6 listening to understand rather than judge · 7 love expressed in actions
 * 8 keeping the commitments one makes · 9 choosing contentment · 10 health and fitness
 */
export type CredoKey =
  | "procheDeDieu"
  | "cercleDeControle"
  | "sansInquietude"
  | "echecsCommeLecons"
  | "discipline"
  | "empathie"
  | "amourEnActes"
  | "engagementsTenus"
  | "choixDuBonheur"
  | "programme4P";

export const credoKeys: CredoKey[] = [
  "procheDeDieu",
  "cercleDeControle",
  "sansInquietude",
  "echecsCommeLecons",
  "discipline",
  "empathie",
  "amourEnActes",
  "engagementsTenus",
  "choixDuBonheur",
  "programme4P",
];

const credoKeySet = new Set<CredoKey>(credoKeys);

export const isCredoKey = (value: unknown): value is CredoKey =>
  typeof value === "string" && credoKeySet.has(value as CredoKey);

/**
 * Bridge from a daily principle to the credo items it serves. Used to derive `credoKeys` for a
 * catalog entry that predates the field — notably the custom verses already stored in
 * `settings.aiPastorCustomVerses`, which must keep parsing rather than being dropped.
 * Every `PrincipleKey` maps to at least one credo item (`credo.test.ts` enforces this).
 *
 * This is a fallback, not editorial intent. It has to be total, so every principle gets a
 * plausible credo item even where the curation concluded there is no real match — `ecriture` is
 * the clear case: journaling is a daily checkbox with no credo item behind it (which is why the
 * catalog has no écriture verse at all), and it is mapped here only so the function is total.
 * Roughly a quarter of the catalog's authored `credoKeys` share nothing with what this bridge
 * would derive from the same `principleKeys`, so a derived value is a reasonable default and
 * not a substitute for tagging an entry by hand.
 */
export const principleKeyToCredoKeys: Record<PrincipleKey, CredoKey[]> = {
  priereDuMatin: ["procheDeDieu"],
  priereDuSoir: ["procheDeDieu"],
  avoirLuMesPrincipes: ["procheDeDieu"],
  managedSolitude: ["procheDeDieu"],
  respectDeVieCommeJesus: ["procheDeDieu", "discipline"],
  apprentissage: ["echecsCommeLecons"],
  retroJournalier: ["echecsCommeLecons"],
  respectReveil: ["discipline"],
  respectTrc: ["discipline"],
  oxytocineDuMatin: ["amourEnActes"],
  attentionAMonEpouse: ["amourEnActes"],
  tempsDeQualiteAvecEnfants: ["amourEnActes"],
  objectifsAtteints: ["engagementsTenus"],
  // Totality only — journaling has no credo item. See the note above.
  ecriture: ["engagementsTenus"],
};

/** Max `credoKeys` on a catalog entry. Mirrors the `principleKeys` cap in `verse-catalog.ts`. */
export const MAX_CREDO_KEYS = 3;

/** Deduped, capped credo keys for a set of principle keys. Never returns an empty array. */
export const deriveCredoKeys = (principleKeys: PrincipleKey[]): CredoKey[] => {
  const derived = new Set<CredoKey>();
  for (const principleKey of principleKeys) {
    for (const credoKey of principleKeyToCredoKeys[principleKey] ?? []) {
      derived.add(credoKey);
    }
  }
  return [...derived].slice(0, MAX_CREDO_KEYS);
};
