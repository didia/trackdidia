import { useEffect, useRef } from "react";
import { EmailTriageCoordinator } from "../lib/email-triage/coordinator";
import type { EmailTriageAccount } from "../domain/email-triage";
import type { AppRepository } from "../lib/storage/repository";
import { applyEmailTriageDesktopPrefs } from "../lib/email-triage/desktop-prefs";
import { createOpenRouterClassifierProvider } from "../lib/email-triage/openrouter-classifier";
import {
  createEmailTriageAdapter,
  getEmailTriageCoordinator,
  setEmailTriageCoordinator,
} from "../lib/email-triage/provider-session";
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
  getGlobalSettings: async () => repository.emailTriage.getGlobalSettings(),
  getAccount: async (accountId: string) => repository.emailTriage.getAccount(accountId),
  updateAccountSyncState: async (
    accountId: string,
    syncState: Record<string, unknown>,
    patch?: Partial<EmailTriageAccount>,
  ) => repository.emailTriage.updateAccountSyncState(accountId, syncState, patch),
  upsertConversation: async (
    accountId: string,
    conversationKey: string,
    patch: Partial<import("../domain/email-triage").EmailTriageConversation>,
  ) => repository.emailTriage.upsertConversation(accountId, conversationKey, patch),
  getConversationByKey: async (accountId: string, conversationKey: string) =>
    repository.emailTriage.getConversationByKey(accountId, conversationKey),
  persistMessageBatch: async (
    input: import("../lib/email-triage/sync-engine").PersistMessageBatchInput,
  ) => repository.emailTriage.persistMessageBatch(input),
  getMessageByProviderId: async (accountId: string, providerMessageId: string) =>
    repository.emailTriage.getMessageByProviderId(accountId, providerMessageId),
  getConversation: async (conversationId: string) =>
    repository.emailTriage.getConversation(conversationId),
  dismissPendingReviews: async (conversationId: string) =>
    repository.emailTriage.dismissPendingReviews(conversationId),
  listPendingEffects: async (conversationId: string) =>
    repository.emailTriage.listPendingEffects(conversationId),
  listPendingEffectsForAccount: async (accountId: string) =>
    repository.emailTriage.listPendingEffectsForAccount(accountId),
  saveDesiredEffect: async (effect: import("../domain/email-triage").EmailTriageDesiredEffect) => {
    await repository.emailTriage.saveDesiredEffect(effect);
  },
  getTaskByExternalId: async (externalId: string) =>
    repository.emailTriage.getTaskByExternalId(externalId),
  applyEmailTriageGtdUpdate: async (
    input: import("../lib/email-triage/sync-engine").ApplyGtdUpdateInput,
  ) => repository.emailTriage.applyGtdUpdate(input),
  createReview: async (input: import("../lib/email-triage/sync-engine").CreateReviewInput) => {
    await repository.emailTriage.createReview(input);
  },
  listAccounts: async () => repository.emailTriage.listAccounts(),
  recoverStaleEffects: async () => repository.emailTriage.recoverStaleEffects(),
  getLatestMatchingEvaluation: async (
    settings: import("../domain/email-triage").EmailTriageGlobalSettings,
  ) => repository.emailTriage.getLatestMatchingEvaluation(settings),
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

    void Promise.resolve(repository.emailTriage.getGlobalSettings()).then((settings) => {
      if (!cancelled) {
        void applyEmailTriageDesktopPrefs(settings, options.browserPreview).catch(() => undefined);
      }
    });

    const coordinator = new EmailTriageCoordinator({
      repository: buildEmailTriageRepositoryPort(repository),
      createAdapter: async (account) => {
        const settings = await repository.emailTriage.getGlobalSettings();
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
