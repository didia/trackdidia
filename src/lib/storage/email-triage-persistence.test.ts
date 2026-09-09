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
    if (query.includes("INSERT INTO email_triage_messages")) {
      const providerMessageId = bindValues[3];
      const existing = this.messages.find(
        (message) => message.provider_message_id === providerMessageId,
      );
      if (existing) {
        existing.subject = bindValues[5];
        existing.sender = bindValues[6];
        existing.summary = bindValues[7];
        existing.routing_decision = bindValues[8];
        return { rowsAffected: 1 };
      }
      this.messages.push({
        id: bindValues[0],
        account_id: bindValues[1],
        conversation_id: bindValues[2],
        provider_message_id: bindValues[3],
        subject: bindValues[5],
        sender: bindValues[6],
        summary: bindValues[7],
        routing_decision: bindValues[8],
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
    if (query.includes("FROM email_triage_messages WHERE account_id")) {
      const accountId = bindValues[0];
      const providerMessageId = bindValues[1];
      return this.messages.filter(
        (message) =>
          message.account_id === accountId && message.provider_message_id === providerMessageId,
      ) as T;
    }
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

  it("reuses the persisted message id when the same provider message is upserted", async () => {
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
    const firstId = fakeDb.messages[0]?.id as string;
    const updated = sampleBatch("acct-1", "thread-1");
    updated.messages[0]!.summary = "Updated summary";
    updated.messages[0]!.attempt.id = "attempt-gmail-msg-1-b";
    await sqliteStore.persistMessageBatch(updated);
    expect(fakeDb.messages).toHaveLength(1);
    expect(fakeDb.messages[0]?.id).toBe(firstId);
    expect(fakeDb.messages[0]?.summary).toBe("Updated summary");
    expect(fakeDb.attempts).toHaveLength(2);
    expect(fakeDb.attempts.every((attempt) => attempt.message_id === firstId)).toBe(true);
  });

  it("does not enable automation when an evaluation passes", () => {
    const store = createMemoryStore();
    store.saveGlobalSettings({
      ...store.getGlobalSettings(),
      automationEnabled: false,
    });
    store.saveEvaluation({
      id: "eval-pass",
      model: "m",
      promptVersion: "1",
      schemaVersion: "1",
      corpusVersion: "1",
      relevantThreshold: 0.8,
      ignoreThreshold: 0.9,
      passed: true,
      results: {
        totalCases: 1,
        validSchemaCount: 1,
        exactRoutingCount: 1,
        safetyViolations: 0,
        failures: [],
      },
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getGlobalSettings().automationEnabled).toBe(false);
  });

  it("turns automation off when an evaluation fails", () => {
    const store = createMemoryStore();
    store.saveGlobalSettings({
      ...store.getGlobalSettings(),
      automationEnabled: true,
    });
    store.saveEvaluation({
      id: "eval-fail",
      model: "m",
      promptVersion: "1",
      schemaVersion: "1",
      corpusVersion: "1",
      relevantThreshold: 0.8,
      ignoreThreshold: 0.9,
      passed: false,
      results: {
        totalCases: 1,
        validSchemaCount: 0,
        exactRoutingCount: 0,
        safetyViolations: 1,
        failures: [{ caseId: "x", reason: "safety_ignore_violation" }],
      },
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getGlobalSettings().automationEnabled).toBe(false);
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

  it("dismisses a review without leaving the conversation pending", () => {
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
        sourceUrl: null,
      },
    });
    store.persistMessageBatch({
      accountId: "acct-1",
      messages: [
        {
          transient: {
            providerMessageId: "gmail-msg-1",
            conversationKey: "thread-1",
            messageIdHeader: "<msg@example.com>",
            references: [],
            inReplyTo: null,
            subject: "s",
            sender: "a@b.com",
            recipients: ["me@example.com"],
            receivedAt: "2026-01-01T00:00:00.000Z",
            bodyText: "body",
            sourceUrl: null,
            inInbox: true,
          },
          routedDecision: "review",
          summary: "summary",
          attempt: {
            id: "attempt-1",
            model: "m",
            promptVersion: "1",
            schemaVersion: "1",
            decision: "review",
            relevance: null,
            ignoreReason: null,
            confidence: 0.5,
            summary: "summary",
            rationale: "r",
            suggestedTaskTitle: "t",
            rawValid: true,
            reviewReasons: ["uncertain"],
          },
        },
      ],
    });
    store.dismissReview(review.id);
    const nextConversation = store.getConversation(conversation.id);
    expect(nextConversation?.routingState).toBe("dismissed");
    expect(nextConversation?.decisionVersion).toBe(2);
    expect(store.getMessageByProviderId("acct-1", "gmail-msg-1")?.routingDecision).toBe("ignore");
    expect(store.listReviews("pending")).toHaveLength(0);
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
