import type { Task } from "../../domain/types";
import type { EmailTriageConversation } from "../../domain/email-triage";
import { EMAIL_TRIAGE_MANAGED_NOTES_BEGIN, EMAIL_TRIAGE_MANAGED_NOTES_END } from "./constants";

export interface ManagedNotesState {
  revision: number;
  hash: string;
  body: string;
}

const hashString = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
};

export const buildManagedNotesSection = (
  revision: number,
  summary: string,
  rationale: string,
): string => {
  const body = [`Summary: ${summary}`, `Rationale: ${rationale}`].join("\n");
  return [
    `${EMAIL_TRIAGE_MANAGED_NOTES_BEGIN}${revision} -->`,
    body,
    EMAIL_TRIAGE_MANAGED_NOTES_END,
  ].join("\n");
};

export const parseManagedNotes = (
  notes: string,
): {
  userNotes: string;
  managed: ManagedNotesState | null;
} => {
  const beginIndex = notes.indexOf(EMAIL_TRIAGE_MANAGED_NOTES_BEGIN);
  if (beginIndex < 0) {
    return { userNotes: notes, managed: null };
  }
  const endIndex = notes.indexOf(EMAIL_TRIAGE_MANAGED_NOTES_END);
  if (endIndex < 0) {
    return { userNotes: notes, managed: null };
  }
  const header = notes.slice(beginIndex, notes.indexOf("-->", beginIndex) + 3);
  const revisionMatch = header.match(/v(\d+)/);
  const revision = revisionMatch ? Number(revisionMatch[1]) : 0;
  const bodyStart = notes.indexOf("-->", beginIndex) + 3;
  const body = notes.slice(bodyStart, endIndex).trim();
  const userNotes =
    `${notes.slice(0, beginIndex)}${notes.slice(endIndex + EMAIL_TRIAGE_MANAGED_NOTES_END.length)}`.trim();
  return {
    userNotes,
    managed: {
      revision,
      hash: hashString(body),
      body,
    },
  };
};

export interface GtdUpdatePlan {
  title: string;
  notes: string;
  sourceUrl: string | null;
  reopen: boolean;
  createNew: boolean;
  cancelExisting: boolean;
  reviewRequired: boolean;
  reviewReason: string | null;
}

export interface GtdOwnershipInput {
  conversation: EmailTriageConversation;
  existingTask: Task | null;
  routedDecision: "relevant" | "ignore" | "review";
  suggestedTitle: string;
  summary: string;
  rationale: string;
  sourceUrl: string | null;
  manualIgnoreReason?: string | null;
  userConfirmedCancel?: boolean;
}

export const planGtdOwnershipUpdate = (input: GtdOwnershipInput): GtdUpdatePlan => {
  const {
    conversation,
    existingTask,
    routedDecision,
    suggestedTitle,
    summary,
    rationale,
    sourceUrl,
    manualIgnoreReason,
    userConfirmedCancel,
  } = input;

  if (routedDecision === "review") {
    return {
      title: existingTask?.title ?? suggestedTitle,
      notes: existingTask?.notes ?? "",
      sourceUrl,
      reopen: false,
      createNew: false,
      cancelExisting: false,
      reviewRequired: true,
      reviewReason: "classification_review",
    };
  }

  if (manualIgnoreReason) {
    if (existingTask && existingTask.status === "active" && !userConfirmedCancel) {
      return {
        title: existingTask.title,
        notes: existingTask.notes,
        sourceUrl,
        reopen: false,
        createNew: false,
        cancelExisting: false,
        reviewRequired: true,
        reviewReason: "manual_ignore_requires_confirmation",
      };
    }
    return {
      title: existingTask?.title ?? suggestedTitle,
      notes: existingTask?.notes ?? "",
      sourceUrl,
      reopen: false,
      createNew: false,
      cancelExisting: Boolean(existingTask && existingTask.status === "active"),
      reviewRequired: false,
      reviewReason: null,
    };
  }

  if (routedDecision === "ignore") {
    if (conversation.routingState === "relevant") {
      return {
        title: existingTask?.title ?? suggestedTitle,
        notes: existingTask?.notes ?? "",
        sourceUrl,
        reopen: false,
        createNew: false,
        cancelExisting: false,
        reviewRequired: true,
        reviewReason: "ignore_downgrade_blocked",
      };
    }
    return {
      title: existingTask?.title ?? suggestedTitle,
      notes: existingTask?.notes ?? "",
      sourceUrl,
      reopen: false,
      createNew: false,
      cancelExisting: false,
      reviewRequired: false,
      reviewReason: null,
    };
  }

  if (!existingTask) {
    const notes = buildManagedNotesSection(1, summary, rationale);
    return {
      title: suggestedTitle,
      notes,
      sourceUrl,
      reopen: false,
      createNew: true,
      cancelExisting: false,
      reviewRequired: false,
      reviewReason: null,
    };
  }

  if (existingTask.status === "cancelled" || !existingTask.id) {
    return {
      title: existingTask.title,
      notes: existingTask.notes,
      sourceUrl,
      reopen: false,
      createNew: false,
      cancelExisting: false,
      reviewRequired: true,
      reviewReason: "corrupt_or_cancelled_linkage",
    };
  }

  const parsedNotes = parseManagedNotes(existingTask.notes);
  const nextRevision = (conversation.managedNotesRevision || 0) + 1;
  const managedUnchanged =
    conversation.managedNotesHash !== null &&
    parsedNotes.managed?.hash === conversation.managedNotesHash;
  const nextNotes = managedUnchanged
    ? `${parsedNotes.userNotes ? `${parsedNotes.userNotes}\n\n` : ""}${buildManagedNotesSection(nextRevision, summary, rationale)}`.trim()
    : existingTask.notes;

  const titleUnchanged =
    conversation.lastGeneratedTitle === null ||
    existingTask.title === conversation.lastGeneratedTitle;
  const nextTitle = titleUnchanged ? suggestedTitle : existingTask.title;

  const reopen = existingTask.status === "completed";

  return {
    title: nextTitle,
    notes: nextNotes,
    sourceUrl,
    reopen,
    createNew: false,
    cancelExisting: false,
    reviewRequired: false,
    reviewReason: null,
  };
};

export const hashManagedNotesBody = (body: string): string => {
  let hash = 0;
  for (let index = 0; index < body.length; index += 1) {
    hash = (hash * 31 + body.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
};
