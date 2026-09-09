import { describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import type { EmailTriageAccount } from "../../domain/email-triage";
import { processProviderPage, type EmailTriageRepositoryPort } from "./sync-engine";
import { MockGmailAdapter, type MockGmailHistoryEntry, type MockGmailMessage } from "./providers/mock-gmail";
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
  syncState: { baselineHistoryId: "1", cursorHistoryId: "1", pagesConsumed: 0, trackedMessageIds: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
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
      listPendingEffects: async () => [],
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
});
