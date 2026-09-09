import { useEffect, useRef } from "react";
import { EmailTriageCoordinator } from "../lib/email-triage/coordinator";
import type { EmailTriageAccount } from "../domain/email-triage";
import type { AppRepository } from "../lib/storage/repository";
import { createOpenRouterClassifierProvider } from "../lib/email-triage/openrouter-classifier";
import {
  createEmailTriageAdapter,
  getEmailTriageCoordinator,
  setEmailTriageCoordinator,
} from "../lib/email-triage/gmail-session";
import { loadVaultSecret } from "../lib/email-triage/vault";
import type { EmailTriageClassifierProvider } from "../lib/email-triage/classifier";
import type { AppSettings } from "../domain/types";

const mockClassifierProvider: EmailTriageClassifierProvider = {
  async completeStructured() {
    return JSON.stringify({
      decision: "review",
      relevance: null,
      ignoreReason: null,
      confidence: 0.5,
      summary: "Mock",
      rationale: "Mock classifier in browser preview",
      suggestedTaskTitle: "Review email",
    });
  },
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
  options: { browserPreview: boolean; allowStart: boolean; settings: AppSettings },
): { reconfigure: () => Promise<void> } => {
  const coordinatorRef = useRef<EmailTriageCoordinator | null>(null);

  useEffect(() => {
    if (!repository || options.browserPreview || !options.allowStart) {
      coordinatorRef.current = null;
      setEmailTriageCoordinator(null);
      return;
    }

    let cancelled = false;
    const classifierProvider = createOpenRouterClassifierProvider(options.settings.aiBaseUrl);

    const coordinator = new EmailTriageCoordinator({
      repository: buildEmailTriageRepositoryPort(repository),
      createAdapter: async (account) => {
        const settings = await repository.getEmailTriageGlobalSettings();
        return createEmailTriageAdapter(account, settings, repository);
      },
      classifierProvider: {
        completeStructured: async (request) => {
          const triageKey = await loadVaultSecret("triage_api_key");
          if (!triageKey) {
            return mockClassifierProvider.completeStructured(request);
          }
          return classifierProvider.completeStructured({
            ...request,
            apiKey: triageKey,
          });
        },
      },
      browserPreview: options.browserPreview,
    });
    coordinatorRef.current = coordinator;
    setEmailTriageCoordinator(coordinator);
    void coordinator.start().then(() => {
      if (cancelled) {
        coordinator.stop();
        if (getEmailTriageCoordinator() === coordinator) {
          setEmailTriageCoordinator(null);
        }
      }
    });

    return () => {
      cancelled = true;
      coordinator.stop();
      coordinatorRef.current = null;
      setEmailTriageCoordinator(null);
    };
  }, [repository, options.browserPreview, options.allowStart, options.settings.aiBaseUrl]);

  return {
    reconfigure: async () => {
      await coordinatorRef.current?.reconfigure();
    },
  };
};
