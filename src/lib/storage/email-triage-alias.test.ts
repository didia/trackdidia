import { describe, expect, it } from "vitest";
import { createTaskFromInput } from "../gtd/engine";
import { EmailTriageMemoryStore } from "./email-triage-memory-store";
import type { Database } from "./email-triage-sqlite-db";
import { EmailTriageSqliteStore } from "./email-triage-sqlite-store";

describe("email triage alias repository parity", () => {
  it("stores and resolves Message-ID aliases in memory and sqlite stores", async () => {
    const memory = new EmailTriageMemoryStore({
      getTaskByExternalId: () => undefined,
      createTask: (input) => createTaskFromInput(input),
      saveTask: (task) => task,
      persistEvents: () => undefined,
      getTaskById: () => undefined,
    });
    memory.saveAccount({
      id: "acct-1",
      provider: "yahoo",
      providerAccountId: "me@yahoo.com",
      label: "Yahoo",
      maskedAddress: "m***@yahoo.com",
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
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    memory.saveAlias("acct-1", "<parent@mail>", "<parent@mail>");
    expect(memory.findConversationKeyByMessageId("acct-1", "<parent@mail>")).toBe("<parent@mail>");

    const aliases: Array<Record<string, unknown>> = [];
    const conversations: Array<Record<string, unknown>> = [];
    const fakeDb: Database = {
      async execute(query: string, bindValues: unknown[] = []) {
        if (query.includes("INSERT INTO email_triage_conversations")) {
          conversations.push({
            id: bindValues[0],
            account_id: bindValues[1],
            conversation_key: bindValues[2],
          });
          return { rowsAffected: 1 };
        }
        if (query.includes("INSERT INTO email_triage_aliases")) {
          aliases.push({
            id: bindValues[0],
            conversation_id: bindValues[1],
            message_id_header: bindValues[2],
          });
          return { rowsAffected: 1 };
        }
        return { rowsAffected: 0 };
      },
      async select<T>(query: string, bindValues: unknown[] = []) {
        if (query.includes("FROM email_triage_conversations")) {
          const accountId = bindValues[0];
          const conversationKey = bindValues[1];
          const row = conversations.find(
            (conversation) =>
              conversation.account_id === accountId &&
              conversation.conversation_key === conversationKey,
          );
          return (row ? [{ id: row.id as string }] : []) as T;
        }
        if (query.includes("FROM email_triage_aliases a")) {
          const accountId = bindValues[0];
          const messageIdHeader = bindValues[1];
          const alias = aliases.find((item) => item.message_id_header === messageIdHeader);
          if (!alias) {
            return [] as T;
          }
          const conversation = conversations.find(
            (item) => item.id === alias.conversation_id && item.account_id === accountId,
          );
          return (
            conversation ? [{ conversation_key: conversation.conversation_key as string }] : []
          ) as T;
        }
        if (query.includes("SELECT id FROM email_triage_aliases")) {
          return [] as T;
        }
        return [] as T;
      },
    };

    const sqlite = new EmailTriageSqliteStore(async () => fakeDb, {
      getTaskByExternalId: async () => null,
      createTask: async (input) => createTaskFromInput(input),
      saveTask: async (task) => task,
      persistEvents: async () => undefined,
    });
    await sqlite.saveAlias("acct-1", "<parent@mail>", "<parent@mail>");
    expect(await sqlite.findConversationKeyByMessageId("acct-1", "<parent@mail>")).toBe(
      "<parent@mail>",
    );
  });
});
