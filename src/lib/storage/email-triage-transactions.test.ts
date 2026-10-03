// @vitest-environment node
import { buildEmailTriageTaskExternalId, type EmailTriageAccount } from "../../domain/email-triage";
import type { PersistMessageBatchInput } from "../email-triage/sync-engine";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "./memory-repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const account: EmailTriageAccount = {
  id: "account",
  provider: "gmail",
  providerAccountId: "me@example.com",
  label: "test",
  maskedAddress: "m***@example.com",
  generation: 1,
  enabled: true,
  mutationEnabled: false,
  paused: false,
  state: "active",
  recoveryState: "none",
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {},
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
};
const batch = (count = 1): PersistMessageBatchInput => ({
  accountId: account.id,
  messages: Array.from({ length: count }, (_, index) => ({
    transient: {
      providerMessageId: `message-${index}`,
      conversationKey: "thread",
      messageIdHeader: `message-${index}@example.com`,
      references: [],
      inReplyTo: null,
      subject: "Mail",
      sender: "sender@example.com",
      recipients: [],
      receivedAt: account.createdAt,
      bodyText: "unpersisted raw body",
      sourceUrl: null,
      inInbox: true,
    },
    routedDecision: "review",
    summary: "summary",
    attempt: {
      id: `attempt-${index}`,
      model: "fixture",
      promptVersion: "1",
      schemaVersion: "1",
      decision: "review",
      relevance: null,
      ignoreReason: null,
      confidence: 0.5,
      summary: "summary",
      rationale: "review",
      suggestedTaskTitle: "Mail",
      rawValid: true,
      reviewReasons: [],
    },
  })),
});

const fixtures = [
  {
    name: "memory",
    create: async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const store = repository.emailTriage;
      return {
        repository,
        store,
        fault: (stage: "audit" | "link" | "attempt" | "conversation") => {
          if (stage === "link" || stage === "conversation") {
            const original = store.upsertConversation.bind(store);
            let count = 0;
            const spy = vi.spyOn(store, "upsertConversation").mockImplementation((...args) => {
              if (++count === (stage === "link" ? 2 : 1)) throw new Error("injected failure");
              return original(...args);
            });
            return () => spy.mockRestore();
          }
          const map = stage === "audit" ? store.auditEvents : store.attempts;
          let count = 0;
          const original = map.set.bind(map);
          const spy = vi.spyOn(map, "set").mockImplementation((key, value) => {
            if (++count === (stage === "attempt" ? 2 : 1)) throw new Error("injected failure");
            return original(key, value as never);
          });
          return () => spy.mockRestore();
        },
      };
    },
  },
  {
    name: "SQLite",
    create: async () => {
      const db = createNodeSqliteDatabase();
      const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
      await repository.initialize();
      return {
        repository,
        store: repository.emailTriage,
        fault: (stage: "audit" | "link" | "attempt" | "conversation") => {
          const execute = db.execute.bind(db);
          let count = 0;
          const prefix =
            stage === "audit"
              ? "INSERT INTO email_triage_audit_events"
              : stage === "attempt"
                ? "INSERT INTO email_triage_classification_attempts"
                : stage === "conversation"
                  ? "UPDATE email_triage_conversations"
                  : "UPDATE email_triage_conversations";
          const spy = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
            if (
              sql.trimStart().startsWith(prefix) &&
              ++count === (stage === "link" || stage === "attempt" ? 2 : 1)
            )
              throw new Error("injected failure");
            return execute(sql, values);
          });
          return () => spy.mockRestore();
        },
      };
    },
  },
];

for (const fixture of fixtures) {
  describe(`${fixture.name} email transactions`, () => {
    const seed = async (withMessage = true) => {
      const result = await fixture.create();
      const { store } = result;
      await store.saveAccount(account);
      const conversation = await store.upsertConversation(account.id, "thread", {
        decisionVersion: 1,
        routingState: "review",
      });
      if (withMessage) await store.persistMessageBatch(batch());
      const review = await store.createReview({
        accountId: account.id,
        conversationId: conversation.id,
        messageId: "message-0",
        expectedDecisionVersion: 1,
        reason: "test",
        preview: {
          subject: "Mail",
          sender: "sender@example.com",
          receivedAt: account.createdAt,
          sourceUrl: null,
        },
      });
      return { ...result, conversation, review };
    };

    it("rolls back a review decision when its audit write fails, then permits retry", async () => {
      const { store, conversation, review, fault } = await seed();
      const restore = fault("audit");
      const input = {
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "ignore" as const,
        ignoreReason: "User choice",
      };
      await expect(Promise.resolve().then(() => store.resolveReview(input))).rejects.toThrow(
        "injected failure",
      );
      restore();
      expect((await store.listReviews())[0]).toEqual(review);
      expect(await store.getConversation(conversation.id)).toEqual(conversation);
      expect(await store.listAuditEvents()).toEqual([]);
      expect((await store.listMessages(account.id))[0].routingDecision).toBe("review");
      expect(await store.resolveReview(input)).toMatchObject({
        status: "resolved",
        resolution: "ignore",
      });
    });

    it("rolls back GTD task creation and lifecycle events when linking the task fails", async () => {
      const { repository, store, conversation, review, fault } = await seed();
      const restore = fault("link");
      const input = {
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "relevant" as const,
      };
      await expect(Promise.resolve().then(() => store.resolveReview(input))).rejects.toThrow(
        "injected failure",
      );
      restore();
      expect((await store.listReviews())[0]).toEqual(review);
      expect(await store.getConversation(conversation.id)).toEqual(conversation);
      expect(
        await store.getTaskByExternalId(buildEmailTriageTaskExternalId(account.id, "thread")),
      ).toBeNull();
      expect(await repository.listTaskEvents()).toEqual([]);
      await store.resolveReview(input);
      expect(
        await store.getTaskByExternalId(buildEmailTriageTaskExternalId(account.id, "thread")),
      ).not.toBeNull();
      expect(
        (await repository.listTaskEvents()).filter((event) => event.type === "task_created"),
      ).toHaveLength(1);
    });

    it("resolves once under concurrent accepts without duplicating the audit or version increment", async () => {
      const { store, conversation, review } = await seed();
      const input = {
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "ignore" as const,
        ignoreReason: "User choice",
      };
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => store.resolveReview(input)),
        Promise.resolve().then(() => store.resolveReview(input)),
      ]);
      expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
      expect(await store.getConversation(conversation.id)).toMatchObject({ decisionVersion: 2 });
      expect(await store.listAuditEvents()).toHaveLength(1);
    });

    it("rolls back both messages and attempts when a batch fails midway", async () => {
      const { store, fault } = await seed(false);
      const restore = fault("attempt");
      await expect(
        Promise.resolve().then(() => store.persistMessageBatch(batch(2))),
      ).rejects.toThrow("injected failure");
      restore();
      expect(await store.listMessages(account.id)).toEqual([]);
      await store.persistMessageBatch(batch(2));
      const messages = await store.listMessages(account.id);
      expect(messages).toHaveLength(2);
      for (const message of messages)
        expect(await store.listClassificationAttempts(message.id)).toHaveLength(1);
    });

    it("rolls back dismissal if the conversation write fails", async () => {
      const { store, review, conversation, fault } = await seed();
      const restore = fault("conversation");
      await expect(Promise.resolve().then(() => store.dismissReview(review.id))).rejects.toThrow(
        "injected failure",
      );
      restore();
      expect((await store.listReviews())[0]).toEqual(review);
      expect(await store.getConversation(conversation.id)).toEqual(conversation);
      expect((await store.listMessages(account.id))[0].routingDecision).toBe("review");
    });

    it("reopens an existing email task without duplicating its lifecycle history", async () => {
      const { repository, store, conversation, review } = await seed();
      const externalId = buildEmailTriageTaskExternalId(account.id, "thread");
      const task = await repository.createTask({
        title: "Mail",
        bucket: "inbox",
        source: "email_triage",
        sourceExternalId: externalId,
      });
      await repository.completeTask(task.id);
      await store.resolveReview({
        reviewId: review.id,
        expectedDecisionVersion: 1,
        resolution: "relevant",
      });
      expect(
        (await repository.listTaskEvents()).filter((event) => event.type === "task_completed"),
      ).toHaveLength(1);
      expect(await store.getTaskByExternalId(externalId)).toMatchObject({
        status: "active",
        completedAt: null,
      });
      expect(await store.getConversation(conversation.id)).toMatchObject({ taskId: task.id });
    });
  });
}

it("uses the repository writer for email work without interleaving an unrelated settings transaction", async () => {
  const db = createNodeSqliteDatabase();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  const store = repository.emailTriage;
  await store.saveAccount(account);
  const conversation = await store.upsertConversation(account.id, "thread", {
    decisionVersion: 1,
    routingState: "review",
  });
  const review = await store.createReview({
    accountId: account.id,
    conversationId: conversation.id,
    messageId: "message",
    expectedDecisionVersion: 1,
    reason: "test",
    preview: {
      subject: "Mail",
      sender: "sender@example.com",
      receivedAt: account.createdAt,
      sourceUrl: null,
    },
  });
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const statements: string[] = [];
  const execute = db.execute.bind(db);
  vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    statements.push(sql);
    if (sql.startsWith("UPDATE email_triage_reviews SET status = 'resolved'")) {
      reached();
      await gate;
    }
    return execute(sql, values);
  });
  const resolution = store.resolveReview({
    reviewId: review.id,
    expectedDecisionVersion: 1,
    resolution: "ignore",
    ignoreReason: "choice",
  });
  await entered;
  const settings = repository.updateSettings((current) => ({ ...current, aiEnabled: true }));
  await Promise.resolve();
  expect(statements.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
  release();
  await Promise.all([resolution, settings]);
  expect(statements.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(2);
  expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(2);
});

it("preserves the compare-and-set failure message and rolls back the transaction", async () => {
  const db = createNodeSqliteDatabase();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  const store = repository.emailTriage;
  await store.saveAccount(account);
  const conversation = await store.upsertConversation(account.id, "thread", {
    decisionVersion: 1,
    routingState: "review",
  });
  const review = await store.createReview({
    accountId: account.id,
    conversationId: conversation.id,
    messageId: "message",
    expectedDecisionVersion: 1,
    reason: "test",
    preview: {
      subject: "Mail",
      sender: "sender@example.com",
      receivedAt: account.createdAt,
      sourceUrl: null,
    },
  });
  const execute = db.execute.bind(db);
  vi.spyOn(db, "execute").mockImplementation((sql, values) =>
    sql.startsWith("UPDATE email_triage_reviews SET status = 'resolved'")
      ? Promise.resolve({ rowsAffected: 0 })
      : execute(sql, values),
  );
  await expect(
    store.resolveReview({
      reviewId: review.id,
      expectedDecisionVersion: 1,
      resolution: "relevant",
    }),
  ).rejects.toThrow("Review compare-and-set failed");
  expect((await store.listReviews())[0]).toEqual(review);
  expect(await store.getConversation(conversation.id)).toEqual(conversation);
});
