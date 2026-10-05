import {
  buildEmailTriageTaskExternalId,
  type EmailTriageAuditEvent,
  type EmailTriageConversation,
  type EmailTriageMessage,
  type EmailTriageReview,
} from "../../domain/email-triage";
import type { Task } from "../../domain/types";
import { cloneTask } from "../gtd/shared";
import type { createTaskFromInput } from "../gtd/engine";
import { planGtdOwnershipUpdate } from "./gtd-ownership";
import type { ApplyGtdUpdateInput, CreateReviewInput } from "./sync-engine";

export interface ResolveReviewInput {
  reviewId: string;
  expectedDecisionVersion: number;
  resolution: EmailTriageReview["resolution"];
  ignoreReason?: string | null;
}
export const planReviewCreation = (
  existing: EmailTriageReview[],
  input: CreateReviewInput,
  id: string,
  now: string,
) => {
  const matching = existing.filter(
    (review) =>
      review.conversationId === input.conversationId && review.messageId === input.messageId,
  );
  const reuse =
    matching.find((review) => review.status === "pending") ??
    matching.find((review) => review.status === "resolved");
  const review: EmailTriageReview = reuse ?? {
    id,
    accountId: input.accountId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    expectedDecisionVersion: input.expectedDecisionVersion,
    status: "pending",
    reason: input.reason,
    sanitizedPreview: input.preview,
    resolution: null,
    resolvedAt: null,
    createdAt: now,
  };
  return { review, created: !reuse };
};

export const planReviewResolution = (options: {
  review: EmailTriageReview | null;
  conversation: EmailTriageConversation | null;
  message: EmailTriageMessage | null;
  existingTask: Task | null;
  input: ResolveReviewInput;
  now: string;
  auditId: string;
}) => {
  const { review, conversation, message, existingTask, input, now, auditId } = options;
  if (!review) throw new Error("Review not found");
  if (review.status !== "pending") throw new Error("Review not pending");
  if (review.expectedDecisionVersion !== input.expectedDecisionVersion)
    throw new Error("Review version mismatch");
  if (!conversation || conversation.decisionVersion !== input.expectedDecisionVersion)
    throw new Error("Conversation version mismatch");
  if (input.resolution === "ignore" && !input.ignoreReason?.trim())
    throw new Error("Ignore reason required");
  const updatedReview: EmailTriageReview = {
    ...review,
    status: "resolved",
    resolution: input.resolution,
    resolvedAt: now,
    reason:
      input.resolution === "ignore" && input.ignoreReason
        ? `${review.reason}|ignoreReason:${input.ignoreReason}`
        : review.reason,
  };
  const routingDecision: "ignore" | "relevant" =
    input.resolution === "ignore" ? "ignore" : "relevant";
  const nextConversation: EmailTriageConversation = {
    ...conversation,
    decisionVersion: conversation.decisionVersion + 1,
    routingState: input.resolution === "ignore" ? "ignored" : "relevant",
    updatedAt: now,
  };
  const audit: EmailTriageAuditEvent | null =
    input.resolution === "ignore" && input.ignoreReason
      ? {
          id: auditId,
          accountId: review.accountId,
          conversationId: review.conversationId,
          eventType: "review_resolved_ignore",
          details: { ignoreReason: input.ignoreReason, reviewId: review.id },
          createdAt: now,
        }
      : null;
  const externalId = buildEmailTriageTaskExternalId(
    conversation.accountId,
    conversation.conversationKey,
  );
  const ownership =
    routingDecision === "relevant"
      ? planGtdOwnershipUpdate({
          conversation: nextConversation,
          existingTask,
          routedDecision: "relevant",
          suggestedTitle: nextConversation.lastGeneratedTitle ?? message?.subject ?? "Email",
          summary: message?.summary ?? "",
          rationale: "",
          sourceUrl: nextConversation.sourceUrl,
        })
      : null;
  const gtdUpdate: ApplyGtdUpdateInput | null =
    ownership && !ownership.reviewRequired
      ? {
          externalId,
          plan: ownership,
          conversation: nextConversation,
          accountId: conversation.accountId,
        }
      : null;
  return {
    review: updatedReview,
    conversation: nextConversation,
    audit,
    routingDecision,
    gtdUpdate,
  };
};

export const planReviewDismissal = (
  review: EmailTriageReview | null,
  conversation: EmailTriageConversation | null,
  pending: EmailTriageReview[],
  now: string,
) => {
  if (!review) throw new Error("Review not found");
  if (review.status !== "pending") throw new Error("Review not pending");
  if (!conversation) throw new Error("Conversation not found");
  if (conversation.decisionVersion !== review.expectedDecisionVersion)
    throw new Error("Conversation version mismatch");
  const reviews = pending
    .filter((item) => item.conversationId === conversation.id && item.status === "pending")
    .map((item): EmailTriageReview => ({ ...item, status: "dismissed", resolvedAt: now }));
  return {
    review: reviews.find((item) => item.id === review.id) ?? review,
    reviews,
    conversation: {
      ...conversation,
      decisionVersion: conversation.decisionVersion + 1,
      routingState: "dismissed" as const,
      updatedAt: now,
    },
  };
};

export type GtdTaskWrite =
  | { kind: "create"; input: Parameters<typeof createTaskFromInput>[0] }
  | { kind: "save"; task: Task; previous: Task }
  | { kind: "none" };
export const planGtdTaskWrite = (
  input: ApplyGtdUpdateInput,
  existing: Task | null,
  now: string,
): GtdTaskWrite => {
  if (input.plan.createNew)
    return {
      kind: "create",
      input: {
        title: input.plan.title,
        notes: input.plan.notes,
        bucket: "inbox",
        source: "email_triage",
        sourceExternalId: input.externalId,
        sourceUrl: input.plan.sourceUrl,
      },
    };
  if (!existing) return { kind: "none" };
  let task: Task = {
    ...cloneTask(existing),
    title: input.plan.title,
    notes: input.plan.notes,
    sourceUrl: input.plan.sourceUrl,
    updatedAt: now,
  };
  if (input.plan.reopen) task = { ...task, status: "active", bucket: "inbox", completedAt: null };
  if (input.plan.cancelExisting) task = { ...task, status: "cancelled" };
  return { kind: "save", task, previous: cloneTask(existing) };
};
