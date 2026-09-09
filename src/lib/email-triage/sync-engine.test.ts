import { describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import type { EmailTriageAccount } from "../../domain/email-triage";
import { processProviderPage, type EmailTriageRepositoryPort } from "./sync-engine";
import {
  MockGmailAdapter,
  type MockGmailHistoryEntry,
  type MockGmailMessage,
} from "./providers/mock-gmail";
import type { EmailTriageClassifierProvider } from "./classifier";

const baseAccount = (): EmailTriageAccount => ({
  id: "acct-1",
  provider: "gmail",
  providerAccountId: "user-1",
  label: "Test",
  maskedAddress: "t***@example.com",
  generation: 1,
  enabled: true,
  mutationEnabled: false,
  paused: false,
  state: "active",
  recoveryState: "none",
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {
    baselineHistoryId: "1",
    cursorHistoryId: "1",
    pagesConsumed: 0,
    trackedMessageIds: [],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const gmailMessage = (id: string, threadId: string, body = "SECRET_BODY"): MockGmailMessage => ({
  id,
  threadId,
  historyId: "2",
  internalDate: "1700000000000",
  labelIds: ["INBOX"],
  payload: {
    headers: [
      { name: "Subject", value: "Hello" },
      { name: "From", value: "a@b.com" },
    ],
    body: { data: btoa(body) },
  },
});

const memoryPort = (
  repository: import("../storage/memory-repository").MemoryRepository,
): EmailTriageRepositoryPort => ({
  getGlobalSettings: () => repository.getEmailTriageGlobalSettings(),
  getAccount: (accountId: string) => repository.getEmailTriageAccount(accountId),
  updateAccountSyncState: (
    accountId: string,
    syncState: Record<string, unknown>,
    patch?: Partial<EmailTriageAccount>,
  ) => repository.emailTriageUpdateAccountSyncState(accountId, syncState, patch),
  upsertConversation: (
    accountId: string,
    conversationKey: string,
    patch: Partial<import("../../domain/email-triage").EmailTriageConversation>,
  ) => repository.emailTriageUpsertConversation(accountId, conversationKey, patch),
  getConversationByKey: (accountId: string, conversationKey: string) =>
    repository.emailTriageGetConversationByKey(accountId, conversationKey),
  persistMessageBatch: (input: import("./sync-engine").PersistMessageBatchInput) =>
    repository.emailTriagePersistMessageBatch(input),
  getMessageByProviderId: (accountId: string, providerMessageId: string) =>
    repository.emailTriageGetMessageByProviderId(accountId, providerMessageId),
  getConversation: (conversationId: string) =>
    repository.emailTriageGetConversation(conversationId),
  dismissPendingReviews: (conversationId: string) =>
    repository.emailTriageDismissPendingReviews(conversationId),
  listPendingEffects: (conversationId: string) =>
    repository.emailTriageListPendingEffects(conversationId),
  listPendingEffectsForAccount: (accountId: string) =>
    repository.emailTriageListPendingEffectsForAccount(accountId),
  saveDesiredEffect: async (
    effect: import("../../domain/email-triage").EmailTriageDesiredEffect,
  ) => {
    await repository.emailTriageSaveDesiredEffect(effect);
  },
  getTaskByExternalId: (externalId: string) =>
    repository.emailTriageGetTaskByExternalId(externalId),
  applyEmailTriageGtdUpdate: (input: import("./sync-engine").ApplyGtdUpdateInput) =>
    repository.emailTriageApplyGtdUpdate(input),
  createReview: async (input: import("./sync-engine").CreateReviewInput) => {
    await repository.emailTriageCreateReview(input);
  },
});

describe("sync-engine processProviderPage", () => {
  it("updates cursor only after page persistence work completes", async () => {
    const callOrder: string[] = [];
    const repository: EmailTriageRepositoryPort = {
      getGlobalSettings: async () => defaultEmailTriageGlobalSettings(),
      getAccount: async () => baseAccount(),
      updateAccountSyncState: async (_accountId, syncState) => {
        callOrder.push("updateAccountSyncState");
        return { ...baseAccount(), syncState };
      },
      upsertConversation: async (accountId, conversationKey, patch) => {
        callOrder.push("upsertConversation");
        return {
          id: "conv-1",
          accountId,
          conversationKey,
          decisionVersion: patch.decisionVersion ?? 1,
          routingState: patch.routingState ?? "review",
          taskId: null,
          lastGeneratedTitle: null,
          managedNotesRevision: 0,
          managedNotesHash: null,
          sourceUrl: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
      getConversationByKey: async () => null,
      persistMessageBatch: async () => {
        callOrder.push("persistMessageBatch");
        return { conversations: [] };
      },
      getMessageByProviderId: async () => null,
      getConversation: async () => null,
      dismissPendingReviews: async () => undefined,
      listPendingEffects: async () => [],
      listPendingEffectsForAccount: async () => [],
      saveDesiredEffect: async () => undefined,
      getTaskByExternalId: async () => null,
      applyEmailTriageGtdUpdate: async () => null,
      createReview: async () => {
        callOrder.push("createReview");
      },
    };

    const messages = new Map<string, MockGmailMessage>([
      [
        "m1",
        {
          id: "m1",
          threadId: "t1",
          historyId: "2",
          internalDate: "1700000000000",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "a@b.com" },
            ],
            body: { data: btoa("Body") },
          },
        },
      ],
    ]);
    const history: MockGmailHistoryEntry[] = [
      { historyId: "2", messagesAdded: [{ id: "m1", threadId: "t1" }] },
    ];
    const adapter = new MockGmailAdapter(history, messages);
    const classifierProvider: EmailTriageClassifierProvider = {
      completeStructured: vi.fn(async () =>
        JSON.stringify({
          decision: "review",
          relevance: null,
          ignoreReason: null,
          confidence: 0.5,
          summary: "s",
          rationale: "r",
          suggestedTaskTitle: "t",
        }),
      ),
    };

    await processProviderPage({
      repository,
      account: baseAccount(),
      adapter,
      classifierProvider,
      apiKey: "test-key",
      globalSettings: defaultEmailTriageGlobalSettings(),
      mutationEnabled: false,
    });

    expect(callOrder).toContain("persistMessageBatch");
    expect(callOrder.indexOf("updateAccountSyncState")).toBeGreaterThan(
      callOrder.indexOf("persistMessageBatch"),
    );
  });

  it("does not duplicate reviews when the same page is replayed", async () => {
    const { MemoryRepository } = await import("../storage/memory-repository");
    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveEmailTriageAccount(baseAccount());
    const history: MockGmailHistoryEntry[] = [
      { historyId: "2", messagesAdded: [{ id: "m1", threadId: "t1" }] },
    ];
    const adapter = new MockGmailAdapter(history, new Map([["m1", gmailMessage("m1", "t1")]]));
    const classifierProvider: EmailTriageClassifierProvider = {
      completeStructured: async () =>
        JSON.stringify({
          decision: "review",
          relevance: null,
          ignoreReason: null,
          confidence: 0.5,
          summary: "s",
          rationale: "r",
          suggestedTaskTitle: "t",
        }),
    };
    const port = memoryPort(repository);

    const options = {
      repository: port,
      account,
      adapter,
      classifierProvider,
      apiKey: "test-key",
      globalSettings: defaultEmailTriageGlobalSettings(),
      mutationEnabled: false,
    };
    await processProviderPage(options);
    await processProviderPage(options);
    const reviews = await repository.listEmailTriageReviews("pending");
    expect(reviews).toHaveLength(1);
    expect(JSON.stringify(reviews)).not.toContain("SECRET_BODY");
    expect(reviews[0]?.sanitizedPreview).not.toHaveProperty("bodyExcerpt");
  });

  it("creates the GTD task on replay if persist succeeded and the task write failed", async () => {
    const { MemoryRepository } = await import("../storage/memory-repository");
    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveEmailTriageAccount(baseAccount());
    const history: MockGmailHistoryEntry[] = [
      { historyId: "2", messagesAdded: [{ id: "m1", threadId: "t1" }] },
    ];
    const adapter = new MockGmailAdapter(history, new Map([["m1", gmailMessage("m1", "t1")]]));
    const port = memoryPort(repository);
    let failGtd = true;
    port.applyEmailTriageGtdUpdate = async (input) => {
      if (failGtd) {
        failGtd = false;
        throw new Error("gtd fail");
      }
      return repository.emailTriageApplyGtdUpdate(input);
    };
    const options = {
      repository: port,
      account,
      adapter,
      classifierProvider: {
        completeStructured: async () =>
          JSON.stringify({
            decision: "relevant",
            relevance: "action_required",
            ignoreReason: null,
            confidence: 0.95,
            summary: "s",
            rationale: "r",
            suggestedTaskTitle: "Follow up",
          }),
      },
      apiKey: "test-key",
      globalSettings: defaultEmailTriageGlobalSettings(),
      mutationEnabled: false,
    };
    await expect(processProviderPage(options)).rejects.toThrow(/gtd fail/);
    expect(await repository.emailTriageGetTaskByExternalId("email-triage:acct-1:t1")).toBeNull();
    await processProviderPage(options);
    expect(
      await repository.emailTriageGetTaskByExternalId("email-triage:acct-1:t1"),
    ).not.toBeNull();
  });

  it("does not recreate a pending review after the user resolves it", async () => {
    const { MemoryRepository } = await import("../storage/memory-repository");
    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveEmailTriageAccount(baseAccount());
    const history: MockGmailHistoryEntry[] = [
      { historyId: "2", messagesAdded: [{ id: "m1", threadId: "t1" }] },
    ];
    const adapter = new MockGmailAdapter(history, new Map([["m1", gmailMessage("m1", "t1")]]));
    const port = memoryPort(repository);
    const options = {
      repository: port,
      account,
      adapter,
      classifierProvider: {
        completeStructured: async () =>
          JSON.stringify({
            decision: "review",
            relevance: null,
            ignoreReason: null,
            confidence: 0.5,
            summary: "s",
            rationale: "r",
            suggestedTaskTitle: "t",
          }),
      },
      apiKey: "test-key",
      globalSettings: defaultEmailTriageGlobalSettings(),
      mutationEnabled: false,
    };
    await processProviderPage(options);
    const pending = await repository.listEmailTriageReviews("pending");
    expect(pending).toHaveLength(1);
    await repository.resolveEmailTriageReview({
      reviewId: pending[0]!.id,
      expectedDecisionVersion: pending[0]!.expectedDecisionVersion,
      resolution: "relevant",
    });
    await processProviderPage(options);
    expect(await repository.listEmailTriageReviews("pending")).toHaveLength(0);
    expect(await repository.listEmailTriageReviews("resolved")).toHaveLength(1);
    const message = await repository.emailTriageGetMessageByProviderId(account.id, "m1");
    expect(message?.routingDecision).toBe("relevant");
  });
});
