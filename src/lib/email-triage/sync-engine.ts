import type {
  EmailTriageAccount,
  EmailTriageClassifierDecision,
  EmailTriageConversation,
  EmailTriageGlobalSettings,
  EmailTriageTransientMessage,
} from "../../domain/email-triage";
import { buildEmailTriageTaskExternalId } from "../../domain/email-triage";
import { createEntityId } from "../gtd/shared";
import type { Task } from "../../domain/types";
import {
  classifyEmailMessage,
  type ClassifyEmailResult,
  type EmailTriageClassifierProvider,
} from "./classifier";
import { createDesiredEffect, pickNextPendingEffect, updateEffectStatus } from "./desired-effects";
import {
  planGtdOwnershipUpdate,
  hashManagedNotesBody,
  buildManagedNotesInnerBody,
} from "./gtd-ownership";
import { mergeSyncState, type EmailTriageProviderAdapter } from "./providers/types";
import { buildSanitizedPreviewExcerpt } from "./sanitize";

export interface EmailTriageRepositoryPort {
  getGlobalSettings(): Promise<EmailTriageGlobalSettings>;
  getAccount(accountId: string): Promise<EmailTriageAccount | null>;
  updateAccountSyncState(
    accountId: string,
    syncState: Record<string, unknown>,
    patch?: Partial<EmailTriageAccount>,
  ): Promise<EmailTriageAccount>;
  upsertConversation(
    accountId: string,
    conversationKey: string,
    patch: Partial<EmailTriageConversation>,
  ): Promise<EmailTriageConversation>;
  getConversationByKey(
    accountId: string,
    conversationKey: string,
  ): Promise<EmailTriageConversation | null>;
  persistMessageBatch(input: PersistMessageBatchInput): Promise<PersistMessageBatchResult>;
  getMessageByProviderId(
    accountId: string,
    providerMessageId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageMessage | null>;
  getConversation(conversationId: string): Promise<EmailTriageConversation | null>;
  dismissPendingReviews(conversationId: string): Promise<void>;
  listPendingEffects(
    conversationId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageDesiredEffect[]>;
  listPendingEffectsForAccount(
    accountId: string,
  ): Promise<import("../../domain/email-triage").EmailTriageDesiredEffect[]>;
  saveDesiredEffect(
    effect: import("../../domain/email-triage").EmailTriageDesiredEffect,
  ): Promise<void>;
  getTaskByExternalId(externalId: string): Promise<Task | null>;
  applyEmailTriageGtdUpdate(input: ApplyGtdUpdateInput): Promise<Task | null>;
  createReview(input: CreateReviewInput): Promise<void>;
}

export interface PersistMessageAttemptInput {
  id: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  decision: EmailTriageClassifierDecision;
  relevance: import("../../domain/email-triage").EmailTriageRelevance;
  ignoreReason: import("../../domain/email-triage").EmailTriageIgnoreReason;
  confidence: number;
  summary: string;
  rationale: string;
  suggestedTaskTitle: string;
  rawValid: boolean;
  reviewReasons: string[];
}

export interface PersistMessageBatchInput {
  accountId: string;
  messages: Array<{
    transient: EmailTriageTransientMessage;
    routedDecision: EmailTriageClassifierDecision;
    summary: string | null;
    attempt: PersistMessageAttemptInput;
  }>;
}

export interface PersistMessageBatchResult {
  conversations: EmailTriageConversation[];
}

export interface ApplyGtdUpdateInput {
  externalId: string;
  plan: ReturnType<typeof planGtdOwnershipUpdate>;
  conversation: EmailTriageConversation;
  accountId: string;
}

export interface CreateReviewInput {
  accountId: string;
  conversationId: string;
  messageId: string;
  expectedDecisionVersion: number;
  reason: string;
  preview: {
    subject: string;
    sender: string;
    receivedAt: string;
    bodyExcerpt: string;
    sourceUrl: string | null;
  };
}

export interface SyncEngineOptions {
  repository: EmailTriageRepositoryPort;
  account: EmailTriageAccount;
  adapter: EmailTriageProviderAdapter;
  classifierProvider: EmailTriageClassifierProvider;
  apiKey: string | null;
  globalSettings: EmailTriageGlobalSettings;
  mutationEnabled: boolean;
}

export const processProviderPage = async (
  options: SyncEngineOptions,
): Promise<{ hasMore: boolean; gapDetected: boolean }> => {
  const page = await options.adapter.fetchPage(options.account.syncState);

  for (const transient of page.messages) {
    await processTransientMessage(options, transient);
  }

  if (page.cursorUpdate || page.gapDetected) {
    const mergedState = page.cursorUpdate
      ? mergeSyncState(options.account.syncState, page.cursorUpdate)
      : options.account.syncState;
    await options.repository.updateAccountSyncState(
      options.account.id,
      mergedState,
      page.gapDetected ? { state: "gap_review_required", recoveryState: "in_progress" } : undefined,
    );
  }

  return { hasMore: page.hasMore, gapDetected: page.gapDetected };
};

const buildPersistAttempt = (
  attemptId: string,
  classifyResult: ClassifyEmailResult,
  globalSettings: EmailTriageGlobalSettings,
): PersistMessageAttemptInput => ({
  id: attemptId,
  model: globalSettings.classifierModel,
  promptVersion: classifyResult.promptVersion,
  schemaVersion: classifyResult.schemaVersion,
  decision: classifyResult.output?.decision ?? "review",
  relevance: classifyResult.output?.relevance ?? null,
  ignoreReason: classifyResult.output?.ignoreReason ?? null,
  confidence: classifyResult.output?.confidence ?? 0,
  summary: classifyResult.output?.summary ?? "",
  rationale: classifyResult.output?.rationale ?? "",
  suggestedTaskTitle: classifyResult.output?.suggestedTaskTitle ?? "",
  rawValid: classifyResult.rawValid,
  reviewReasons: classifyResult.reviewReasons,
});

const persistClassifiedMessage = async (
  options: SyncEngineOptions,
  transient: EmailTriageTransientMessage,
  classifyResult: ClassifyEmailResult,
  routedDecision: EmailTriageClassifierDecision,
): Promise<void> => {
  const attemptId = createEntityId("email-attempt");
  await options.repository.persistMessageBatch({
    accountId: options.account.id,
    messages: [
      {
        transient,
        routedDecision,
        summary: classifyResult.output?.summary ?? null,
        attempt: buildPersistAttempt(attemptId, classifyResult, options.globalSettings),
      },
    ],
  });
};

const routingStateFor = (
  decision: EmailTriageClassifierDecision,
): EmailTriageConversation["routingState"] => {
  if (decision === "relevant") {
    return "relevant";
  }
  if (decision === "ignore") {
    return "ignored";
  }
  return "review";
};

const bumpConversationIfRoutingChanged = async (
  options: SyncEngineOptions,
  conversation: EmailTriageConversation,
  transient: EmailTriageTransientMessage,
  nextRoutingState: EmailTriageConversation["routingState"],
  extraPatch: Partial<EmailTriageConversation> = {},
): Promise<EmailTriageConversation> => {
  const routingChanged = conversation.routingState !== nextRoutingState;
  if (routingChanged) {
    await options.repository.dismissPendingReviews(conversation.id);
  }
  return options.repository.upsertConversation(options.account.id, transient.conversationKey, {
    ...(routingChanged
      ? { decisionVersion: conversation.decisionVersion + 1, routingState: nextRoutingState }
      : {}),
    sourceUrl: transient.sourceUrl,
    ...extraPatch,
  });
};

const processTransientMessage = async (
  options: SyncEngineOptions,
  transient: EmailTriageTransientMessage,
): Promise<void> => {
  if (!transient.inInbox) {
    return;
  }

  let conversation =
    (await options.repository.getConversationByKey(
      options.account.id,
      transient.conversationKey,
    )) ??
    (await options.repository.upsertConversation(options.account.id, transient.conversationKey, {
      decisionVersion: 0,
      routingState: "pending",
      taskId: null,
      lastGeneratedTitle: null,
      managedNotesRevision: 0,
      managedNotesHash: null,
      sourceUrl: transient.sourceUrl,
    }));

  const classifyResult =
    options.apiKey !== null
      ? await classifyEmailMessage({
          input: {
            subject: transient.subject,
            sender: transient.sender,
            recipients: transient.recipients,
            receivedAt: transient.receivedAt,
            bodyText: transient.bodyText,
          },
          provider: options.classifierProvider,
          apiKey: options.apiKey,
          model: options.globalSettings.classifierModel,
          relevantThreshold: options.globalSettings.relevantThreshold,
          ignoreThreshold: options.globalSettings.ignoreThreshold,
        })
      : {
          rawValid: false,
          reviewReasons: ["missing_api_key"],
          routedDecision: "review" as const,
          output: null,
          promptVersion: options.globalSettings.classifierPromptVersion,
          schemaVersion: options.globalSettings.classifierSchemaVersion,
          validationErrors: ["missing_api_key"],
        };

  const routedDecision = classifyResult.routedDecision;
  const existingMessage = await options.repository.getMessageByProviderId(
    options.account.id,
    transient.providerMessageId,
  );
  const alreadyProcessed = existingMessage?.routingDecision === routedDecision;
  const externalId = buildEmailTriageTaskExternalId(options.account.id, transient.conversationKey);
  const existingTask = await options.repository.getTaskByExternalId(externalId);

  if (!alreadyProcessed) {
    await persistClassifiedMessage(options, transient, classifyResult, routedDecision);
  }

  if (routedDecision === "review") {
    if (!alreadyProcessed) {
      conversation = await bumpConversationIfRoutingChanged(
        options,
        conversation,
        transient,
        "review",
      );
    }
    await options.repository.createReview({
      accountId: options.account.id,
      conversationId: conversation.id,
      messageId: transient.providerMessageId,
      expectedDecisionVersion: conversation.decisionVersion,
      reason: classifyResult.reviewReasons.join(",") || "review",
      preview: {
        subject: transient.subject,
        sender: transient.sender,
        receivedAt: transient.receivedAt,
        bodyExcerpt: buildSanitizedPreviewExcerpt(transient.bodyText),
        sourceUrl: transient.sourceUrl,
      },
    });
    return;
  }

  const plan = planGtdOwnershipUpdate({
    conversation,
    existingTask,
    routedDecision,
    suggestedTitle: classifyResult.output?.suggestedTaskTitle ?? transient.subject,
    summary: classifyResult.output?.summary ?? "",
    rationale: classifyResult.output?.rationale ?? "",
    sourceUrl: transient.sourceUrl,
  });

  if (plan.reviewRequired) {
    if (!alreadyProcessed) {
      conversation = await bumpConversationIfRoutingChanged(
        options,
        conversation,
        transient,
        "review",
      );
    }
    await options.repository.createReview({
      accountId: options.account.id,
      conversationId: conversation.id,
      messageId: transient.providerMessageId,
      expectedDecisionVersion: conversation.decisionVersion,
      reason: plan.reviewReason ?? "review",
      preview: {
        subject: transient.subject,
        sender: transient.sender,
        receivedAt: transient.receivedAt,
        bodyExcerpt: buildSanitizedPreviewExcerpt(transient.bodyText),
        sourceUrl: transient.sourceUrl,
      },
    });
    return;
  }

  if (alreadyProcessed) {
    return;
  }

  const nextRoutingState = routingStateFor(routedDecision);
  const nextRevision = conversation.managedNotesRevision + 1;
  conversation = await bumpConversationIfRoutingChanged(
    options,
    conversation,
    transient,
    nextRoutingState,
    {
      lastGeneratedTitle: plan.title,
      managedNotesRevision: nextRevision,
      managedNotesHash: hashManagedNotesBody(
        buildManagedNotesInnerBody(
          classifyResult.output?.summary ?? "",
          classifyResult.output?.rationale ?? "",
        ),
      ),
    },
  );

  if (routedDecision === "relevant") {
    await options.repository.applyEmailTriageGtdUpdate({
      externalId,
      plan,
      conversation,
      accountId: options.account.id,
    });
  }

  const gtdEffect = createDesiredEffect({
    accountId: options.account.id,
    accountGeneration: options.account.generation,
    conversationId: conversation.id,
    decisionVersion: conversation.decisionVersion,
    effectType: "gtd_task",
    targetMessageIds: [transient.providerMessageId],
  });
  await options.repository.saveDesiredEffect(gtdEffect);

  if (
    options.mutationEnabled &&
    options.globalSettings.mutationEnabled &&
    options.account.mutationEnabled &&
    options.adapter.applyMarkers
  ) {
    const providerEffect = createDesiredEffect({
      accountId: options.account.id,
      accountGeneration: options.account.generation,
      conversationId: conversation.id,
      decisionVersion: conversation.decisionVersion,
      effectType: "provider_marker",
      targetMessageIds: [transient.providerMessageId],
      dependencies: [gtdEffect.id],
    });
    await options.repository.saveDesiredEffect(providerEffect);
  }
};

export const reconcilePendingEffects = async (
  options: SyncEngineOptions,
  accountId: string,
): Promise<void> => {
  const effects = await options.repository.listPendingEffectsForAccount(accountId);
  const next = pickNextPendingEffect(effects);
  if (!next) {
    return;
  }
  const conversation = await options.repository.getConversation(next.conversationId);
  if (!conversation) {
    await options.repository.saveDesiredEffect(
      updateEffectStatus(next, "failed", "conversation_missing"),
    );
    return;
  }
  if (next.effectType !== "provider_marker" || !options.adapter.applyMarkers) {
    await options.repository.saveDesiredEffect(updateEffectStatus(next, "completed"));
    return;
  }
  if (!options.mutationEnabled) {
    return;
  }
  const markerDecision = conversation.routingState === "ignored" ? "ignore" : "relevant";
  if (conversation.routingState === "review" || conversation.routingState === "pending") {
    return;
  }
  const inProgress = updateEffectStatus(next, "in_progress");
  await options.repository.saveDesiredEffect(inProgress);
  try {
    await options.adapter.applyMarkers({
      messageIds: next.targetMessageIds,
      decision: markerDecision,
    });
    await options.repository.saveDesiredEffect(updateEffectStatus(inProgress, "completed"));
  } catch (error) {
    await options.repository.saveDesiredEffect(
      updateEffectStatus(
        inProgress,
        "failed",
        error instanceof Error ? error.message : "apply_markers_failed",
      ),
    );
  }
};
