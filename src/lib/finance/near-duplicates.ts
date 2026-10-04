// Pure near-duplicate detector for the pending -> posted drift case: a
// transaction exported while pending and re-exported after posting can change
// date and/or description and would otherwise insert twice even after exact
// dedupeHash matching. See specs/todo/finance.md "Near-duplicates".

import { normalizeDescription } from "./import-profile";

export interface NearDuplicateCandidate {
  id: string;
  accountId: string;
  postedDate: string; // local YYYY-MM-DD
  amountMinor: number;
  descriptionRaw: string;
}

export interface NearDuplicateMatch {
  candidateId: string;
  existingId: string;
  dateDiffDays: number;
  similarity: number;
}

export interface NearDuplicateOptions {
  /** Max |dateDiffDays| to consider, default 3 per the spec. */
  maxDateDiffDays?: number;
  /** Minimum description similarity (Dice coefficient over tokens) to flag, default 0.5. */
  similarityThreshold?: number;
}

const dateToEpochDay = (date: string): number => {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

const dateDiffDays = (a: string, b: string): number =>
  Math.abs(dateToEpochDay(a) - dateToEpochDay(b));

/** Dice coefficient over normalized description tokens, in [0, 1]. */
export const descriptionSimilarity = (a: string, b: string): number => {
  const setA = new Set(normalizeDescription(a).split(" ").filter(Boolean));
  const setB = new Set(normalizeDescription(b).split(" ").filter(Boolean));

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      shared += 1;
    }
  }

  return (2 * shared) / (setA.size + setB.size);
};

/**
 * Flags candidate rows that look like near-duplicates of an existing row: same
 * account, identical amount, a date within `maxDateDiffDays`, and description
 * similarity at or above `similarityThreshold`. Matches are returned for
 * review, never silently merged or dropped — the caller still inserts the row.
 */
const accountAmountKey = (accountId: string, amountMinor: number): string =>
  `${accountId}|${amountMinor}`;

export const findNearDuplicates = (
  candidates: NearDuplicateCandidate[],
  existing: NearDuplicateCandidate[],
  options: NearDuplicateOptions = {},
): NearDuplicateMatch[] => {
  const maxDateDiffDays = options.maxDateDiffDays ?? 3;
  const similarityThreshold = options.similarityThreshold ?? 0.5;
  const matches: NearDuplicateMatch[] = [];

  // Index existing rows by `${accountId}|${amountMinor}` so each candidate's
  // lookup is a direct map hit instead of a full scan over `existing`.
  const byAccountAmountKey = new Map<string, NearDuplicateCandidate[]>();
  for (const row of existing) {
    const key = accountAmountKey(row.accountId, row.amountMinor);
    const bucket = byAccountAmountKey.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byAccountAmountKey.set(key, [row]);
    }
  }

  for (const candidate of candidates) {
    const sameAccountSameAmount =
      byAccountAmountKey.get(accountAmountKey(candidate.accountId, candidate.amountMinor)) ?? [];

    let best: NearDuplicateMatch | null = null;

    for (const row of sameAccountSameAmount) {
      const diff = dateDiffDays(row.postedDate, candidate.postedDate);
      if (diff > maxDateDiffDays) {
        continue;
      }

      const similarity = descriptionSimilarity(row.descriptionRaw, candidate.descriptionRaw);
      if (similarity < similarityThreshold) {
        continue;
      }

      if (best === null || similarity > best.similarity) {
        best = {
          candidateId: candidate.id,
          existingId: row.id,
          dateDiffDays: diff,
          similarity,
        };
      }
    }

    if (best !== null) {
      matches.push(best);
    }
  }

  return matches;
};
