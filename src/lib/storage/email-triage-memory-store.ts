import {
  buildEmailTriageTaskExternalId,
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageAuditEvent,
  type EmailTriageClassificationAttempt,
  type EmailTriageConversation,
  type EmailTriageDesiredEffect,
  type EmailTriageEvaluation,
  type EmailTriageGlobalSettings,
  type EmailTriageMessage,
  type EmailTriageReview,
} from "../../domain/email-triage";
import type { Task } from "../../domain/types";
import { buildLifecycleEvents, type createTaskFromInput } from "../gtd/engine";
import { cloneTask, createEntityId, nowIso } from "../gtd/shared";
import {
  clampConfidenceThreshold,
  clampPollInterval,
  EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
  EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
} from "../email-triage/constants";
import type {
  ApplyGtdUpdateInput,
  CreateReviewInput,
  PersistMessageBatchInput,
  PersistMessageBatchResult,
} from "../email-triage/sync-engine";

export class EmailTriageMemoryStore {
  globalSettings: EmailTriageGlobalSettings = defaultEmailTriageGlobalSettings();
  accounts = new Map<string, EmailTriageAccount>();
  conversations = new Map<string, EmailTriageConversation>();
  messages = new Map<string, EmailTriageMessage>();
  attempts = new Map<string, EmailTriageClassificationAttempt>();
  reviews = new Map<string, EmailTriageReview>();
  evaluations = new Map<string, EmailTriageEvaluation>();
  effects = new Map<string, EmailTriageDesiredEffect>();
  auditEvents = new Map<string, EmailTriageAuditEvent>();

  constructor(
    private readonly taskAccess: {
      getTaskByExternalId(externalId: string): Task | undefined;
      createTask(input: Parameters<typeof createTaskFromInput>[0]): Task;
      saveTask(task: Task): Task;
      persistEvents(events: ReturnType<typeof buildLifecycleEvents>): void;
      getTaskById(id: string): Task | undefined;
    },
  ) {}

  getGlobalSettings(): EmailTriageGlobalSettings {
    return { ...this.globalSettings };
  }

  saveGlobalSettings(settings: EmailTriageGlobalSettings): void {
    this.globalSettings = {
      ...settings,
      pollIntervalMinutes: clampPollInterval(settings.pollIntervalMinutes),
      relevantThreshold: clampConfidenceThreshold(
        settings.relevantThreshold,
        EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
      ),
      ignoreThreshold: clampConfidenceThreshold(
        settings.ignoreThreshold,
        EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
      ),
    };
  }

  listAccounts(): EmailTriageAccount[] {
    return [...this.accounts.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  getAccount(accountId: string): EmailTriageAccount | null {
    return this.accounts.get(accountId) ?? null;
  }

  saveAccount(account: EmailTriageAccount): EmailTriageAccount {
    this.accounts.set(account.id, { ...account, syncState: { ...account.syncState } });
    return this.getAccount(account.id)!;
  }

  deleteAccount(accountId: string): void {
    this.accounts.delete(accountId);
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.accountId === accountId) {
        this.conversations.delete(conversation.id);
      }
    }
    for (const message of [...this.messages.values()]) {
      if (message.accountId === accountId) {
        this.messages.delete(message.id);
      }
    }
    for (const review of [...this.reviews.values()]) {
      if (review.accountId === accountId) {
        this.reviews.delete(review.id);
      }
    }
    for (const effect of [...this.effects.values()]) {
      if (effect.accountId === accountId) {
        this.effects.delete(effect.id);
      }
    }
    for (const event of [...this.auditEvents.values()]) {
      if (event.accountId === accountId) {
        this.auditEvents.delete(event.id);
      }
    }
  }

  upsertConversation(
    accountId: string,
    conversationKey: string,
    patch: Partial<EmailTriageConversation>,
  ): EmailTriageConversation {
    const existing = [...this.conversations.values()].find(
      (conversation) =>
        conversation.accountId === accountId && conversation.conversationKey === conversationKey,
    );
    const timestamp = nowIso();
    if (existing) {
      const updated: EmailTriageConversation = {
        ...existing,
        ...patch,
        updatedAt: timestamp,
      };
      this.conversations.set(existing.id, updated);
      return updated;
    }
    const created: EmailTriageConversation = {
      id: createEntityId("email-conversation"),
      accountId,
      conversationKey,
      decisionVersion: patch.decisionVersion ?? 0,
      routingState: patch.routingState ?? "pending",
      taskId: patch.taskId ?? null,
      lastGeneratedTitle: patch.lastGeneratedTitle ?? null,
      managedNotesRevision: patch.managedNotesRevision ?? 0,
      managedNotesHash: patch.managedNotesHash ?? null,
      sourceUrl: patch.sourceUrl ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.conversations.set(created.id, created);
    return created;
  }

  getConversationByKey(accountId: string, conversationKey: string): EmailTriageConversation | null {
    return (
      [...this.conversations.values()].find(
        (conversation) =>
          conversation.accountId === accountId && conversation.conversationKey === conversationKey,
      ) ?? null
    );
  }

  getConversation(conversationId: string): EmailTriageConversation | null {
    return this.conversations.get(conversationId) ?? null;
  }

  updateAccountSyncState(
    accountId: string,
    syncState: Record<string, unknown>,
    patch: Partial<EmailTriageAccount> = {},
  ): EmailTriageAccount {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const updated: EmailTriageAccount = {
      ...account,
      ...patch,
      syncState: { ...syncState },
      updatedAt: nowIso(),
    };
    this.accounts.set(accountId, updated);
    return updated;
  }

  persistMessageBatch(input: PersistMessageBatchInput): PersistMessageBatchResult {
    const conversations: EmailTriageConversation[] = [];
    for (const item of input.messages) {
      const conversation = this.getConversationByKey(
        input.accountId,
        item.transient.conversationKey,
      );
      if (!conversation) {
        throw new Error(
          `Conversation not found for key ${item.transient.conversationKey} on account ${input.accountId}`,
        );
      }
      const existingMessage = [...this.messages.values()].find(
        (message) =>
          message.accountId === input.accountId &&
          message.providerMessageId === item.transient.providerMessageId,
      );
      const message: EmailTriageMessage = existingMessage
        ? {
            ...existingMessage,
            summary: item.summary,
            routingDecision: item.routedDecision,
            subject: item.transient.subject,
            sender: item.transient.sender,
          }
        : {
            id: createEntityId("email-message"),
            accountId: input.accountId,
            conversationId: conversation.id,
            providerMessageId: item.transient.providerMessageId,
            receivedAt: item.transient.receivedAt,
            subject: item.transient.subject,
            sender: item.transient.sender,
            summary: item.summary,
            routingDecision: item.routedDecision,
            createdAt: nowIso(),
          };
      this.messages.set(message.id, message);
      const attempt: EmailTriageClassificationAttempt = {
        id: item.attempt.id,
        messageId: message.id,
        model: item.attempt.model,
        promptVersion: item.attempt.promptVersion,
        schemaVersion: item.attempt.schemaVersion,
        decision: item.attempt.decision,
        relevance: item.attempt.relevance,
        ignoreReason: item.attempt.ignoreReason,
        confidence: item.attempt.confidence,
        summary: item.attempt.summary,
        rationale: item.attempt.rationale,
        suggestedTaskTitle: item.attempt.suggestedTaskTitle,
        rawValid: item.attempt.rawValid,
        reviewReasons: [...item.attempt.reviewReasons],
        createdAt: nowIso(),
      };
      this.attempts.set(attempt.id, attempt);
      conversations.push(conversation);
    }
    return { conversations };
  }

  getMessageByProviderId(accountId: string, providerMessageId: string): EmailTriageMessage | null {
    return (
      [...this.messages.values()].find(
        (message) =>
          message.accountId === accountId && message.providerMessageId === providerMessageId,
      ) ?? null
    );
  }

  dismissPendingReviews(conversationId: string): void {
    for (const review of this.reviews.values()) {
      if (review.conversationId === conversationId && review.status === "pending") {
        this.reviews.set(review.id, { ...review, status: "dismissed" });
      }
    }
  }

  listPendingEffects(conversationId: string): EmailTriageDesiredEffect[] {
    return [...this.effects.values()].filter(
      (effect) =>
        effect.conversationId === conversationId &&
        (effect.status === "pending" || effect.status === "failed"),
    );
  }

  listPendingEffectsForAccount(accountId: string): EmailTriageDesiredEffect[] {
    return [...this.effects.values()].filter(
      (effect) =>
        effect.accountId === accountId &&
        (effect.status === "pending" || effect.status === "failed"),
    );
  }

  saveDesiredEffect(effect: EmailTriageDesiredEffect): EmailTriageDesiredEffect {
    const existing = [...this.effects.values()].find((item) => item.dedupeKey === effect.dedupeKey);
    const stored = { ...effect, id: existing?.id ?? effect.id };
    this.effects.set(stored.id, stored);
    if (existing && existing.id !== stored.id) {
      this.effects.delete(existing.id);
    }
    return { ...stored };
  }

  getTaskByExternalId(externalId: string): Task | null {
    const task = this.taskAccess.getTaskByExternalId(externalId);
    return task ? cloneTask(task) : null;
  }

  applyGtdUpdate(input: ApplyGtdUpdateInput): Task | null {
    const existing = this.taskAccess.getTaskByExternalId(input.externalId);
    if (input.plan.createNew) {
      const created = this.taskAccess.createTask({
        title: input.plan.title,
        notes: input.plan.notes,
        bucket: "inbox",
        source: "email_triage",
        sourceExternalId: input.externalId,
        sourceUrl: input.plan.sourceUrl,
      });
      this.upsertConversation(input.conversation.accountId, input.conversation.conversationKey, {
        taskId: created.id,
      });
      return cloneTask(created);
    }
    if (!existing) {
      return null;
    }
    const previous = cloneTask(existing);
    let next: Task = {
      ...existing,
      title: input.plan.title,
      notes: input.plan.notes,
      sourceUrl: input.plan.sourceUrl,
      updatedAt: nowIso(),
    };
    if (input.plan.reopen) {
      next = {
        ...next,
        status: "active",
        bucket: "inbox",
        completedAt: null,
      };
    }
    if (input.plan.cancelExisting) {
      next = {
        ...next,
        status: "cancelled",
        updatedAt: nowIso(),
      };
    }
    const saved = this.taskAccess.saveTask(next);
    this.taskAccess.persistEvents(buildLifecycleEvents(previous, saved));
    this.upsertConversation(input.conversation.accountId, input.conversation.conversationKey, {
      taskId: saved.id,
    });
    return cloneTask(saved);
  }

  createReview(input: CreateReviewInput): EmailTriageReview {
    const existing = [...this.reviews.values()].find(
      (review) =>
        review.conversationId === input.conversationId &&
        review.messageId === input.messageId &&
        review.status === "pending",
    );
    if (existing) {
      return existing;
    }
    const review: EmailTriageReview = {
      id: createEntityId("email-review"),
      accountId: input.accountId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      expectedDecisionVersion: input.expectedDecisionVersion,
      status: "pending",
      reason: input.reason,
      sanitizedPreview: input.preview,
      resolution: null,
      resolvedAt: null,
      createdAt: nowIso(),
    };
    this.reviews.set(review.id, review);
    return review;
  }

  listReviews(status?: EmailTriageReview["status"]): EmailTriageReview[] {
    return [...this.reviews.values()]
      .filter((review) => (status ? review.status === status : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  resolveReview(input: {
    reviewId: string;
    expectedDecisionVersion: number;
    resolution: EmailTriageReview["resolution"];
    ignoreReason?: string | null;
  }): EmailTriageReview {
    const review = this.reviews.get(input.reviewId);
    if (!review) {
      throw new Error("Review not found");
    }
    if (review.status !== "pending") {
      throw new Error("Review not pending");
    }
    if (review.expectedDecisionVersion !== input.expectedDecisionVersion) {
      throw new Error("Review version mismatch");
    }
    const conversation = this.getConversation(review.conversationId);
    if (!conversation || conversation.decisionVersion !== input.expectedDecisionVersion) {
      throw new Error("Conversation version mismatch");
    }
    if (input.resolution === "ignore" && !input.ignoreReason?.trim()) {
      throw new Error("Ignore reason required");
    }
    const updated: EmailTriageReview = {
      ...review,
      status: "resolved",
      resolution: input.resolution,
      reason:
        input.resolution === "ignore" && input.ignoreReason
          ? `${review.reason}|ignoreReason:${input.ignoreReason}`
          : review.reason,
      resolvedAt: nowIso(),
    };
    this.reviews.set(review.id, updated);
    if (input.resolution === "ignore" && input.ignoreReason) {
      const audit: EmailTriageAuditEvent = {
        id: createEntityId("email-audit"),
        accountId: review.accountId,
        conversationId: review.conversationId,
        eventType: "review_resolved_ignore",
        details: { ignoreReason: input.ignoreReason, reviewId: review.id },
        createdAt: nowIso(),
      };
      this.auditEvents.set(audit.id, audit);
    }
    return updated;
  }

  listEvaluations(limit = 20): EmailTriageEvaluation[] {
    return [...this.evaluations.values()]
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt))
      .slice(0, limit);
  }

  saveEvaluation(evaluation: EmailTriageEvaluation): EmailTriageEvaluation {
    this.evaluations.set(evaluation.id, {
      ...evaluation,
      results: { ...evaluation.results, failures: [...evaluation.results.failures] },
    });
    if (!evaluation.passed) {
      this.globalSettings = {
        ...this.globalSettings,
        automationEnabled: false,
      };
    }
    return evaluation;
  }

  listAuditEvents(accountId?: string, limit = 100): EmailTriageAuditEvent[] {
    return [...this.auditEvents.values()]
      .filter((event) => (accountId ? event.accountId === accountId : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  recoverStaleEffects(): number {
    let count = 0;
    for (const effect of this.effects.values()) {
      if (effect.status === "in_progress") {
        this.effects.set(effect.id, { ...effect, status: "failed", updatedAt: nowIso() });
        count += 1;
      }
    }
    return count;
  }

  listMessages(accountId: string, limit = 50): EmailTriageMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.accountId === accountId)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit);
  }

  listClassificationAttempts(messageId: string): EmailTriageClassificationAttempt[] {
    return [...this.attempts.values()].filter((attempt) => attempt.messageId === messageId);
  }
}

export { buildEmailTriageTaskExternalId };
