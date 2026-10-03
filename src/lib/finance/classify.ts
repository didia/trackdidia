// Pure classification pipeline. See specs/done/finance.md "Classification
// pipeline": user-set (never touched) -> rules -> transfer detection ->
// learned merchant memory -> bundled seed heuristics -> AI -> Uncategorized/
// default. The caller (the repository stores) supplies the context (rules,
// memory, dismissed pairs) and, when this transaction was already resolved
// by `src/lib/finance/transfers.ts`, the transfer outcome — classify.ts does
// not re-derive transfer pairing itself.
//
// The AI stage (Phase 8) is deliberately NOT a step inside this function: it
// is async, network-bound, and must never run inside a `DbSerialQueue`/
// `BEGIN IMMEDIATE` slot (see docs/architecture.md). Instead, a transaction
// that falls all the way through to stage 7 here (`Uncategorized`, no
// suggestion) becomes a candidate for `AppRepository.listFinanceUnknownMerchants`,
// which `src/lib/ai/finance-categorization-service.ts` reads, classifies via
// the AI provider, and applies back through
// `AppRepository.applyFinanceCategorizationResults` — see
// specs/done/finance.md "AI stage".

import type {
  FinanceCategorySource,
  FinanceMerchantMemoryEntry,
  FinanceRule,
  FinanceRuleActions,
  FinanceRuleMatcher,
} from "../../domain/finance";
import { isSuggestionDismissed, type DismissedSuggestionPair } from "./dismissed-suggestions";
import { normalizeDescription } from "./import-profile";
import { SEED_HEURISTICS, type SeedHeuristic } from "./seed-heuristics";

export const UNCATEGORIZED_CATEGORY_ID = "fincat:non-categorise";

export interface ClassificationThresholds {
  /** Auto-apply floor on `finance_merchant_memory.confidence`. */
  memoryAutoApplyConfidence: number;
  /** Auto-apply floor on `finance_merchant_memory.hit_count`. */
  memoryAutoApplyHitCount: number;
}

export const DEFAULT_CLASSIFICATION_THRESHOLDS: ClassificationThresholds = {
  memoryAutoApplyConfidence: 0.85,
  memoryAutoApplyHitCount: 2,
};

/** The outcome of `src/lib/finance/transfers.ts` for this one transaction, if any. */
export interface ClassificationTransferOutcome {
  categoryId: string;
  /** True when the transfer detector still owes the user a pending suggestion. */
  pendingSuggestion: boolean;
}

export interface ClassifyTransactionInput {
  categoryId: string | null;
  categorySource: FinanceCategorySource;
  accountId: string;
  amountMinor: number;
  merchantKey: string;
  personId: string | null;
}

export interface ClassificationContext {
  rules?: FinanceRule[];
  memory?: FinanceMerchantMemoryEntry[];
  seeds?: SeedHeuristic[];
  transferOutcome?: ClassificationTransferOutcome | null;
  dismissed?: DismissedSuggestionPair[];
  thresholds?: Partial<ClassificationThresholds>;
  /** Injectable "today" (local YYYY-MM-DD) for the dismissed-pair window. */
  today?: string;
}

export interface ClassificationSuggestion {
  categoryId: string;
  confidence: number;
  origin: "memory" | "seed";
}

export interface ClassificationOutcome {
  categoryId: string;
  categorySource: FinanceCategorySource;
  categoryConfidence: number | null;
  /** The rule that decided the category, if stage 2 won. Used to bump `applied_count`. */
  matchedRule?: FinanceRule | null;
  /** Side-effect actions merged from every matching rule, regardless of which one set the category. */
  ruleActions?: FinanceRuleActions | null;
  suggestion: ClassificationSuggestion | null;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const signOfAmount = (amountMinor: number): -1 | 0 | 1 =>
  amountMinor > 0 ? 1 : amountMinor < 0 ? -1 : 0;

/** Invalid `descriptionRegex` never throws — it simply never matches. */
export const matchesRuleMatcher = (
  matcher: FinanceRuleMatcher,
  txn: ClassifyTransactionInput,
): boolean => {
  if (matcher.descriptionContains) {
    // `txn.merchantKey` is already normalized (uppercased, accents
    // stripped — see `normalizeDescription`). The needle must go through
    // the same normalizer, not a plain `.toUpperCase()`, or an accented
    // needle like "Épicerie" (-> "ÉPICERIE") never matches "EPICERIE".
    if (!txn.merchantKey.includes(normalizeDescription(matcher.descriptionContains))) {
      return false;
    }
  }
  if (matcher.descriptionRegex) {
    let matched = false;
    try {
      matched = new RegExp(matcher.descriptionRegex, "i").test(txn.merchantKey);
    } catch {
      return false;
    }
    if (!matched) {
      return false;
    }
  }
  if (matcher.accountIds && matcher.accountIds.length > 0) {
    if (!matcher.accountIds.includes(txn.accountId)) {
      return false;
    }
  }
  if (matcher.personId && txn.personId !== matcher.personId) {
    return false;
  }
  if (matcher.amountMinMinor !== undefined && txn.amountMinor < matcher.amountMinMinor) {
    return false;
  }
  if (matcher.amountMaxMinor !== undefined && txn.amountMinor > matcher.amountMaxMinor) {
    return false;
  }
  if (matcher.sign !== undefined && signOfAmount(txn.amountMinor) !== matcher.sign) {
    return false;
  }
  return true;
};

const findMemoryEntry = (
  memory: FinanceMerchantMemoryEntry[],
  merchantKey: string,
  accountId: string,
  sign: -1 | 0 | 1,
): FinanceMerchantMemoryEntry | null => {
  const exact = memory.find(
    (entry) =>
      entry.merchantKey === merchantKey && entry.accountId === accountId && entry.sign === sign,
  );
  if (exact) {
    return exact;
  }
  const anyAccountSameSign = memory.find(
    (entry) => entry.merchantKey === merchantKey && entry.accountId === "" && entry.sign === sign,
  );
  if (anyAccountSameSign) {
    return anyAccountSameSign;
  }
  return (
    memory.find(
      (entry) => entry.merchantKey === merchantKey && entry.accountId === "" && entry.sign === 0,
    ) ?? null
  );
};

/**
 * Classifies one transaction. Stages, highest authority first — the first
 * stage that produces a category wins:
 * 1. `category_source === "user"` — passthrough, untouched.
 * 2. Enabled `finance_rules`, by `priority` then id; the first match with a
 *    `categoryId` action wins, but every matching rule's other actions
 *    (`merchantDisplay`, `personId`, `markTransfer`, `excludeFromBudget`,
 *    `excludeFromReports`, `addLabels`) are merged into `ruleActions` for the
 *    caller to apply.
 * 3. `context.transferOutcome`, when the caller already resolved this
 *    transaction via `src/lib/finance/transfers.ts`.
 * 4. Learned merchant memory: exact `(merchantKey, accountId, sign)` ->
 *    `(merchantKey, "", sign)` -> `(merchantKey, "", 0)`. Auto-applies at
 *    `confidence >= thresholds.memoryAutoApplyConfidence` and
 *    `hitCount >= thresholds.memoryAutoApplyHitCount`; otherwise a pending
 *    suggestion (unless the pair was dismissed in the last 90 days). Memory
 *    always outranks seeds — a seed is only consulted when no memory entry
 *    exists at all, at any lookup level.
 * 5. Bundled seed heuristics (`src/lib/finance/seed-heuristics.ts`), capped
 *    at confidence 0.7 — always a suggestion, never an auto-apply.
 * 6. AI — not a step of this pure function (see the module comment above);
 *    runs out-of-band over stage-7 fallthroughs via
 *    `FinanceCategorizationService`, gated on `settings.financeAiCategorizationEnabled`.
 * 7. `Uncategorized`, `source = "default"`.
 */
export const classifyTransaction = (
  txn: ClassifyTransactionInput,
  context: ClassificationContext = {},
): ClassificationOutcome => {
  if (txn.categorySource === "user") {
    return {
      categoryId: txn.categoryId ?? UNCATEGORIZED_CATEGORY_ID,
      categorySource: "user",
      categoryConfidence: null,
      suggestion: null,
    };
  }

  const thresholds: ClassificationThresholds = {
    ...DEFAULT_CLASSIFICATION_THRESHOLDS,
    ...context.thresholds,
  };
  const today = context.today ?? todayIso();
  const dismissed = context.dismissed ?? [];

  // Stage 2: rules, ordered by priority then id.
  const rules = [...(context.rules ?? [])]
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  let matchedRule: FinanceRule | null = null;
  let mergedActions: FinanceRuleActions | null = null;
  for (const rule of rules) {
    if (!matchesRuleMatcher(rule.matcher, txn)) {
      continue;
    }
    mergedActions = { ...(mergedActions ?? {}), ...rule.actions };
    if (!matchedRule && rule.actions.categoryId) {
      matchedRule = rule;
    }
  }
  if (matchedRule?.actions.categoryId) {
    return {
      categoryId: matchedRule.actions.categoryId,
      categorySource: "rule",
      categoryConfidence: 1,
      matchedRule,
      ruleActions: mergedActions,
      suggestion: null,
    };
  }

  // Stage 3: transfer detection result, computed by the caller.
  if (context.transferOutcome) {
    return {
      categoryId: context.transferOutcome.categoryId,
      categorySource: "rule",
      categoryConfidence: null,
      ruleActions: mergedActions,
      suggestion: context.transferOutcome.pendingSuggestion
        ? {
            categoryId: context.transferOutcome.categoryId,
            confidence: 0.5,
            origin: "memory",
          }
        : null,
    };
  }

  // Stage 4: learned merchant memory. Outranks seeds whenever any entry
  // exists, even below the auto-apply threshold.
  const sign = signOfAmount(txn.amountMinor);
  const memoryEntry = findMemoryEntry(context.memory ?? [], txn.merchantKey, txn.accountId, sign);
  if (memoryEntry) {
    const autoApply =
      memoryEntry.confidence >= thresholds.memoryAutoApplyConfidence &&
      memoryEntry.hitCount >= thresholds.memoryAutoApplyHitCount;
    if (autoApply) {
      return {
        categoryId: memoryEntry.categoryId,
        categorySource: "memory",
        categoryConfidence: memoryEntry.confidence,
        ruleActions: mergedActions,
        suggestion: null,
      };
    }
    const suppressed = isSuggestionDismissed(
      dismissed,
      txn.merchantKey,
      memoryEntry.categoryId,
      today,
    );
    return {
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      categorySource: "default",
      categoryConfidence: null,
      ruleActions: mergedActions,
      suggestion: suppressed
        ? null
        : {
            categoryId: memoryEntry.categoryId,
            confidence: memoryEntry.confidence,
            origin: "memory",
          },
    };
  }

  // Stage 5: bundled seed heuristics — only reached when no memory entry
  // exists at any lookup level.
  const seeds = context.seeds ?? SEED_HEURISTICS;
  for (const seed of seeds) {
    if (!seed.pattern.test(txn.merchantKey)) {
      continue;
    }
    const suppressed = isSuggestionDismissed(dismissed, txn.merchantKey, seed.categoryId, today);
    return {
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      categorySource: "default",
      categoryConfidence: null,
      ruleActions: mergedActions,
      suggestion: suppressed
        ? null
        : { categoryId: seed.categoryId, confidence: seed.confidence, origin: "seed" },
    };
  }

  // Stage 6 (AI) intentionally absent from this pure function — see the module
  // comment above. This fallthrough (default, no suggestion) is exactly the
  // set of transactions `listFinanceUnknownMerchants` picks up.

  // Stage 7: default.
  return {
    categoryId: UNCATEGORIZED_CATEGORY_ID,
    categorySource: "default",
    categoryConfidence: null,
    ruleActions: mergedActions,
    suggestion: null,
  };
};
