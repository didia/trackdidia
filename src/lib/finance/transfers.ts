// Pure transfer detection. Given candidate transaction rows (already inserted
// or about to be), decides which pairs are transfers between accounts, and
// which single-sided rows are "probable transfers" by keyword. See
// specs/todo/finance.md "Transfer detection".

import { normalizeDescription } from "./import-profile";

export const TRANSFER_CATEGORY_ID = "fincat:transfert";
export const UNCATEGORIZED_CATEGORY_ID = "fincat:non-categorise";

const TRANSFER_KEYWORDS = [
  "VIREMENT",
  "TRANSFER",
  "PAIEMENT CARTE",
  "PAYMENT - THANK YOU",
  "AUTOMATIC PAYMENT",
];

export interface TransferCandidateTransaction {
  id: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  postedDate: string; // local YYYY-MM-DD
  descriptionRaw: string;
  isTransfer: boolean;
  /** Set once the row is part of a matched pair; a probable transfer has none yet. */
  transferGroupId?: string | null;
  excludedFromBudget: boolean;
  accountOnBudget: boolean;
}

export interface TransferLegOutcome {
  isTransfer: true;
  categoryId: string;
  categorySource: "rule";
  excludedFromBudget: boolean;
  /** True when the leg still needs a pending category suggestion for the user. */
  pendingSuggestion: boolean;
}

export type TransferAction =
  | {
      type: "matched_pair";
      transferGroupId: string;
      legA: { transactionId: string; outcome: TransferLegOutcome };
      legB: { transactionId: string; outcome: TransferLegOutcome };
    }
  | {
      type: "probable_transfer";
      transactionId: string;
      outcome: TransferLegOutcome;
    };

const dateToEpochDay = (date: string): number => {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

const dateDiffDays = (a: string, b: string): number =>
  Math.abs(dateToEpochDay(a) - dateToEpochDay(b));

const sharedTokenCount = (a: string, b: string): number => {
  const tokensA = new Set(normalizeDescription(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeDescription(b).split(" ").filter(Boolean));
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      shared += 1;
    }
  }
  return shared;
};

const containsTransferKeyword = (description: string): boolean => {
  const normalized = normalizeDescription(description);
  return TRANSFER_KEYWORDS.some((keyword) => normalized.includes(normalizeDescription(keyword)));
};

const buildTransferGroupId = (idA: string, idB: string): string => {
  const [first, second] = [idA, idB].sort();
  return `transfer:${first}:${second}`;
};

const legOutcomeForMatchedPair = (
  thisAccountOnBudget: boolean,
  otherAccountOnBudget: boolean,
): TransferLegOutcome => {
  const bothOnBudget = thisAccountOnBudget && otherAccountOnBudget;

  if (bothOnBudget) {
    return {
      isTransfer: true,
      categoryId: TRANSFER_CATEGORY_ID,
      categorySource: "rule",
      excludedFromBudget: true,
      pendingSuggestion: false,
    };
  }

  // Exactly one leg on-budget: this leg keeps counting as spending until the
  // user picks a real category.
  if (thisAccountOnBudget) {
    return {
      isTransfer: true,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      categorySource: "rule",
      excludedFromBudget: false,
      pendingSuggestion: true,
    };
  }

  // The off-budget leg never touches the budget either way; it is still
  // marked as a transfer but excluded_from_budget is moot for off-budget
  // accounts. Keep it excluded to avoid any accidental on-budget leak.
  return {
    isTransfer: true,
    categoryId: TRANSFER_CATEGORY_ID,
    categorySource: "rule",
    excludedFromBudget: true,
    pendingSuggestion: false,
  };
};

const probableTransferOutcome = (): TransferLegOutcome => ({
  isTransfer: true,
  categoryId: UNCATEGORIZED_CATEGORY_ID,
  categorySource: "rule",
  excludedFromBudget: false,
  pendingSuggestion: true,
});

const amountIndexKey = (currency: string, amountMinor: number): string =>
  `${currency}|${amountMinor}`;

/**
 * Detects transfer pairs across different accounts and single-sided
 * "probable transfers" by description keyword. Runs over the full candidate
 * set (the caller is responsible for passing full history, not just a batch).
 */
export const detectTransfers = (candidates: TransferCandidateTransaction[]): TransferAction[] => {
  const actions: TransferAction[] = [];
  const paired = new Set<string>();

  // Step 1: rows the user excluded from the budget or that already belong to a
  // matched pair are not eligible. A probable transfer (isTransfer without a
  // group) stays eligible so its counterpart imported later can still pair.
  const eligible = candidates.filter(
    (candidate) => !candidate.transferGroupId && !candidate.excludedFromBudget,
  );

  // Sort by id for deterministic iteration order.
  const sorted = [...eligible].sort((a, b) => a.id.localeCompare(b.id));

  // Index eligible rows by `${currency}|${amountMinor}` so a candidate's
  // opposite-sign match is a direct lookup instead of a full scan — full
  // candidate sets can be in the thousands of rows.
  const byAmountKey = new Map<string, TransferCandidateTransaction[]>();
  for (const row of sorted) {
    const key = amountIndexKey(row.currency, row.amountMinor);
    const bucket = byAmountKey.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byAmountKey.set(key, [row]);
    }
  }

  for (const candidate of sorted) {
    if (paired.has(candidate.id)) {
      continue;
    }

    const oppositeKey = amountIndexKey(candidate.currency, -candidate.amountMinor);
    const sameAmountOpposite = byAmountKey.get(oppositeKey) ?? [];

    const matchCandidates = sameAmountOpposite.filter(
      (other) =>
        other.id !== candidate.id &&
        !paired.has(other.id) &&
        other.accountId !== candidate.accountId &&
        dateDiffDays(other.postedDate, candidate.postedDate) <= 3,
    );

    if (matchCandidates.length === 0) {
      continue;
    }

    const best = matchCandidates
      .map((other) => ({
        other,
        dateDiff: dateDiffDays(other.postedDate, candidate.postedDate),
        similarity: sharedTokenCount(other.descriptionRaw, candidate.descriptionRaw),
      }))
      .sort((a, b) => {
        if (a.dateDiff !== b.dateDiff) {
          return a.dateDiff - b.dateDiff;
        }
        if (a.similarity !== b.similarity) {
          return b.similarity - a.similarity;
        }
        return a.other.id.localeCompare(b.other.id);
      })[0].other;

    paired.add(candidate.id);
    paired.add(best.id);

    const transferGroupId = buildTransferGroupId(candidate.id, best.id);
    const legA = legOutcomeForMatchedPair(candidate.accountOnBudget, best.accountOnBudget);
    const legB = legOutcomeForMatchedPair(best.accountOnBudget, candidate.accountOnBudget);

    actions.push({
      type: "matched_pair",
      transferGroupId,
      legA: { transactionId: candidate.id, outcome: legA },
      legB: { transactionId: best.id, outcome: legB },
    });
  }

  for (const candidate of sorted) {
    if (paired.has(candidate.id) || candidate.isTransfer) {
      continue;
    }

    if (containsTransferKeyword(candidate.descriptionRaw)) {
      actions.push({
        type: "probable_transfer",
        transactionId: candidate.id,
        outcome: probableTransferOutcome(),
      });
    }
  }

  return actions;
};
