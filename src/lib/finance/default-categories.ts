// Deterministic French default category taxonomy. Fixed ids so re-seeding is a
// no-op (INSERT OR IGNORE) — see specs/done/finance.md "Migrations" and
// "Bootstrap". This is distinct from the three system categories
// (Uncategorized/Transfer/Split), which are inserted by migration 37 itself
// because engine code hard-references their ids.

import type { FinanceCategory, FinanceCategoryKind } from "../../domain/finance";

export interface DefaultFinanceCategorySeed {
  id: string;
  name: string;
  parentId: string | null;
  kind: FinanceCategoryKind;
  sortOrder: number;
}

/** Fixed, deterministic ids. Never renumber or reuse an id once shipped. */
export const DEFAULT_FINANCE_CATEGORIES: DefaultFinanceCategorySeed[] = [
  // Alimentation
  {
    id: "fincat:alimentation",
    name: "Alimentation",
    parentId: null,
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:alimentation.epicerie",
    name: "Épicerie",
    parentId: "fincat:alimentation",
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:alimentation.restaurants",
    name: "Restaurants",
    parentId: "fincat:alimentation",
    kind: "expense",
    sortOrder: 1,
  },

  // Logement
  { id: "fincat:logement", name: "Logement", parentId: null, kind: "expense", sortOrder: 1 },
  {
    id: "fincat:logement.loyer-hypotheque",
    name: "Loyer / Hypothèque",
    parentId: "fincat:logement",
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:logement.services-publics",
    name: "Services publics",
    parentId: "fincat:logement",
    kind: "expense",
    sortOrder: 1,
  },
  {
    id: "fincat:logement.entretien",
    name: "Entretien",
    parentId: "fincat:logement",
    kind: "expense",
    sortOrder: 2,
  },
  {
    id: "fincat:logement.telecommunications",
    name: "Télécommunications",
    parentId: "fincat:logement",
    kind: "expense",
    sortOrder: 3,
  },

  // Transport
  { id: "fincat:transport", name: "Transport", parentId: null, kind: "expense", sortOrder: 2 },
  {
    id: "fincat:transport.essence",
    name: "Essence",
    parentId: "fincat:transport",
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:transport.transport-collectif",
    name: "Transport en commun",
    parentId: "fincat:transport",
    kind: "expense",
    sortOrder: 1,
  },
  {
    id: "fincat:transport.entretien-vehicule",
    name: "Entretien véhicule",
    parentId: "fincat:transport",
    kind: "expense",
    sortOrder: 2,
  },

  // Santé
  { id: "fincat:sante", name: "Santé", parentId: null, kind: "expense", sortOrder: 3 },
  {
    id: "fincat:sante.pharmacie",
    name: "Pharmacie",
    parentId: "fincat:sante",
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:sante.assurances",
    name: "Assurances",
    parentId: "fincat:sante",
    kind: "expense",
    sortOrder: 1,
  },

  // Loisirs
  { id: "fincat:loisirs", name: "Loisirs", parentId: null, kind: "expense", sortOrder: 4 },
  {
    id: "fincat:loisirs.abonnements",
    name: "Abonnements",
    parentId: "fincat:loisirs",
    kind: "expense",
    sortOrder: 0,
  },
  {
    id: "fincat:loisirs.sorties",
    name: "Sorties",
    parentId: "fincat:loisirs",
    kind: "expense",
    sortOrder: 1,
  },

  // Famille
  { id: "fincat:famille", name: "Famille", parentId: null, kind: "expense", sortOrder: 5 },
  {
    id: "fincat:famille.garde-enfants",
    name: "Garde d'enfants",
    parentId: "fincat:famille",
    kind: "expense",
    sortOrder: 0,
  },

  // Revenu
  { id: "fincat:revenu", name: "Revenu", parentId: null, kind: "income", sortOrder: 6 },
  {
    id: "fincat:revenu.salaire",
    name: "Salaire",
    parentId: "fincat:revenu",
    kind: "income",
    sortOrder: 0,
  },
  {
    id: "fincat:revenu.autre",
    name: "Autre revenu",
    parentId: "fincat:revenu",
    kind: "income",
    sortOrder: 1,
  },
];

/**
 * The three system categories, as migration 37 inserts them (its SQL is the original; this is the
 * one TypeScript copy, used by the in-memory store and by the sync work-profile guards, and
 * `sync-profile-data.test.ts` fails if a migrated database differs from it).
 */
export const SYSTEM_FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  {
    id: "fincat:non-categorise",
    name: "Non catégorisé",
    parentId: null,
    kind: "expense",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "fincat:transfert",
    name: "Transfert",
    parentId: null,
    kind: "transfer",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "fincat:split",
    name: "Répartition",
    parentId: null,
    kind: "internal",
    archived: false,
    isSystem: true,
    defersToNextMonth: false,
    sortOrder: 2,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
];

/** What `seedDefaultCategories` stores for a taxonomy entry (flags off), timestamps aside. */
export const defaultSeedAsCategory = (seed: DefaultFinanceCategorySeed): FinanceCategory => ({
  ...seed,
  archived: false,
  isSystem: false,
  defersToNextMonth: false,
  createdAt: "",
  updatedAt: "",
});
