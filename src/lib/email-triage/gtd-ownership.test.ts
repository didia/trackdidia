import { describe, expect, it } from "vitest";
import {
  buildManagedNotesInnerBody,
  buildManagedNotesSection,
  hashManagedNotesBody,
  parseManagedNotes,
  planGtdOwnershipUpdate,
} from "./gtd-ownership";
import type { EmailTriageConversation } from "../../domain/email-triage";
import type { Task } from "../../domain/types";

const baseConversation = (): EmailTriageConversation => ({
  id: "conv-1",
  accountId: "acct-1",
  conversationKey: "thread-1",
  decisionVersion: 1,
  routingState: "relevant",
  taskId: "task-1",
  lastGeneratedTitle: "Old title",
  managedNotesRevision: 1,
  managedNotesHash: null,
  sourceUrl: "https://example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const baseTask = (): Task => ({
  id: "task-1",
  title: "Old title",
  notes: "",
  status: "active",
  bucket: "next_action",
  contextIds: [],
  projectId: null,
  parentTaskId: null,
  scheduledFor: null,
  deadline: null,
  recurringTemplateId: null,
  recurrenceDueDate: null,
  isRecurringInstance: false,
  completedAt: null,
  recurrenceGroupId: null,
  pendingPastRecurrences: 0,
  plannedOrder: null,
  source: "email_triage",
  sourceExternalId: "email-triage:acct-1:thread-1",
  sourceUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("gtd ownership", () => {
  it("blocks automatic ignore downgrade of relevant conversation", () => {
    const plan = planGtdOwnershipUpdate({
      conversation: baseConversation(),
      existingTask: baseTask(),
      routedDecision: "ignore",
      suggestedTitle: "x",
      summary: "s",
      rationale: "r",
      sourceUrl: "https://example.com",
    });
    expect(plan.reviewRequired).toBe(true);
    expect(plan.reviewReason).toBe("ignore_downgrade_blocked");
  });

  it("reopens completed task without creating duplicate", () => {
    const plan = planGtdOwnershipUpdate({
      conversation: baseConversation(),
      existingTask: { ...baseTask(), status: "completed", completedAt: "2026-01-02T00:00:00.000Z" },
      routedDecision: "relevant",
      suggestedTitle: "New title",
      summary: "s",
      rationale: "r",
      sourceUrl: "https://example.com/2",
    });
    expect(plan.createNew).toBe(false);
    expect(plan.reopen).toBe(true);
  });

  it("routes cancelled linkage to review instead of reopening", () => {
    const plan = planGtdOwnershipUpdate({
      conversation: baseConversation(),
      existingTask: { ...baseTask(), status: "cancelled" },
      routedDecision: "relevant",
      suggestedTitle: "New title",
      summary: "s",
      rationale: "r",
      sourceUrl: "https://example.com/2",
    });
    expect(plan.reviewRequired).toBe(true);
    expect(plan.reviewReason).toBe("corrupt_or_cancelled_linkage");
  });

  it("preserves user-edited title and notes when managed section changed", () => {
    const userNotes = "Notes perso utilisateur";
    const plan = planGtdOwnershipUpdate({
      conversation: {
        ...baseConversation(),
        lastGeneratedTitle: "Old title",
        managedNotesHash: "deadbeef",
      },
      existingTask: {
        ...baseTask(),
        title: "Titre modifié par l'utilisateur",
        notes: userNotes,
      },
      routedDecision: "relevant",
      suggestedTitle: "Generated title",
      summary: "new summary",
      rationale: "new rationale",
      sourceUrl: "https://example.com/3",
    });
    expect(plan.title).toBe("Titre modifié par l'utilisateur");
    expect(plan.notes).toBe(userNotes);
  });

  it("hashes managed notes the same way parse and persist do", () => {
    const inner = buildManagedNotesInnerBody("sum", "rat");
    const stored = hashManagedNotesBody(inner);
    const parsed = parseManagedNotes(buildManagedNotesSection(1, "sum", "rat"));
    expect(parsed.managed?.hash).toBe(stored);
    const plan = planGtdOwnershipUpdate({
      conversation: {
        ...baseConversation(),
        lastGeneratedTitle: "Old title",
        managedNotesHash: stored,
        managedNotesRevision: 1,
      },
      existingTask: {
        ...baseTask(),
        notes: buildManagedNotesSection(1, "sum", "rat"),
      },
      routedDecision: "relevant",
      suggestedTitle: "Old title",
      summary: "new summary",
      rationale: "new rationale",
      sourceUrl: "https://example.com/3",
    });
    expect(plan.notes).toContain("new summary");
  });
});
