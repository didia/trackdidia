import type {
  EmailTriageAccount,
  EmailTriageAuditEvent,
  EmailTriageClassificationAttempt,
  EmailTriageConversation,
  EmailTriageDesiredEffect,
  EmailTriageEvaluation,
  EmailTriageGlobalSettings,
  EmailTriageMessage,
  EmailTriageReview,
} from "../../domain/email-triage";
import type { Task } from "../../domain/types";
import type {
  ApplyGtdUpdateInput,
  CreateReviewInput,
  PersistMessageBatchInput,
  PersistMessageBatchResult,
} from "../email-triage/sync-engine";

/** Memory methods are synchronous; SQLite methods perform asynchronous I/O. */
type StoreResult<T> = T | Promise<T>;

export interface EmailTriageStore {
  getGlobalSettings(): StoreResult<EmailTriageGlobalSettings>;
  saveGlobalSettings(settings: EmailTriageGlobalSettings): StoreResult<void>;
  getLatestMatchingEvaluation(
    settings: EmailTriageGlobalSettings,
  ): StoreResult<EmailTriageEvaluation | null>;
  listAccounts(): StoreResult<EmailTriageAccount[]>;
  getAccount(accountId: string): StoreResult<EmailTriageAccount | null>;
  saveAccount(account: EmailTriageAccount): StoreResult<EmailTriageAccount>;
  deleteAccount(accountId: string): StoreResult<void>;
  upsertConversation(
    accountId: string,
    conversationKey: string,
    patch: Partial<EmailTriageConversation>,
  ): StoreResult<EmailTriageConversation>;
  getConversationByKey(
    accountId: string,
    conversationKey: string,
  ): StoreResult<EmailTriageConversation | null>;
  getConversation(conversationId: string): StoreResult<EmailTriageConversation | null>;
  updateAccountSyncState(
    accountId: string,
    syncState: Record<string, unknown>,
    patch?: Partial<EmailTriageAccount>,
  ): StoreResult<EmailTriageAccount>;
  persistMessageBatch(input: PersistMessageBatchInput): StoreResult<PersistMessageBatchResult>;
  getMessageByProviderId(
    accountId: string,
    providerMessageId: string,
  ): StoreResult<EmailTriageMessage | null>;
  dismissPendingReviews(conversationId: string): StoreResult<void>;
  listPendingEffects(conversationId: string): StoreResult<EmailTriageDesiredEffect[]>;
  listPendingEffectsForAccount(accountId: string): StoreResult<EmailTriageDesiredEffect[]>;
  saveDesiredEffect(effect: EmailTriageDesiredEffect): StoreResult<EmailTriageDesiredEffect>;
  getTaskByExternalId(externalId: string): StoreResult<Task | null>;
  applyGtdUpdate(input: ApplyGtdUpdateInput): StoreResult<Task | null>;
  createReview(input: CreateReviewInput): StoreResult<EmailTriageReview>;
  listReviews(status?: EmailTriageReview["status"]): StoreResult<EmailTriageReview[]>;
  resolveReview(input: {
    reviewId: string;
    expectedDecisionVersion: number;
    resolution: EmailTriageReview["resolution"];
    ignoreReason?: string | null;
  }): StoreResult<EmailTriageReview>;
  dismissReview(reviewId: string): StoreResult<EmailTriageReview>;
  listEvaluations(limit?: number): StoreResult<EmailTriageEvaluation[]>;
  saveEvaluation(evaluation: EmailTriageEvaluation): StoreResult<EmailTriageEvaluation>;
  listAuditEvents(accountId?: string, limit?: number): StoreResult<EmailTriageAuditEvent[]>;
  recoverStaleEffects(): StoreResult<number>;
  listMessages(accountId: string, limit?: number): StoreResult<EmailTriageMessage[]>;
  listClassificationAttempts(messageId: string): StoreResult<EmailTriageClassificationAttempt[]>;
  findConversationKeyByMessageId(
    accountId: string,
    messageIdHeader: string,
  ): StoreResult<string | null>;
  saveAlias(accountId: string, conversationKey: string, messageIdHeader: string): StoreResult<void>;
}
