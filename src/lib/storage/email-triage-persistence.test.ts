import { describe, expect, it } from "vitest";
import type { EmailTriageClassificationAttempt } from "../../domain/email-triage";
import { createTaskFromInput } from "../gtd/engine";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import type { Database } from "./email-triage-sqlite-db";
import { EmailTriageSqliteStore } from "./email-triage-sqlite-store";
import type { PersistMessageBatchInput } from "../email-triage/sync-engine";

const sampleBatch = (accountId: string, conversationKey: string): PersistMessageBatchInput => ({
  accountId,
  messages: [
    {
      transient: {
        providerMessageId: "gmail-msg-1",
        conversationKey,
        messageIdHeader: "<msg@example.com>",
        references: [],
        inReplyTo: null,
        subject: "Secret subject",
        sender: "sender@example.com",
        recipients: ["me@example.com"],
        receivedAt: "2026-01-15T10:00:00.000Z",
        bodyText: "RAW MIME BODY MUST NOT PERSIST <script>alert(1)</script>",
        sourceUrl: "https://mail.example/m1",
        inInbox: true,
      },
      routedDecision: "review",
      summary: "Sanitized summary",
      attempt: {
        id: "attempt-gmail-msg-1",
        model: "test-model",
        promptVersion: "1",
        schemaVersion: "1",
        decision: "review",
        relevance: null,
        ignoreReason: null,
        confidence: 0.42,
        summary: "Sanitized summary",
        rationale: "Needs review",
        suggestedTaskTitle: "Review mail",
        rawValid: true,
        reviewReasons: ["prompt_injection"],
      },
    },
  ],
});

const createMemoryStore = () =>
  new EmailTriageMemoryStore({
    getTaskByExternalId: () => undefined,
    createTask: (input) => createTaskFromInput(input),
    saveTask: (task) => task,
    persistEvents: () => undefined,
    getTaskById: () => undefined,
  });

class FakeClassificationDb implements Database {
  messages: Array<Record<string, unknown>> = [];
  attempts: Array<Record<string, unknown>> = [];

  async execute(query: string, bindValues: unknown[] = []) {
    if (query.includes("INSERT OR IGNORE INTO email_triage_messages")) {
      this.messages.push({
        id: bindValues[0],
        account_id: bindValues[1],
        conversation_id: bindValues[2],
        provider_message_id: bindValues[3],
        subject: bindValues[6],
        sender: bindValues[7],
        summary: bindValues[8],
      });
    }
    if (query.includes("INSERT INTO email_triage_classification_attempts")) {
      this.attempts.push({
        id: bindValues[0],
        message_id: bindValues[1],
        model: bindValues[2],
        prompt_version: bindValues[3],
        schema_version: bindValues[4],
        decision: bindValues[5],
        relevance: bindValues[6],
        ignore_reason: bindValues[7],
        confidence: bindValues[8],
        summary: bindValues[9],
        rationale: bindValues[10],
        suggested_task_title: bindValues[11],
        raw_valid: bindValues[12],
        review_reasons_json: bindValues[13],
        created_at: bindValues[14],
      });
    }
    return { rowsAffected: 1 };
  }

  async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
    if (query.includes("FROM email_triage_conversations WHERE account_id")) {
      return [
        {
          id: "conv-1",
          account_id: bindValues[0],
          conversation_key: bindValues[1],
          decision_version: 1,
          routing_state: "review",
          task_id: null,
          last_generated_title: null,
          managed_notes_revision: 0,
          managed_notes_hash: null,
          source_url: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ] as T;
    }
    if (query.includes("FROM email_triage_classification_attempts")) {
      const messageId = bindValues[0];
      return this.attempts
        .filter((attempt) => attempt.message_id === messageId)
        .map((attempt) => ({
          id: attempt.id,
          message_id: attempt.message_id,
          model: attempt.model,
          prompt_version: attempt.prompt_version,
          schema_version: attempt.schema_version,
          decision: attempt.decision,
          relevance: attempt.relevance,
          ignore_reason: attempt.ignore_reason,
          confidence: attempt.confidence,
          summary: attempt.summary,
          rationale: attempt.rationale,
          suggested_task_title: attempt.suggested_task_title,
          raw_valid: attempt.raw_valid,
          review_reasons_json: attempt.review_reasons_json,
          created_at: attempt.created_at,
        })) as T;
    }
    return [] as T;
  }
}

describe("email triage persistence", () => {
  it("persists classification attempts without raw bodyText or MIME in memory", async () => {
    const store = createMemoryStore();
    store.upsertConversation("acct-1", "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    const result = store.persistMessageBatch(sampleBatch("acct-1", "thread-1"));
    expect(result.conversations).toHaveLength(1);
    const messages = store.listMessages("acct-1");
    expect(messages[0]?.subject).toBe("Secret subject");
    const attempts = store.listClassificationAttempts(messages[0]!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.summary).toBe("Sanitized summary");
    const serialized = JSON.stringify({ messages, attempts });
    expect(serialized).not.toContain("RAW MIME BODY");
    expect(serialized).not.toContain("bodyText");
    expect(serialized).not.toMatch(/<script/i);
  });

  it("persists and lists the same classification attempt shape in sqlite", async () => {
    const fakeDb = new FakeClassificationDb();
    const sqliteStore = new EmailTriageSqliteStore(async () => fakeDb, {
      getTaskByExternalId: async () => null,
      createTask: async (input) => createTaskFromInput(input),
      saveTask: async (task) => task,
      persistEvents: async () => undefined,
    });
    await sqliteStore.upsertConversation("acct-1", "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    await sqliteStore.persistMessageBatch(sampleBatch("acct-1", "thread-1"));
    const messageId = fakeDb.messages[0]?.id as string;
    const attempts = await sqliteStore.listClassificationAttempts(messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      model: "test-model",
      decision: "review",
      summary: "Sanitized summary",
      reviewReasons: ["prompt_injection"],
    } satisfies Partial<EmailTriageClassificationAttempt>);
    expect(JSON.stringify(attempts)).not.toContain("RAW MIME BODY");
  });

  it("rejects stale conversation version on review resolve", () => {
    const store = createMemoryStore();
    const conversation = store.upsertConversation("acct-1", "thread-1", {
      decisionVersion: 2,
      routingState: "review",
    });
    const review = store.createReview({
      accountId: "acct-1",
      conversationId: conversation.id,
      messageId: "gmail-msg-1",
      expectedDecisionVersion: 1,
      reason: "test",
      preview: {
        subject: "s",
        sender: "a@b.com",
        receivedAt: "2026-01-01T00:00:00.000Z",
        bodyExcerpt: "excerpt",
        sourceUrl: null,
      },
    });
    expect(() =>
      store.resolveReview({
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "relevant",
      }),
    ).toThrow(/Conversation version mismatch/);
  });

  it("requires ignore reason when resolving ignore", () => {
    const store = createMemoryStore();
    const conversation = store.upsertConversation("acct-1", "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    const review = store.createReview({
      accountId: "acct-1",
      conversationId: conversation.id,
      messageId: "gmail-msg-1",
      expectedDecisionVersion: 1,
      reason: "test",
      preview: {
        subject: "s",
        sender: "a@b.com",
        receivedAt: "2026-01-01T00:00:00.000Z",
        bodyExcerpt: "excerpt",
        sourceUrl: null,
      },
    });
    expect(() =>
      store.resolveReview({
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "ignore",
      }),
    ).toThrow(/Ignore reason required/);
  });
});
