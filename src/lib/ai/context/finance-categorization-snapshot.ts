// Builds the AI payload for the `finance_categorization` surface — see
// specs/done/finance.md "AI stage" and docs/ai-settings-and-privacy.md.
//
// Privacy contract, enforced here and nowhere else:
// - The "merchant string" sent is `finance_transactions.merchant_key` — i.e.
//   `normalizeDescription(descriptionRaw)` (uppercased, accents stripped) — run through
//   `sanitizeMerchantDescriptor` and clamped to 60 characters. That sanitizer only strips email
//   addresses, card/account-looking fragments (`\b[\dX*]{6,}\b`), digit runs of 4+ characters,
//   and short dash/dot/space-separated digit groups that look like a phone number. It does
//   **not** attempt to redact free text: a counterparty name, a partial address, or any other
//   word embedded in the original description (e.g. "INTERAC E-TRANSFER JEAN DUPONT") is sent
//   as-is. Do not describe this as removing all personal information — it removes only
//   structured identifiers (account/card numbers, emails, phone-like digit groups).
// - Also sent: the transaction sign, an occurrence count, an amount bucket (`<10`, `10-50`,
//   `50-200`, `200-1000`, `>1000`, in base currency, never the exact amount), the account type,
//   and the allowed category id/name list.
// - Never sent (structured fields, not derived from the free-text descriptor): account names,
//   institutions, account numbers, balances, net worth, `personId`, exact amounts, dates, notes,
//   or labels.
// - A request is capped at 40 merchants and 16 KiB; over-cap input is split into several
//   requests, never truncated.
// - `scope === "metrics"` disables the AI stage entirely (merchant strings are structure, not
//   metrics) — `buildFinanceCategorizationSnapshots` returns an empty array for that scope.

import type { AiPayloadScope } from "../../../domain/types";
import type { FinanceAccountType, FinanceUnknownMerchantGroup } from "../../../domain/finance";
import { currencyExponent } from "../../finance/money";

export type FinanceCategorizationAmountBucket = "<10" | "10-50" | "50-200" | "200-1000" | ">1000";

export interface FinanceCategorizationSnapshotMerchant {
  /** The sanitized, request-unique key. Never the raw `finance_transactions.merchant_key`. */
  merchantKey: string;
  sign: -1 | 0 | 1;
  occurrenceCount: number;
  amountBucket: FinanceCategorizationAmountBucket;
  accountType: FinanceAccountType;
}

export interface FinanceCategorizationAllowedCategory {
  id: string;
  name: string;
}

export interface FinanceCategorizationSnapshot {
  surface: "finance_categorization";
  scope: AiPayloadScope;
  merchants: FinanceCategorizationSnapshotMerchant[];
  allowedCategories: FinanceCategorizationAllowedCategory[];
}

export interface FinanceCategorizationSnapshotInputs {
  unknownMerchants: FinanceUnknownMerchantGroup[];
  allowedCategories: FinanceCategorizationAllowedCategory[];
  baseCurrency: string;
}

/** One request-worth of the snapshot, paired with the key map needed to apply its results. */
export interface FinanceCategorizationSnapshotChunk {
  snapshot: FinanceCategorizationSnapshot;
  /** Sanitized merchant key -> original `finance_transactions.merchant_key` value(s) it represents. */
  merchantKeyMap: Record<string, string[]>;
}

const MAX_MERCHANTS_PER_REQUEST = 40;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_MERCHANT_LENGTH = 60;

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CARD_OR_ACCOUNT_FRAGMENT_PATTERN = /\b[\dX*]{6,}\b/gi;
const LONG_DIGIT_RUN_PATTERN = /\d{4,}/g;
/**
 * Phone-number-shaped fragments: two or more dash/dot/space-separated groups of 2-4 digits each
 * (e.g. `514-555-1234`, `514-555`, or a dangling `514-555-` with nothing after the trailing
 * separator — the `\b` only needs to close after the last digit group, so the trailing separator
 * itself is left behind as harmless punctuation rather than blocking the match).
 */
const PHONE_FRAGMENT_PATTERN = /\b\d{2,4}(?:[-.\s]\d{2,4}){1,3}\b/g;

/**
 * Strips **structured identifiers** from a raw merchant descriptor — email addresses,
 * card/account fragments, digit runs of 4 or more (store numbers, partial account numbers), and
 * phone-number-shaped digit groups — then clamps to 60 characters. This is *not* a general
 * free-text redactor: it does not detect or remove a counterparty name, a partial address, or
 * any other plain word in the description (see the module comment above). Order matters: the
 * card/account fragment pattern must run before the plain digit-run strip so a fragment mixing
 * digits with `X`/`*` masking characters is still caught as one unit instead of leaving masking
 * characters behind; the phone pattern runs before the digit-run strip so a full phone number's
 * last group (4 digits) is consumed as part of the phone match rather than by the cruder
 * digit-run strip alone (same end result, but keeps the phone pattern meaningful on its own for
 * shorter, non-4-digit-terminated numbers).
 */
export const sanitizeMerchantDescriptor = (raw: string): string => {
  const sanitized = raw
    .replace(EMAIL_PATTERN, " ")
    .replace(CARD_OR_ACCOUNT_FRAGMENT_PATTERN, " ")
    .replace(PHONE_FRAGMENT_PATTERN, " ")
    .replace(LONG_DIGIT_RUN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MERCHANT_LENGTH)
    .trim();
  return sanitized || "MARCHAND";
};

/**
 * Buckets an absolute amount in minor units against the stated base-currency thresholds, using
 * only integer multiplication (`10 ** exponent`) — never a division — so no binary-float drift
 * can creep into the boundary comparisons.
 */
export const amountBucketFor = (
  amountMinor: number,
  baseCurrency: string,
): FinanceCategorizationAmountBucket => {
  const scale = 10 ** currencyExponent(baseCurrency);
  const abs = Math.abs(amountMinor);
  if (abs < 10 * scale) {
    return "<10";
  }
  if (abs < 50 * scale) {
    return "10-50";
  }
  if (abs < 200 * scale) {
    return "50-200";
  }
  if (abs < 1000 * scale) {
    return "200-1000";
  }
  return ">1000";
};

const payloadByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Sanitizes and chunks `inputs.unknownMerchants` into one or more request-sized snapshots: at
 * most 40 merchants and 16 KiB of serialized JSON each (over-cap input is split, never
 * truncated). Returns an empty array when `scope === "metrics"` (the AI stage is disabled
 * entirely at that scope) or when there is nothing to classify.
 */
export const buildFinanceCategorizationSnapshots = (
  inputs: FinanceCategorizationSnapshotInputs,
  scope: AiPayloadScope,
): FinanceCategorizationSnapshotChunk[] => {
  if (scope === "metrics" || inputs.unknownMerchants.length === 0) {
    return [];
  }

  // Sanitization can (rarely) make two distinct raw merchant keys collide on the same sanitized
  // string; disambiguate with a `#n` suffix so every request item still has a unique key, and
  // record every original key the disambiguated entry represents in its chunk's key map.
  const seenBaseKeyCounts = new Map<string, number>();
  const items = inputs.unknownMerchants.map((group) => {
    const base = sanitizeMerchantDescriptor(group.merchantKey);
    const occurrence = seenBaseKeyCounts.get(base) ?? 0;
    seenBaseKeyCounts.set(base, occurrence + 1);
    const key = occurrence === 0 ? base : `${base}#${occurrence + 1}`;
    const merchant: FinanceCategorizationSnapshotMerchant = {
      merchantKey: key,
      sign: group.sign,
      occurrenceCount: group.occurrenceCount,
      amountBucket: amountBucketFor(group.amountMinorSample, inputs.baseCurrency),
      accountType: group.accountType,
    };
    return { key, originalMerchantKey: group.merchantKey, merchant };
  });

  const chunks: FinanceCategorizationSnapshotChunk[] = [];
  let currentItems: typeof items = [];
  let currentKeyMap: Record<string, string[]> = {};

  const buildSnapshot = (chunkItems: typeof items): FinanceCategorizationSnapshot => ({
    surface: "finance_categorization",
    scope,
    merchants: chunkItems.map((item) => item.merchant),
    allowedCategories: inputs.allowedCategories,
  });

  const flush = () => {
    if (currentItems.length === 0) {
      return;
    }
    chunks.push({ snapshot: buildSnapshot(currentItems), merchantKeyMap: currentKeyMap });
    currentItems = [];
    currentKeyMap = {};
  };

  for (const item of items) {
    const candidate = [...currentItems, item];
    const exceedsCap =
      candidate.length > MAX_MERCHANTS_PER_REQUEST ||
      payloadByteLength(buildSnapshot(candidate)) > MAX_PAYLOAD_BYTES;
    if (currentItems.length > 0 && exceedsCap) {
      flush();
    }
    currentItems.push(item);
    currentKeyMap[item.key] = [...(currentKeyMap[item.key] ?? []), item.originalMerchantKey];
  }
  flush();

  return chunks;
};
