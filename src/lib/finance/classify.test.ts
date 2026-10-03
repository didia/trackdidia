import type { FinanceMerchantMemoryEntry, FinanceRule } from "../../domain/finance";
import { classifyTransaction, type ClassifyTransactionInput } from "./classify";

const baseTxn = (overrides: Partial<ClassifyTransactionInput> = {}): ClassifyTransactionInput => ({
  categoryId: "fincat:non-categorise",
  categorySource: "default",
  accountId: "acct-1",
  amountMinor: -4200,
  merchantKey: "IGA MONTREAL",
  personId: null,
  ...overrides,
});

const rule = (overrides: Partial<FinanceRule> = {}): FinanceRule => ({
  id: "rule-1",
  name: "test rule",
  priority: 0,
  enabled: true,
  matcher: {},
  actions: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastAppliedAt: null,
  appliedCount: 0,
  ...overrides,
});

const memoryEntry = (
  overrides: Partial<FinanceMerchantMemoryEntry> = {},
): FinanceMerchantMemoryEntry => ({
  merchantKey: "IGA MONTREAL",
  accountId: "",
  sign: -1,
  categoryId: "fincat:alimentation.epicerie",
  hitCount: 5,
  correctionCount: 0,
  confidence: 0.9,
  source: "user_correction",
  lastAppliedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("classifyTransaction", () => {
  it("stage 1: a user-set category is never touched, even with matching rules/memory/seeds", () => {
    const txn = baseTxn({ categorySource: "user", categoryId: "fincat:alimentation.restaurants" });
    const outcome = classifyTransaction(txn, {
      rules: [rule({ matcher: {}, actions: { categoryId: "fincat:transport.essence" } })],
      memory: [memoryEntry()],
    });
    expect(outcome).toEqual({
      categoryId: "fincat:alimentation.restaurants",
      categorySource: "user",
      categoryConfidence: null,
      suggestion: null,
    });
  });

  it("stage 2: a matching rule wins with confidence 1 and source rule", () => {
    const txn = baseTxn();
    const matchingRule = rule({
      matcher: { descriptionContains: "IGA" },
      actions: { categoryId: "fincat:alimentation.epicerie" },
    });
    const outcome = classifyTransaction(txn, {
      rules: [matchingRule],
      memory: [memoryEntry({ categoryId: "fincat:alimentation.restaurants" })],
    });
    expect(outcome.categoryId).toBe("fincat:alimentation.epicerie");
    expect(outcome.categorySource).toBe("rule");
    expect(outcome.categoryConfidence).toBe(1);
    expect(outcome.matchedRule?.id).toBe("rule-1");
  });

  it("stage 2: descriptionContains matches through accent-stripping, same as merchantKey normalization", () => {
    const txn = baseTxn({ merchantKey: "EPICERIE METRO" });
    const matchingRule = rule({
      matcher: { descriptionContains: "Épicerie" },
      actions: { categoryId: "fincat:alimentation.epicerie" },
    });
    const outcome = classifyTransaction(txn, { rules: [matchingRule] });
    expect(outcome.categoryId).toBe("fincat:alimentation.epicerie");
    expect(outcome.categorySource).toBe("rule");
  });

  it("stage 2: rule priority and id order decide which rule's category wins", () => {
    const txn = baseTxn();
    const low = rule({
      id: "rule-b",
      priority: 5,
      actions: { categoryId: "fincat:transport.essence" },
    });
    const high = rule({
      id: "rule-a",
      priority: 1,
      actions: { categoryId: "fincat:alimentation.epicerie" },
    });
    const outcome = classifyTransaction(txn, { rules: [low, high] });
    expect(outcome.categoryId).toBe("fincat:alimentation.epicerie");
  });

  it("stage 2: an invalid descriptionRegex never throws and never matches", () => {
    const txn = baseTxn();
    const brokenRule = rule({
      matcher: { descriptionRegex: "(unclosed" },
      actions: { categoryId: "fincat:transport.essence" },
    });
    expect(() => classifyTransaction(txn, { rules: [brokenRule] })).not.toThrow();
    const outcome = classifyTransaction(txn, { rules: [brokenRule] });
    expect(outcome.categoryId).toBe("fincat:non-categorise");
    expect(outcome.categorySource).toBe("default");
  });

  it("stage 3: a transfer outcome wins over memory and seeds when no rule matches", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      transferOutcome: { categoryId: "fincat:transfert", pendingSuggestion: false },
      memory: [memoryEntry()],
    });
    expect(outcome.categoryId).toBe("fincat:transfert");
    expect(outcome.categorySource).toBe("rule");
    expect(outcome.suggestion).toBeNull();
  });

  it("stage 3: a probable (single-sided) transfer still carries a pending suggestion", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      transferOutcome: { categoryId: "fincat:non-categorise", pendingSuggestion: true },
    });
    expect(outcome.suggestion).toEqual({
      categoryId: "fincat:non-categorise",
      confidence: 0.5,
      origin: "memory",
    });
  });

  it("stage 4: memory at/above threshold auto-applies with source memory", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, { memory: [memoryEntry()] });
    expect(outcome).toEqual({
      categoryId: "fincat:alimentation.epicerie",
      categorySource: "memory",
      categoryConfidence: 0.9,
      ruleActions: null,
      suggestion: null,
    });
  });

  it("stage 4: memory below the confidence threshold suggests instead of applying", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      memory: [memoryEntry({ confidence: 0.7, hitCount: 5 })],
    });
    expect(outcome.categorySource).toBe("default");
    expect(outcome.categoryId).toBe("fincat:non-categorise");
    expect(outcome.suggestion).toEqual({
      categoryId: "fincat:alimentation.epicerie",
      confidence: 0.7,
      origin: "memory",
    });
  });

  it("stage 4: memory below the hit-count threshold suggests instead of applying", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      memory: [memoryEntry({ confidence: 0.95, hitCount: 1 })],
    });
    expect(outcome.categorySource).toBe("default");
    expect(outcome.suggestion?.origin).toBe("memory");
  });

  it("stage 4: memory lookup falls back from exact account to any-account same-sign to any-account any-sign", () => {
    const txn = baseTxn({ accountId: "acct-2" });
    const anyAccountAnySign = memoryEntry({
      accountId: "",
      sign: 0,
      confidence: 0.6,
      categoryId: "fincat:famille.garde-enfants",
    });
    const outcome = classifyTransaction(txn, { memory: [anyAccountAnySign] });
    expect(outcome.categoryId).toBe("fincat:non-categorise");
    expect(outcome.suggestion?.categoryId).toBe("fincat:famille.garde-enfants");
  });

  it("stage 4: a dismissed (merchant, category) pair suppresses the suggestion for 90 days", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      memory: [memoryEntry({ confidence: 0.7 })],
      dismissed: [
        {
          merchantKey: "IGA MONTREAL",
          categoryId: "fincat:alimentation.epicerie",
          dismissedAt: "2026-01-01",
        },
      ],
      today: "2026-02-01",
    });
    expect(outcome.suggestion).toBeNull();
  });

  it("stage 4: the suppression expires after 90 days", () => {
    const txn = baseTxn();
    const outcome = classifyTransaction(txn, {
      memory: [memoryEntry({ confidence: 0.7 })],
      dismissed: [
        {
          merchantKey: "IGA MONTREAL",
          categoryId: "fincat:alimentation.epicerie",
          dismissedAt: "2026-01-01",
        },
      ],
      today: "2026-05-01",
    });
    expect(outcome.suggestion).not.toBeNull();
  });

  it("stage 5: a seed heuristic never auto-applies, only suggests, capped at 0.7", () => {
    const txn = baseTxn({ merchantKey: "METRO PLUS" });
    const outcome = classifyTransaction(txn, {});
    expect(outcome.categorySource).toBe("default");
    expect(outcome.categoryId).toBe("fincat:non-categorise");
    expect(outcome.suggestion).toEqual({
      categoryId: "fincat:alimentation.epicerie",
      confidence: 0.7,
      origin: "seed",
    });
  });

  it("stage 5: seeds are only consulted when no memory entry exists at all", () => {
    const txn = baseTxn({ merchantKey: "METRO PLUS" });
    const outcome = classifyTransaction(txn, {
      memory: [
        memoryEntry({
          merchantKey: "METRO PLUS",
          confidence: 0.5,
          categoryId: "fincat:loisirs.sorties",
        }),
      ],
    });
    expect(outcome.suggestion?.origin).toBe("memory");
    expect(outcome.suggestion?.categoryId).toBe("fincat:loisirs.sorties");
  });

  it("stage 5: a dismissed seed suggestion is suppressed", () => {
    const txn = baseTxn({ merchantKey: "METRO PLUS" });
    const outcome = classifyTransaction(txn, {
      dismissed: [
        {
          merchantKey: "METRO PLUS",
          categoryId: "fincat:alimentation.epicerie",
          dismissedAt: "2026-01-01",
        },
      ],
      today: "2026-01-10",
    });
    expect(outcome.suggestion).toBeNull();
  });

  it("stage 7: an unmatched transaction falls through to Uncategorized/default with no suggestion", () => {
    const txn = baseTxn({ merchantKey: "ACME WIDGET CORP" });
    const outcome = classifyTransaction(txn, {});
    expect(outcome).toEqual({
      categoryId: "fincat:non-categorise",
      categorySource: "default",
      categoryConfidence: null,
      ruleActions: null,
      suggestion: null,
    });
  });
});
