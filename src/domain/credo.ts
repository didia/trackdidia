import type { PrincipleKey } from "./types";

/**
 * The ten items of the personal credo ("Mon crédo personnel"). This is a different axis from
 * the fourteen daily `PrincipleKey` checkboxes: principles are what gets checked off each day
 * and feeds the discipline score, while the credo is the standing personal statement the
 * `verses.json` catalog is curated against.
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

export interface CredoDefinition {
  key: CredoKey;
  /** 1-based position in the written credo. */
  order: number;
  /** The statement as written by the user. User-authored content, so not i18n'd. */
  statement: string;
}

/** The credo in its written order. Not i18n'd — same policy as `verses.json` and `quotes.json`. */
export const credoDefinitions: CredoDefinition[] = [
  {
    key: "procheDeDieu",
    order: 1,
    statement:
      "Je reste continuellement proche de Dieu à travers les prières et méditations quotidiennes. Car plus je reste proche de lui, plus ma vie est ordonnée et plus elle a un sens. Quand les choses vont mal, je continue à m'accrocher à lui au lieu de m'éloigner.",
  },
  {
    key: "cercleDeControle",
    order: 2,
    statement:
      "Face aux situations difficiles, je me concentre seulement sur ce que je peux faire et je laisse Dieu se charger du reste.",
  },
  {
    key: "sansInquietude",
    order: 3,
    statement:
      "Face aux situations difficiles, je ne sombre pas dans l'inquiétude ou le souci. Je me rappelle que les leçons apprises lors de ces situations me seront utiles dans le futur car tout concourt au bien de ceux qui aiment Dieu.",
  },
  {
    key: "echecsCommeLecons",
    order: 4,
    statement:
      "Je ne me laisse pas abattre par les échecs mais je les utilise toujours comme opportunités d'acquérir des leçons qui m'aideront à mieux faire dans le futur.",
  },
  {
    key: "discipline",
    order: 5,
    statement:
      "Je suis une personne disciplinée dans tout ce que je fais car c'est cette discipline qui me donne la liberté de faire ce que je veux.",
  },
  {
    key: "empathie",
    order: 6,
    statement:
      "Je fais toujours preuve d'empathie dans mes interactions avec les autres. J'écoute toujours l'autre pour comprendre et non pour juger. Je choisis toujours la curiosité au lieu de la défensive.",
  },
  {
    key: "amourEnActes",
    order: 7,
    statement:
      "Je pratique l'amour. Je ne m'arrête pas simplement au sentiment d'amour mais je fais des actions qui démontrent mon amour.",
  },
  {
    key: "engagementsTenus",
    order: 8,
    statement:
      "Je respecte tous les engagements que je prends. Et quand je ne suis pas sûr de respecter un engagement, je ne le prends tout simplement pas.",
  },
  {
    key: "choixDuBonheur",
    order: 9,
    statement:
      "Je fais un choix délibéré d'être heureux chaque jour car tant que j'ai de la nourriture, de l'eau et un chez-moi, j'ai tout ce qu'il faut pour être heureux.",
  },
  {
    key: "programme4P",
    order: 10,
    statement:
      "Je maintiens continuellement le programme 4P (Prendre plaisir à perdre du poids) pour le reste de ma vie car il vaut mieux être pauvre mais fort et en bonne santé plutôt qu'être riche et sans cesse malade.",
  },
];

export const credoKeys: CredoKey[] = credoDefinitions.map((definition) => definition.key);

const credoKeySet = new Set<CredoKey>(credoKeys);

export const isCredoKey = (value: unknown): value is CredoKey =>
  typeof value === "string" && credoKeySet.has(value as CredoKey);

/**
 * Bridge from a daily principle to the credo items it serves. Used to derive `credoKeys` for a
 * catalog entry that predates the field — notably the custom verses already stored in
 * `settings.aiPastorCustomVerses`, which must keep parsing rather than being dropped.
 * Every `PrincipleKey` maps to at least one credo item (`credo.test.ts` enforces this).
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
