import { describe, expect, it, vi } from "vitest";
import { YahooAdapter } from "./yahoo-adapter";
import {
  buildYahooProviderMessageId,
  type YahooImapClient,
  type YahooImapMessage,
} from "./yahoo-api";
import { InMemoryYahooConversationResolver } from "./yahoo-conversation";

const sampleMessage = (
  uid: number,
  overrides: Partial<YahooImapMessage> = {},
): YahooImapMessage => ({
  uid,
  messageId: `<msg-${uid}@example.com>`,
  references: [],
  inReplyTo: null,
  subject: `Subject ${uid}`,
  from: "sender@example.com",
  to: ["me@example.com"],
  receivedAt: "2026-01-01T00:00:00.000Z",
  bodyText: "Body",
  ...overrides,
});

const wrapFetchInbox = (
  handler: YahooImapClient["fetchInbox"] | undefined,
  defaultUidvalidity = 42,
): YahooImapClient["fetchInbox"] => {
  if (handler) {
    return handler;
  }
  return async () => ({ messages: [], uidvalidity: defaultUidvalidity });
};

const createFakeImap = (handlers: Partial<YahooImapClient>): YahooImapClient => ({
  discover:
    handlers.discover ??
    (async () => ({
      delimiter: "/",
      inboxName: "INBOX",
      namespacePrefix: null,
      uidvalidity: 42,
      highestUid: 10,
      supportsMove: true,
      supportsUidplus: true,
      supportsUidExpunge: true,
      capabilities: ["IMAP4rev1", "MOVE", "UIDPLUS"],
    })),
  fetchInbox: wrapFetchInbox(handlers.fetchInbox),
  searchMessageId: handlers.searchMessageId ?? (async () => null),
  ensureMailbox: handlers.ensureMailbox ?? (async () => undefined),
  moveUid:
    handlers.moveUid ??
    (async () => ({ destinationUid: null, destinationMailbox: "Trackdidia-Inbox" })),
  copyUid:
    handlers.copyUid ??
    (async () => ({ destinationUid: null, destinationMailbox: "Trackdidia-Inbox" })),
  uidExpunge: handlers.uidExpunge ?? (async () => undefined),
  fetchUidMessageId: handlers.fetchUidMessageId ?? (async () => null),
});

describe("YahooAdapter", () => {
  it("records baseline uidvalidity and highest UID without messages", async () => {
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 7,
          highestUid: 15,
          supportsMove: true,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
        }),
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({});
    expect(page.messages).toEqual([]);
    expect(page.cursorUpdate?.baselineUid).toBe(15);
    expect(page.cursorUpdate?.cursorUid).toBe(15);
    expect(page.cursorUpdate?.uidvalidity).toBe(7);
    expect(page.accountPatch?.state).toBe("active");
  });

  it("fetches only UIDs greater than cursor in pages of 10", async () => {
    const fetchInbox = vi.fn(async ({ afterUid, limit }: { afterUid: number; limit: number }) => {
      const all = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map((uid) => sampleMessage(uid));
      return {
        messages: all.filter((message) => message.uid > afterUid).slice(0, limit),
        uidvalidity: 42,
      };
    });
    const adapter = new YahooAdapter(
      createFakeImap({ fetchInbox }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
    });
    expect(page.messages).toHaveLength(10);
    expect(page.messages[0]?.providerMessageId).toBe(buildYahooProviderMessageId(42, 11));
    expect(page.hasMore).toBe(true);
    expect(fetchInbox).toHaveBeenCalledWith({
      credentials: { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      afterUid: 10,
      limit: 10,
    });
  });

  it("quarantines oversized messages and still advances the UID cursor", async () => {
    const adapter = new YahooAdapter(
      createFakeImap({
        fetchInbox: async () => ({
          messages: [
            sampleMessage(11, { oversized: true, bodyText: "should not classify" }),
            sampleMessage(12),
          ],
          uidvalidity: 42,
        }),
      }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
    });
    expect(page.messages.map((message) => message.providerMessageId)).toEqual([
      buildYahooProviderMessageId(42, 12),
    ]);
    expect(page.cursorUpdate?.trackedMessageIds).toEqual([
      buildYahooProviderMessageId(42, 11),
      buildYahooProviderMessageId(42, 12),
    ]);
    expect(page.cursorUpdate?.cursorUid).toBe(12);
  });

  it("links conversations through shared Message-ID resolver", async () => {
    const aliasMap = new Map<string, string>();
    const resolver = new InMemoryYahooConversationResolver(aliasMap);
    const adapter = new YahooAdapter(
      createFakeImap({
        fetchInbox: async () => ({
          messages: [
            sampleMessage(11, {
              messageId: "<child@mail>",
              references: ["<parent@mail>"],
              inReplyTo: "<parent@mail>",
            }),
          ],
          uidvalidity: 42,
        }),
      }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      resolver,
      () => [],
      async () => null,
    );
    aliasMap.set("<parent@mail>", "<parent@mail>");
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
    });
    expect(page.messages[0]?.conversationKey).toBe("<parent@mail>");
  });

  it("does not merge ambiguous references", async () => {
    const aliasMap = new Map<string, string>([
      ["<a@mail>", "<a@mail>"],
      ["<b@mail>", "<b@mail>"],
    ]);
    const adapter = new YahooAdapter(
      createFakeImap({
        fetchInbox: async () => ({
          messages: [
            sampleMessage(11, {
              messageId: "<child@mail>",
              references: ["<a@mail>", "<b@mail>"],
              inReplyTo: "<a@mail>",
            }),
          ],
          uidvalidity: 42,
        }),
      }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(aliasMap),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
    });
    expect(page.messages[0]?.conversationKey).toBe("<child@mail>");
  });

  it("enters gap review when UIDVALIDITY changes even if a watermark Message-ID still exists", async () => {
    const searchMessageId = vi.fn(async () => 25);
    const discover = vi.fn(async () => ({
      delimiter: "/",
      inboxName: "INBOX",
      namespacePrefix: null,
      uidvalidity: 99,
      highestUid: 30,
      supportsMove: true,
      supportsUidplus: true,
      supportsUidExpunge: true,
      capabilities: [],
    }));
    const adapter = new YahooAdapter(
      createFakeImap({
        discover,
        fetchInbox: async () => ({ messages: [], uidvalidity: 99 }),
        searchMessageId,
      }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
      lastConfirmedMessageId: "<watermark@mail>",
    });
    expect(searchMessageId).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(page.gapDetected).toBe(true);
    expect(page.accountPatch?.state).toBe("gap_review_required");
    expect(page.accountPatch?.recoveryState).toBe("uidvalidity_changed");
    expect(page.cursorUpdate?.cursorUid).toBeUndefined();
  });

  it("enters gap review when UIDVALIDITY changes without watermark", async () => {
    const discover = vi.fn(async () => ({
      delimiter: "/",
      inboxName: "INBOX",
      namespacePrefix: null,
      uidvalidity: 99,
      highestUid: 30,
      supportsMove: true,
      supportsUidplus: true,
      supportsUidExpunge: true,
      capabilities: [],
    }));
    const adapter = new YahooAdapter(
      createFakeImap({
        discover,
        fetchInbox: async () => ({ messages: [], uidvalidity: 99 }),
      }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const page = await adapter.fetchPage({
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
    });
    expect(page.gapDetected).toBe(true);
    expect(page.accountPatch?.state).toBe("gap_review_required");
    expect(page.accountPatch?.recoveryState).toBe("uidvalidity_changed");
    expect(discover).not.toHaveBeenCalled();
  });

  it("calls discover only for baseline, not on every sync page", async () => {
    const discover = vi.fn(async () => ({
      delimiter: "/",
      inboxName: "INBOX",
      namespacePrefix: null,
      uidvalidity: 42,
      highestUid: 10,
      supportsMove: true,
      supportsUidplus: true,
      supportsUidExpunge: true,
      capabilities: [],
    }));
    const fetchInbox = vi.fn(async ({ afterUid, limit }: { afterUid: number; limit: number }) => {
      const all = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((uid) => sampleMessage(uid));
      return {
        messages: all.filter((message) => message.uid > afterUid).slice(0, limit),
        uidvalidity: 42,
      };
    });
    const adapter = new YahooAdapter(
      createFakeImap({ discover, fetchInbox }),
      { email: "me@yahoo.com", appPassword: "secret", inboxName: "INBOX" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    const syncState = {
      baselineUid: 10,
      cursorUid: 10,
      uidvalidity: 42,
      inboxName: "INBOX",
      delimiter: "/",
      supportsMove: true,
      supportsUidplus: true,
      supportsUidExpunge: true,
    };
    await adapter.fetchPage(syncState);
    await adapter.fetchPage({
      ...syncState,
      cursorUid: 20,
    });
    expect(discover).not.toHaveBeenCalled();
    expect(fetchInbox).toHaveBeenCalledTimes(2);
  });

  it("uses MOVE without expunging the source mailbox", async () => {
    const moveUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Inbox",
    }));
    const uidExpunge = vi.fn(async () => undefined);
    const ensureMailbox = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({ moveUid, uidExpunge, ensureMailbox }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => "<msg@mail>",
    );
    await adapter.applyMarkers({ messageIds: ["42:7"], decision: "relevant" });
    expect(ensureMailbox).toHaveBeenCalledWith({
      credentials: { email: "me@yahoo.com", appPassword: "secret" },
      mailboxName: "Trackdidia-Inbox",
    });
    expect(ensureMailbox).toHaveBeenCalledWith({
      credentials: { email: "me@yahoo.com", appPassword: "secret" },
      mailboxName: "Trackdidia-Triage-Ignore",
    });
    expect(moveUid).toHaveBeenCalled();
    expect(uidExpunge).not.toHaveBeenCalled();
  });

  it("uses COPY and UID EXPUNGE only after destination verification", async () => {
    const copyUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Triage-Ignore/other",
    }));
    const uidExpunge = vi.fn(async () => undefined);
    const moveUid = vi.fn(async () => ({ destinationUid: null, destinationMailbox: null }));
    const persistMarkerDestination = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 42,
          highestUid: 10,
          supportsMove: false,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
        }),
        copyUid,
        moveUid,
        uidExpunge,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => "<msg@mail>",
      persistMarkerDestination,
    );
    await adapter.applyMarkers({
      messageIds: ["42:7"],
      decision: "ignore",
      ignoreReason: "other",
    });
    expect(copyUid).toHaveBeenCalled();
    expect(persistMarkerDestination).toHaveBeenLastCalledWith("42:7", {
      mailbox: "Trackdidia-Triage-Ignore/other",
      uid: 5,
      messageId: "<msg@mail>",
    });
    expect(uidExpunge).toHaveBeenCalled();
    expect(moveUid).not.toHaveBeenCalled();
  });

  it("skips COPY expunge when Message-ID and COPYUID are both missing", async () => {
    const copyUid = vi.fn(async () => ({ destinationUid: null, destinationMailbox: null }));
    const uidExpunge = vi.fn(async () => undefined);
    const searchMessageId = vi.fn(async () => null);
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 42,
          highestUid: 10,
          supportsMove: false,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
        }),
        copyUid,
        uidExpunge,
        searchMessageId,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => null,
    );
    await expect(
      adapter.applyMarkers({
        messageIds: ["42:7"],
        decision: "ignore",
        ignoreReason: "other",
      }),
    ).rejects.toThrow("unverified_copy_destination");
    expect(copyUid).toHaveBeenCalled();
    expect(uidExpunge).not.toHaveBeenCalled();
  });

  it("expunges verified source when destination already contains Message-ID", async () => {
    const moveUid = vi.fn(async () => ({ destinationUid: null, destinationMailbox: null }));
    const uidExpunge = vi.fn(async () => undefined);
    const persistMarkerDestination = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({
        searchMessageId: async ({ messageId }) => (messageId === "<msg@mail>" ? 99 : null),
        moveUid,
        uidExpunge,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => "<msg@mail>",
      persistMarkerDestination,
    );
    await adapter.applyMarkers({ messageIds: ["42:7"], decision: "relevant" });
    expect(moveUid).not.toHaveBeenCalled();
    expect(persistMarkerDestination).toHaveBeenCalledWith("42:7", {
      mailbox: "Trackdidia-Inbox",
      uid: 99,
      messageId: "<msg@mail>",
    });
    expect(uidExpunge).toHaveBeenCalled();
  });

  it("refuses untracked provider message ids", async () => {
    const adapter = new YahooAdapter(
      createFakeImap({}),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => [],
      async () => null,
    );
    await expect(
      adapter.applyMarkers({ messageIds: ["42:7"], decision: "relevant" }),
    ).rejects.toThrow("untracked_message_id");
  });

  it("refuses markers when provider message UIDVALIDITY no longer matches mailbox", async () => {
    const moveUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Inbox",
    }));
    const copyUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Inbox",
    }));
    const uidExpunge = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 200,
          highestUid: 10,
          supportsMove: true,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
        }),
        moveUid,
        copyUid,
        uidExpunge,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["100:7"],
      async () => "<msg@mail>",
    );
    await expect(
      adapter.applyMarkers({ messageIds: ["100:7"], decision: "relevant" }),
    ).rejects.toThrow("uidvalidity_changed");
    expect(moveUid).not.toHaveBeenCalled();
    expect(copyUid).not.toHaveBeenCalled();
    expect(uidExpunge).not.toHaveBeenCalled();
  });

  it("fails verified COPY when UID EXPUNGE is unavailable", async () => {
    const copyUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Triage-Ignore/other",
    }));
    const uidExpunge = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 42,
          highestUid: 10,
          supportsMove: false,
          supportsUidplus: false,
          supportsUidExpunge: false,
          capabilities: [],
        }),
        copyUid,
        uidExpunge,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => "<msg@mail>",
    );
    await expect(
      adapter.applyMarkers({
        messageIds: ["42:7"],
        decision: "ignore",
        ignoreReason: "other",
      }),
    ).rejects.toThrow("uidplus_unavailable");
    expect(copyUid).toHaveBeenCalled();
    expect(uidExpunge).not.toHaveBeenCalled();
  });

  it("treats a destination-only retry as completed after MOVE succeeded", async () => {
    const moveUid = vi.fn(async () => ({
      destinationUid: 5,
      destinationMailbox: "Trackdidia-Inbox",
    }));
    const persistMarkerDestination = vi.fn(async () => undefined);
    const adapter = new YahooAdapter(
      createFakeImap({
        moveUid,
        searchMessageId: async ({ credentials, messageId }) =>
          credentials.inboxName === "Trackdidia-Inbox" && messageId === "<msg@mail>" ? 5 : null,
      }),
      { email: "me@yahoo.com", appPassword: "secret" },
      new InMemoryYahooConversationResolver(new Map()),
      () => ["42:7"],
      async () => {
        throw new Error("Missing FETCH response");
      },
      persistMarkerDestination,
      async () => ({
        mailbox: "Trackdidia-Inbox",
        uid: 5,
        messageId: "<msg@mail>",
      }),
    );
    await adapter.applyMarkers({ messageIds: ["42:7"], decision: "relevant" });
    expect(moveUid).not.toHaveBeenCalled();
    expect(persistMarkerDestination).toHaveBeenCalledWith("42:7", {
      mailbox: "Trackdidia-Inbox",
      uid: 5,
      messageId: "<msg@mail>",
    });
  });
});
