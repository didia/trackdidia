import { useEffect, useRef } from "react";
import { EmailTriageCoordinator } from "../lib/email-triage/coordinator";
import { MockGmailAdapter } from "../lib/email-triage/providers/mock-gmail";
import { MockGraphAdapter } from "../lib/email-triage/providers/mock-graph";
import { MockYahooAdapter } from "../lib/email-triage/providers/mock-yahoo";
import type { EmailTriageAccount } from "../domain/email-triage";
import type { AppRepository } from "../lib/storage/repository";
import type { EmailTriageClassifierProvider } from "../lib/email-triage/classifier";

const mockClassifierProvider: EmailTriageClassifierProvider = {
  async completeStructured() {
    return JSON.stringify({
      decision: "review",
      relevance: null,
      ignoreReason: null,
      confidence: 0.5,
      summary: "Mock",
      rationale: "Mock classifier in foundation slice",
      suggestedTaskTitle: "Review email",
    });
  },
};

const createMockAdapter = (account: EmailTriageAccount) => {
  switch (account.provider) {
    case "gmail":
      return new MockGmailAdapter([], new Map());
    case "microsoft_graph":
      return new MockGraphAdapter([]);
    case "yahoo":
      return new MockYahooAdapter([]);
    default:
      return null;
  }
};

const buildEmailTriageRepositoryPort = (repository: AppRepository) => ({
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
    patch: Partial<import("../domain/email-triage").EmailTriageConversation>,
  ) => repository.emailTriageUpsertConversation(accountId, conversationKey, patch),
  getConversationByKey: (accountId: string, conversationKey: string) =>
    repository.emailTriageGetConversationByKey(accountId, conversationKey),
  persistMessageBatch: (
    input: import("../lib/email-triage/sync-engine").PersistMessageBatchInput,
  ) => repository.emailTriagePersistMessageBatch(input),
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
  saveDesiredEffect: async (effect: import("../domain/email-triage").EmailTriageDesiredEffect) => {
    await repository.emailTriageSaveDesiredEffect(effect);
  },
  getTaskByExternalId: (externalId: string) =>
    repository.emailTriageGetTaskByExternalId(externalId),
  applyEmailTriageGtdUpdate: (
    input: import("../lib/email-triage/sync-engine").ApplyGtdUpdateInput,
  ) => repository.emailTriageApplyGtdUpdate(input),
  createReview: async (input: import("../lib/email-triage/sync-engine").CreateReviewInput) => {
    await repository.emailTriageCreateReview(input);
  },
  listAccounts: () => repository.listEmailTriageAccounts(),
  recoverStaleEffects: () => repository.recoverEmailTriageStaleEffects(),
});

export const useEmailTriageCoordinator = (
  repository: AppRepository | null,
  options: { browserPreview: boolean; allowStart: boolean },
): { reconfigure: () => Promise<void> } => {
  const coordinatorRef = useRef<EmailTriageCoordinator | null>(null);

  useEffect(() => {
    if (!repository || options.browserPreview || !options.allowStart) {
      coordinatorRef.current = null;
      return;
    }

    const coordinator = new EmailTriageCoordinator({
      repository: buildEmailTriageRepositoryPort(repository),
      createAdapter: createMockAdapter,
      classifierProvider: mockClassifierProvider,
      browserPreview: options.browserPreview,
    });
    coordinatorRef.current = coordinator;
    void coordinator.start();

    return () => {
      coordinator.stop();
      coordinatorRef.current = null;
    };
  }, [repository, options.browserPreview, options.allowStart]);

  return {
    reconfigure: async () => {
      await coordinatorRef.current?.reconfigure();
    },
  };
};
