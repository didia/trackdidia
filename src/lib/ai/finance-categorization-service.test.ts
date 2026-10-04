import { defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import { FinanceCategorizationService } from "./finance-categorization-service";
import type { AiProvider } from "./provider";

const timestamp = new Date().toISOString();

const seedAccount = async (repository: MemoryRepository) => {
  await repository.saveFinanceAccount({
    id: "finance-account:checking",
    name: "Compte chèques",
    institution: null,
    type: "checking",
    currency: "CAD",
    ownerPersonId: null,
    ownership: "individual",
    onBudget: true,
    closed: false,
    openingBalanceMinor: 0,
    currentBalanceMinor: null,
    balanceAsOf: null,
    externalKey: null,
    notes: null,
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repository.seedFinanceDefaultCategories();
};

const seedUnknownTransaction = async (
  repository: MemoryRepository,
  overrides: Partial<Parameters<MemoryRepository["saveFinanceTransaction"]>[0]> = {},
) =>
  repository.saveFinanceTransaction({
    id: "finance-txn:1",
    accountId: "finance-account:checking",
    postedDate: "2024-01-05",
    amountMinor: -1234,
    currency: "CAD",
    descriptionRaw: "Epicerie Metro",
    descriptionOriginal: null,
    merchantKey: "EPICERIE METRO",
    merchantDisplay: null,
    categoryId: "fincat:non-categorise",
    categorySource: "default",
    categoryConfidence: null,
    categorizedAt: null,
    personId: null,
    notes: null,
    labelsJson: null,
    pending: false,
    isTransfer: false,
    transferGroupId: null,
    excludedFromBudget: false,
    excludedFromReports: false,
    hasSplits: false,
    importBatchId: null,
    dedupeHash: "hash-1",
    sourceRowJson: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });

const financeSettings = (overrides: Partial<ReturnType<typeof defaultAppSettings>> = {}) => ({
  ...defaultAppSettings(),
  financeEnabled: true,
  financeAiCategorizationEnabled: true,
  ...overrides,
});

describe("FinanceCategorizationService", () => {
  it("is skipped (not even a read) when financeAiCategorizationEnabled is off", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = { generateStructured: vi.fn() };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(
      repository,
      financeSettings({ financeAiCategorizationEnabled: false }),
    );

    expect(result.ran).toBe(false);
    expect(provider.generateStructured).not.toHaveBeenCalled();
    const suggestions = await repository.listFinanceCategorySuggestions();
    expect(suggestions).toHaveLength(0);
  });

  it("persists a skipped status and applies nothing when AI is unconfigured", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = { generateStructured: vi.fn() };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(repository, financeSettings({ aiEnabled: false }));

    expect(result.ran).toBe(true);
    expect(result.suggestionsCreated).toBe(0);
    expect(provider.generateStructured).not.toHaveBeenCalled();
    const messages = await repository.listAiMessages("finance_categorization");
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("skipped");
  });

  it("classifies an unknown merchant, writes a pending AI suggestion, and caches by input hash", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          merchants: [
            {
              merchantKey: "EPICERIE METRO",
              categoryId: "fincat:alimentation.epicerie",
              confidence: 0.7,
              rationale: "Chaîne d'épicerie reconnue.",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 50 },
      })),
    };
    const service = new FinanceCategorizationService(provider);
    const settings = financeSettings({ aiEnabled: true, aiApiKey: "secret" });

    const first = await service.classifyPending(repository, settings);
    expect(first.suggestionsCreated).toBe(1);
    expect(first.autoApplied).toBe(0);

    const suggestions = await repository.listFinanceCategorySuggestions("pending");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].origin).toBe("ai");
    expect(suggestions[0].suggestedCategoryId).toBe("fincat:alimentation.epicerie");
    expect(suggestions[0].rationale).toBe("Chaîne d'épicerie reconnue.");

    // The transaction now carries a pending suggestion, so it is no longer an "unknown merchant"
    // — a second run must not call the AI again for the same batch, and the cache applies the
    // identical (already-applied) result again without creating a duplicate pending suggestion.
    const second = await service.classifyPending(repository, settings);
    expect(provider.generateStructured).toHaveBeenCalledOnce();
    expect(second.chunksProcessed).toBe(0);
  });

  it("does not replay a cached answer that only collides with a dismissed suggestion", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          merchants: [
            {
              merchantKey: "EPICERIE METRO",
              categoryId: "fincat:alimentation.epicerie",
              confidence: 0.7,
              rationale: "Chaîne d'épicerie reconnue.",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 50 },
      })),
    };
    const service = new FinanceCategorizationService(provider);
    const settings = financeSettings({ aiEnabled: true, aiApiKey: "secret" });

    const first = await service.classifyPending(repository, settings);
    expect(first.merchantsSent).toBe(1);
    const [pending] = await repository.listFinanceCategorySuggestions("pending");
    await repository.decideFinanceCategorySuggestion(pending.id, { status: "dismissed" });

    // The row is unknown again with an identical snapshot: the cache hit only suppresses, so the
    // service goes back to the provider instead of reporting a silent empty success.
    const second = await service.classifyPending(repository, settings);
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    expect(second.merchantsSent).toBe(1);
    expect(second.suppressedDismissed).toBe(1);
    expect(second.suggestionsCreated).toBe(0);
  });

  it("auto-applies when financeAiAutoApplyEnabled and confidence meets the threshold", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          merchants: [
            {
              merchantKey: "EPICERIE METRO",
              categoryId: "fincat:alimentation.epicerie",
              confidence: 0.95,
              rationale: "Chaîne d'épicerie reconnue.",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 50 },
      })),
    };
    const service = new FinanceCategorizationService(provider);
    const settings = financeSettings({
      aiEnabled: true,
      aiApiKey: "secret",
      financeAiAutoApplyEnabled: true,
      financeAiAutoApplyMinConfidence: 0.9,
    });

    const result = await service.classifyPending(repository, settings);
    expect(result.autoApplied).toBe(1);

    const txn = await repository.getFinanceTransaction("finance-txn:1");
    expect(txn?.categoryId).toBe("fincat:alimentation.epicerie");
    expect(txn?.categorySource).toBe("ai");
  });

  it("never overwrites a user-set category", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository, {
      categoryId: "fincat:transport.essence",
      categorySource: "user",
    });
    const provider: AiProvider = { generateStructured: vi.fn() };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(
      repository,
      financeSettings({ aiEnabled: true, aiApiKey: "secret" }),
    );

    // The row is already user-categorized, so it is never an "unknown merchant" candidate.
    expect(result.chunksProcessed).toBe(0);
    expect(provider.generateStructured).not.toHaveBeenCalled();
    const txn = await repository.getFinanceTransaction("finance-txn:1");
    expect(txn?.categorySource).toBe("user");
    expect(txn?.categoryId).toBe("fincat:transport.essence");
  });

  it("repairs once on invalid JSON and falls back when the repair also fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: "not json",
        model: "test-model",
        usage: { tokensPrompt: 5, tokensCompletion: 5, latencyMs: 10 },
      })),
    };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(
      repository,
      financeSettings({ aiEnabled: true, aiApiKey: "secret" }),
    );

    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    expect(result.suggestionsCreated).toBe(0);
    expect(result.warning).toBeTruthy();
    const messages = await repository.listAiMessages("finance_categorization");
    expect(messages[0].status).toBe("fallback");
  });

  it("falls back when the provider throws", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(
      repository,
      financeSettings({ aiEnabled: true, aiApiKey: "secret" }),
    );

    expect(result.suggestionsCreated).toBe(0);
    expect(result.warning).toBe("provider request failed");
  });

  it("rejects an out-of-list category id, treating the response as invalid and falling back", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          merchants: [
            {
              merchantKey: "EPICERIE METRO",
              categoryId: "fincat:non-categorise",
              confidence: 0.9,
              rationale: "Hors liste.",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 5, tokensCompletion: 5, latencyMs: 10 },
      })),
    };
    const service = new FinanceCategorizationService(provider);

    const result = await service.classifyPending(
      repository,
      financeSettings({ aiEnabled: true, aiApiKey: "secret" }),
    );

    expect(result.suggestionsCreated).toBe(0);
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("records a call in the AI cost/usage dashboard totals", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccount(repository);
    await seedUnknownTransaction(repository);
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          merchants: [
            {
              merchantKey: "EPICERIE METRO",
              categoryId: "fincat:alimentation.epicerie",
              confidence: 0.6,
              rationale: "Chaîne d'épicerie reconnue.",
            },
          ],
        }),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 50 },
      })),
    };
    const service = new FinanceCategorizationService(provider);

    await service.classifyPending(
      repository,
      financeSettings({ aiEnabled: true, aiApiKey: "secret" }),
    );

    const monthKey = timestamp.slice(0, 7);
    const usage = await repository.computeAiUsageForMonth(monthKey);
    expect(usage.callCount).toBeGreaterThanOrEqual(1);
    expect(usage.tokensPrompt).toBeGreaterThanOrEqual(10);
  });
});
