// Pure validation for a transaction's split allocation.

import type { FinanceTransactionSplit } from "../../domain/finance";

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
