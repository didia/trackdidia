// Pure validation for a transaction's split allocation.

import type { FinanceCategorySource, FinanceTransactionSplit } from "../../domain/finance";

/**
 * A non-empty split list must sum exactly to the parent amount in safe-integer
 * minor units. An empty list is an explicit split removal and is always valid.
 * Throws before any state is mutated.
 */
export const validateSplitTotal = (
  parentAmountMinor: number,
  splits: Pick<FinanceTransactionSplit, "amountMinor" | "id">[],
): void => {
  if (splits.length === 0) {
    return;
  }

  let total = 0;
  const seenIds = new Set<string>();
  for (const split of splits) {
    if (!Number.isSafeInteger(split.amountMinor)) {
      throw new Error("split amounts must be safe integers in minor units");
    }
    total += split.amountMinor;
    if (!Number.isSafeInteger(total)) {
      throw new Error("split total is out of range");
    }
    if (split.id) {
      if (seenIds.has(split.id)) {
        throw new Error(`duplicate split id: ${split.id}`);
      }
      seenIds.add(split.id);
    }
  }

  if (total !== parentAmountMinor) {
    throw new Error(`splits sum to ${total} but the transaction amount is ${parentAmountMinor}`);
  }
};

/** The internal categories a split save sets and clears on the parent. */
export const SPLIT_CATEGORY_ID = "fincat:split";
export const UNCATEGORIZED_AFTER_SPLITS_ID = "fincat:non-categorise";

export interface SplitSaveParent {
  hasSplits: boolean;
  categoryId: string | null;
  categorySource: FinanceCategorySource;
  categoryConfidence: number | null;
}

export interface SplitSaveTarget {
  hasSplits: boolean;
  categoryId: string | null;
  categorySource: FinanceCategorySource;
  categoryConfidence: number | null;
}

export interface SplitSavePlan {
  /** False when the stored children already equal the requested ones (id, amount, category, notes, order). */
  rewriteChildren: boolean;
  /** The parent's columns after the save, or `null` when it already holds them. */
  parentTarget: SplitSaveTarget | null;
}

/**
 * What saving `next` as the splits of a parent has to write, shared by both finance stores so they
 * stay identical. Saving what is already stored writes nothing at all: the children keep their
 * `created_at` and the parent keeps its `updated_at` (a pointless rewrite would be a new unit write
 * and a whole-row write for multi-device sync). Removing the last split resets the parent exactly as
 * before: the internal split category goes back to uncategorized / `default`.
 */
export const planSplitSave = (
  parent: SplitSaveParent,
  existing: Pick<
    FinanceTransactionSplit,
    "id" | "amountMinor" | "categoryId" | "notes" | "sortOrder"
  >[],
  next: Pick<FinanceTransactionSplit, "id" | "amountMinor" | "categoryId" | "notes">[],
): SplitSavePlan => {
  const ordered = [...existing].sort((a, b) => a.sortOrder - b.sortOrder);
  const rewriteChildren =
    ordered.length !== next.length ||
    next.some((split, index) => {
      const stored = ordered[index];
      return (
        stored === undefined ||
        split.id === "" ||
        split.id !== stored.id ||
        stored.sortOrder !== index ||
        split.amountMinor !== stored.amountMinor ||
        split.categoryId !== stored.categoryId ||
        split.notes !== stored.notes
      );
    });
  const hasSplits = next.length > 0;
  const clearedSplitCategory = !hasSplits && parent.categoryId === SPLIT_CATEGORY_ID;
  const target: SplitSaveTarget = {
    hasSplits,
    categoryId: hasSplits
      ? SPLIT_CATEGORY_ID
      : clearedSplitCategory
        ? UNCATEGORIZED_AFTER_SPLITS_ID
        : parent.categoryId,
    categorySource: hasSplits ? "user" : clearedSplitCategory ? "default" : parent.categorySource,
    categoryConfidence: hasSplits || clearedSplitCategory ? null : parent.categoryConfidence,
  };
  const parentSame =
    parent.hasSplits === target.hasSplits &&
    parent.categoryId === target.categoryId &&
    parent.categorySource === target.categorySource &&
    parent.categoryConfidence === target.categoryConfidence;
  return { rewriteChildren, parentTarget: parentSame ? null : target };
};
