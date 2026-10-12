// Pure reconciliation of an AI-proposed invoice allocation against the transaction it explains.
// Language models read line items well but add badly, so the model's numbers are only *weights*:
// this module guarantees the result sums exactly to the parent amount (what `validateSplitTotal`
// requires) and tells the caller when it had to adjust anything so the user can review it.

export interface InvoiceSplitLine {
  /** A category id already validated against the allowed list, or null when unknown. */
  categoryId: string | null;
  /** Positive magnitude in minor units, as read from the invoice. */
  amountMinor: number;
  description?: string;
}

export interface InvoiceSplitRow {
  categoryId: string | null;
  /** Signed like the parent transaction (an expense is negative). */
  amountMinor: number;
  description: string;
}

export interface InvoiceSplitReconciliation {
  rows: InvoiceSplitRow[];
  /** True when the AI's amounts did not already sum to the transaction and were rescaled. */
  adjusted: boolean;
  /** True when the invoice's own total is clearly not the transaction amount. */
  totalMismatch: boolean;
}

/** An invoice total within this fraction of the transaction (or 2 minor units) counts as equal. */
const TOTAL_TOLERANCE = 0.01;

/**
 * Distributes `target` across `weights` proportionally using the largest-remainder method, so the
 * integer parts sum to exactly `target`. BigInt keeps `weight * target` exact for any safe input.
 */
const allocateProportionally = (weights: number[], target: number): number[] => {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const bigTotal = BigInt(totalWeight);
  const bigTarget = BigInt(target);
  const shares = weights.map((weight) => {
    const product = BigInt(weight) * bigTarget;
    return { floor: product / bigTotal, remainder: product % bigTotal };
  });
  let leftover = Number(bigTarget - shares.reduce((sum, share) => sum + share.floor, 0n));
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  const allocated = shares.map((share) => Number(share.floor));
  for (const { index } of byRemainder) {
    if (leftover <= 0) {
      break;
    }
    allocated[index] += 1;
    leftover -= 1;
  }
  return allocated;
};

/**
 * Turns the AI's lines into split rows that sum exactly to `parentAmountMinor`. Lines with the same
 * category are merged, non-positive or non-integer lines are ignored, and when the remaining
 * amounts do not already add up they are rescaled proportionally (never silently: `adjusted`).
 * Returns null when nothing usable is left or the parent amount is zero.
 */
export const reconcileInvoiceSplits = (
  parentAmountMinor: number,
  lines: InvoiceSplitLine[],
  invoiceTotalMinor: number | null = null,
): InvoiceSplitReconciliation | null => {
  if (!Number.isSafeInteger(parentAmountMinor) || parentAmountMinor === 0) {
    return null;
  }
  const target = Math.abs(parentAmountMinor);
  const sign = parentAmountMinor < 0 ? -1 : 1;

  const merged: { categoryId: string | null; amountMinor: number; descriptions: string[] }[] = [];
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
      continue;
    }
    const existing =
      line.categoryId === null
        ? undefined
        : merged.find((candidate) => candidate.categoryId === line.categoryId);
    const description = line.description?.trim();
    if (existing) {
      existing.amountMinor += line.amountMinor;
      if (description) {
        existing.descriptions.push(description);
      }
    } else {
      merged.push({
        categoryId: line.categoryId,
        amountMinor: line.amountMinor,
        descriptions: description ? [description] : [],
      });
    }
  }
  const weightTotal = merged.reduce((sum, line) => sum + line.amountMinor, 0);
  if (merged.length === 0 || !Number.isSafeInteger(weightTotal)) {
    return null;
  }

  const adjusted = weightTotal !== target;
  const amounts = adjusted
    ? allocateProportionally(
        merged.map((line) => line.amountMinor),
        target,
      )
    : merged.map((line) => line.amountMinor);

  const rows = merged
    .map((line, index) => ({
      categoryId: line.categoryId,
      amountMinor: sign * amounts[index],
      description: line.descriptions.join(", "),
    }))
    // A tiny line can round to 0 when rescaled; a zero split is noise.
    .filter((row) => row.amountMinor !== 0);

  const totalMismatch =
    invoiceTotalMinor !== null &&
    Math.abs(Math.abs(invoiceTotalMinor) - target) > Math.max(2, target * TOTAL_TOLERANCE);

  return { rows, adjusted, totalMismatch };
};
