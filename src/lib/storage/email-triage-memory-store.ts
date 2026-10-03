import {
  planReviewCreation,
  planReviewResolution,
  planReviewDismissal,
  planGtdTaskWrite,
  type ResolveReviewInput,
} from "../email-triage/review-plans";
import {
  buildEmailTriageTaskExternalId,
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageAuditEvent,
  type EmailTriageAlias,
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
import {
  findLatestMatchingEvaluation,
  prepareEmailTriageGlobalSettingsSave,
} from "../email-triage/mutation-gate";
import type {
  ApplyGtdUpdateInput,
  CreateReviewInput,
  PersistMessageBatchInput,
  PersistMessageBatchResult,
} from "../email-triage/sync-engine";
import type { EmailTriageStore } from "./email-triage-store";

export class EmailTriageMemoryStore implements EmailTriageStore {
  globalSettings: EmailTriageGlobalSettings = defaultEmailTriageGlobalSettings();
  accounts = new Map<string, EmailTriageAccount>();
  conversations = new Map<string, EmailTriageConversation>();
  messages = new Map<string, EmailTriageMessage>();
  attempts = new Map<string, EmailTriageClassificationAttempt>();
  reviews = new Map<string, EmailTriageReview>();
  evaluations = new Map<string, EmailTriageEvaluation>();
  effects = new Map<string, EmailTriageDesiredEffect>();
  auditEvents = new Map<string, EmailTriageAuditEvent>();
  aliases = new Map<string, EmailTriageAlias>();

  constructor(
    private readonly taskAccess: {
      getTaskByExternalId(externalId: string): Task | undefined;
      createTask(input: Parameters<typeof createTaskFromInput>[0]): Task;
      saveTask(task: Task): Task;
      atomic?<T>(work: () => T): T;
      handlesLifecycleEvents?: boolean;
      persistEvents(events: ReturnType<typeof buildLifecycleEvents>): void;
      getTaskById(id: string): Task | undefined;
    },
  ) {}

  private mutationDepth = 0;

  private atomic<T>(work: () => T): T {
    const snapshot = {
      globalSettings: this.globalSettings,
      accounts: new Map(this.accounts),
      conversations: new Map(this.conversations),
      messages: new Map(this.messages),
      attempts: new Map(this.attempts),
      reviews: new Map(this.reviews),
      evaluations: new Map(this.evaluations),
      effects: new Map(this.effects),
      auditEvents: new Map(this.auditEvents),
      aliases: new Map(this.aliases),
    };
    this.mutationDepth += 1;
    try {
      return this.taskAccess.atomic ? this.taskAccess.atomic(work) : work();
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    } finally {
      this.mutationDepth -= 1;
    }
  }

  getGlobalSettings(): EmailTriageGlobalSettings {
    return { ...this.globalSettings };
  }

  saveGlobalSettings(settings: EmailTriageGlobalSettings): void {
    if (!this.mutationDepth) {
      this.atomic(() => this.saveGlobalSettings(settings));
      return;
    }

    const previous = this.getGlobalSettings();
    const latestMatching = this.getLatestMatchingEvaluation(settings);
    const { settings: prepared } = prepareEmailTriageGlobalSettingsSave(
      previous,
      settings,
      latestMatching,
    );
    this.globalSettings = {
      ...prepared,
      pollIntervalMinutes: clampPollInterval(prepared.pollIntervalMinutes),
      relevantThreshold: clampConfidenceThreshold(
        prepared.relevantThreshold,
        EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
      ),
      ignoreThreshold: clampConfidenceThreshold(
        prepared.ignoreThreshold,
        EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
      ),
    };
  }

  getLatestMatchingEvaluation(settings: EmailTriageGlobalSettings): EmailTriageEvaluation | null {
    return findLatestMatchingEvaluation(settings, this.listEvaluations(50));
  }

  listAccounts(): EmailTriageAccount[] {
    return [...this.accounts.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  getAccount(accountId: string): EmailTriageAccount | null {
    return this.accounts.get(accountId) ?? null;
  }

  saveAccount(account: EmailTriageAccount): EmailTriageAccount {
    if (!this.mutationDepth) return this.atomic(() => this.saveAccount(account));

    this.accounts.set(account.id, { ...account, syncState: { ...account.syncState } });
    return this.getAccount(account.id)!;
  }

  deleteAccount(accountId: string): void {
    if (!this.mutationDepth) {
      this.atomic(() => this.deleteAccount(accountId));
      return;
    }

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
    if (!this.mutationDepth)
      return this.atomic(() => this.upsertConversation(accountId, conversationKey, patch));

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
    if (!this.mutationDepth)
      return this.atomic(() => this.updateAccountSyncState(accountId, syncState, patch));

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
    if (!this.mutationDepth) return this.atomic(() => this.persistMessageBatch(input));

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
    if (!this.mutationDepth) {
      this.atomic(() => this.dismissPendingReviews(conversationId));
      return;
    }

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
    if (!this.mutationDepth) return this.atomic(() => this.saveDesiredEffect(effect));

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
    if (!this.mutationDepth) return this.atomic(() => this.applyGtdUpdate(input));

    const existing = this.getTaskByExternalId(input.externalId);
    const write = planGtdTaskWrite(input, existing, nowIso());
    if (write.kind === "none") return null;
    const saved =
      write.kind === "create"
        ? this.taskAccess.createTask(write.input)
        : this.taskAccess.saveTask(write.task);
    if (write.kind === "save" && !this.taskAccess.handlesLifecycleEvents) {
      this.taskAccess.persistEvents(buildLifecycleEvents(write.previous, saved));
    }
    this.upsertConversation(input.conversation.accountId, input.conversation.conversationKey, {
      taskId: saved.id,
    });
    return cloneTask(saved);
  }

  createReview(input: CreateReviewInput): EmailTriageReview {
    if (!this.mutationDepth) return this.atomic(() => this.createReview(input));

    const planned = planReviewCreation(
      [...this.reviews.values()],
      input,
      createEntityId("email-review"),
      nowIso(),
    );
    if (planned.created) this.reviews.set(planned.review.id, planned.review);
    return planned.review;
  }

  listReviews(status?: EmailTriageReview["status"]): EmailTriageReview[] {
    return [...this.reviews.values()]
      .filter((review) => (status ? review.status === status : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  resolveReview(input: ResolveReviewInput): EmailTriageReview {
    if (!this.mutationDepth) return this.atomic(() => this.resolveReview(input));

    const review = this.reviews.get(input.reviewId) ?? null;
    const conversation = review ? this.getConversation(review.conversationId) : null;
    const message = review ? this.getMessageByProviderId(review.accountId, review.messageId) : null;
    const externalId = conversation
      ? buildEmailTriageTaskExternalId(conversation.accountId, conversation.conversationKey)
      : "";
    const existingTask = conversation ? this.getTaskByExternalId(externalId) : null;
    const plan = planReviewResolution({
      review,
      conversation,
      message,
      existingTask,
      input,
      now: nowIso(),
      auditId: createEntityId("email-audit"),
    });
    this.reviews.set(plan.review.id, plan.review);
    if (plan.audit) this.auditEvents.set(plan.audit.id, plan.audit);
    this.dismissPendingReviews(plan.conversation.id);
    this.upsertConversation(plan.conversation.accountId, plan.conversation.conversationKey, {
      decisionVersion: plan.conversation.decisionVersion,
      routingState: plan.conversation.routingState,
    });
    if (message)
      this.messages.set(message.id, { ...message, routingDecision: plan.routingDecision });
    if (plan.gtdUpdate) this.applyGtdUpdate(plan.gtdUpdate);
    return plan.review;
  }

  dismissReview(reviewId: string): EmailTriageReview {
    if (!this.mutationDepth) return this.atomic(() => this.dismissReview(reviewId));

    const review = this.reviews.get(reviewId) ?? null;
    const conversation = review ? this.getConversation(review.conversationId) : null;
    const plan = planReviewDismissal(review, conversation, [...this.reviews.values()], nowIso());
    for (const updated of plan.reviews) {
      this.reviews.set(updated.id, updated);
      const message = this.getMessageByProviderId(updated.accountId, updated.messageId);
      if (message) this.messages.set(message.id, { ...message, routingDecision: "ignore" });
    }
    this.upsertConversation(plan.conversation.accountId, plan.conversation.conversationKey, {
      decisionVersion: plan.conversation.decisionVersion,
      routingState: plan.conversation.routingState,
    });
    return plan.review;
  }

  listEvaluations(limit = 20): EmailTriageEvaluation[] {
    return [...this.evaluations.values()]
      .sort((left, right) => right.evaluatedAt.localeCompare(left.evaluatedAt))
      .slice(0, limit);
  }

  saveEvaluation(evaluation: EmailTriageEvaluation): EmailTriageEvaluation {
    if (!this.mutationDepth) return this.atomic(() => this.saveEvaluation(evaluation));

    this.evaluations.set(evaluation.id, {
      ...evaluation,
      results: { ...evaluation.results, failures: [...evaluation.results.failures] },
    });
    if (!evaluation.passed) {
      this.saveGlobalSettings({
        ...this.globalSettings,
        automationEnabled: false,
        updatedAt: nowIso(),
      });
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
    if (!this.mutationDepth) return this.atomic(() => this.recoverStaleEffects());

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

  findConversationKeyByMessageId(accountId: string, messageIdHeader: string): string | null {
    for (const alias of this.aliases.values()) {
      if (alias.messageIdHeader !== messageIdHeader) {
        continue;
      }
      const conversation = this.conversations.get(alias.conversationId);
      if (conversation?.accountId === accountId) {
        return conversation.conversationKey;
      }
    }
    return null;
  }

  saveAlias(accountId: string, conversationKey: string, messageIdHeader: string): void {
    if (!this.mutationDepth) {
      this.atomic(() => this.saveAlias(accountId, conversationKey, messageIdHeader));
      return;
    }

    let conversation = this.getConversationByKey(accountId, conversationKey);
    if (!conversation) {
      conversation = this.upsertConversation(accountId, conversationKey, {
        decisionVersion: 0,
        routingState: "pending",
        taskId: null,
        lastGeneratedTitle: null,
        managedNotesRevision: 0,
        managedNotesHash: null,
        sourceUrl: null,
      });
    }
    const existing = [...this.aliases.values()].find(
      (alias) =>
        alias.conversationId === conversation!.id && alias.messageIdHeader === messageIdHeader,
    );
    if (existing) {
      return;
    }
    const alias: EmailTriageAlias = {
      id: createEntityId("email-alias"),
      conversationId: conversation.id,
      messageIdHeader,
      createdAt: nowIso(),
    };
    this.aliases.set(alias.id, alias);
  }
}

export { buildEmailTriageTaskExternalId };
