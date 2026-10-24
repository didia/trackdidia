import type { FinanceCategory, FinanceCategoryKind } from "../finance";

export const NON_CATEGORISE_ID = "fincat:non-categorise";

/** The kinds a household can create; transfer/internal stay system-only. */
export const USER_CATEGORY_KINDS = ["expense", "income"] as const satisfies FinanceCategoryKind[];

export interface FinanceCategoryTreeGroup {
  group: FinanceCategory;
  children: FinanceCategory[];
}

const bySortOrder = (a: FinanceCategory, b: FinanceCategory) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "fr");

/** Groups (parentId null) with their children, system categories left out. */
export const buildCategoryTree = (
  categories: FinanceCategory[],
  archived: boolean,
): FinanceCategoryTreeGroup[] => {
  const visible = categories.filter((category) => !category.isSystem);
  const groups = visible.filter((category) => category.parentId === null).sort(bySortOrder);
  const result: FinanceCategoryTreeGroup[] = [];
  for (const group of groups) {
    const children = visible
      .filter((category) => category.parentId === group.id && category.archived === archived)
      .sort(bySortOrder);
    // An archived group is listed even with no archived children; an active group only when active.
    if (group.archived === archived || children.length > 0) {
      result.push({ group, children });
    }
  }
  return result;
};

const normalizeName = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export type CategoryNameError = "required" | "duplicate";

/**
 * A name must be non-empty and unique (accent/case-insensitive) among the active
 * siblings under the same parent, ignoring the category being renamed.
 */
export const validateCategoryName = (
  name: string,
  parentId: string | null,
  categories: FinanceCategory[],
  ignoreId?: string,
): CategoryNameError | null => {
  const normalized = normalizeName(name);
  if (!normalized) {
    return "required";
  }
  const clash = categories.some(
    (category) =>
      category.id !== ignoreId &&
      !category.archived &&
      category.parentId === parentId &&
      normalizeName(category.name) === normalized,
  );
  return clash ? "duplicate" : null;
};

/** Sort order that places a new category after its active siblings. */
export const nextCategorySortOrder = (
  parentId: string | null,
  categories: FinanceCategory[],
): number => {
  const siblings = categories.filter((category) => category.parentId === parentId);
  return siblings.length === 0
    ? 0
    : Math.max(...siblings.map((category) => category.sortOrder)) + 1;
};

/**
 * Where an archived category's transactions can go: any active, non-group-with-children
 * category of the same kind, plus the system "Non catégorisé" bucket for expenses.
 */
export const listReassignTargets = (
  category: FinanceCategory,
  categories: FinanceCategory[],
): FinanceCategory[] => {
  const parentsWithChildren = new Set(
    categories
      .filter((candidate) => !candidate.archived && candidate.parentId !== null)
      .map((candidate) => candidate.parentId),
  );
  return categories
    .filter(
      (candidate) =>
        candidate.id !== category.id &&
        !candidate.archived &&
        !parentsWithChildren.has(candidate.id) &&
        // "Non catégorisé" is an expense envelope: income must move to another income category,
        // or the income would stop counting toward Ready to Assign.
        ((candidate.id === NON_CATEGORISE_ID && category.kind === "expense") ||
          (!candidate.isSystem && candidate.kind === category.kind)),
    )
    .sort(bySortOrder);
};

/** An active group cannot be archived while it still has active children. */
export const groupHasActiveChildren = (
  group: FinanceCategory,
  categories: FinanceCategory[],
): boolean => categories.some((category) => category.parentId === group.id && !category.archived);
