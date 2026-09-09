import { describe, expect, it, vi } from "vitest";
import { YahooAdapter } from "./yahoo-adapter";
import {
  buildYahooProviderMessageId,
  type YahooImapClient,
  type YahooImapMessage,
} from "./yahoo-api";
import { InMemoryYahooConversationResolver } from "./yahoo-conversation";

const sampleMessage = (uid: number, overrides: Partial<YahooImapMessage> = {}): YahooImapMessage => ({
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

const createFakeImap = (handlers: Partial<YahooImapClient>): YahooImapClient => ({
  discover: handlers.discover ?? (async () => ({
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
  fetchInbox: handlers.fetchInbox ?? (async () => []),
  searchMessageId: handlers.searchMessageId ?? (async () => null),
  ensureMailbox: handlers.ensureMailbox ?? (async () => undefined),
  moveUid: handlers.moveUid ?? (async () => ({ destinationUid: null, destinationMailbox: "Trackdidia-Inbox" })),
  copyUid: handlers.copyUid ?? (async () => ({ destinationUid: null, destinationMailbox: "Trackdidia-Inbox" })),
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
      return all.filter((message) => message.uid > afterUid).slice(0, limit);
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

  it("links conversations through shared Message-ID resolver", async () => {
    const aliasMap = new Map<string, string>();
    const resolver = new InMemoryYahooConversationResolver(aliasMap);
    const adapter = new YahooAdapter(
      createFakeImap({
        fetchInbox: async () => [
          sampleMessage(11, {
            messageId: "<child@mail>",
            references: ["<parent@mail>"],
            inReplyTo: "<parent@mail>",
          }),
        ],
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
        fetchInbox: async () => [
          sampleMessage(11, {
            messageId: "<child@mail>",
            references: ["<a@mail>", "<b@mail>"],
            inReplyTo: "<a@mail>",
          }),
        ],
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

  it("recovers UIDVALIDITY changes when watermark Message-ID exists", async () => {
    const searchMessageId = vi.fn(async () => 25);
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 99,
          highestUid: 30,
          supportsMove: true,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
        }),
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
    expect(searchMessageId).toHaveBeenCalled();
    expect(page.gapDetected).toBe(false);
    expect(page.cursorUpdate?.cursorUid).toBe(25);
    expect(page.cursorUpdate?.uidvalidity).toBe(99);
  });

  it("enters gap review when UIDVALIDITY changes without watermark", async () => {
    const adapter = new YahooAdapter(
      createFakeImap({
        discover: async () => ({
          delimiter: "/",
          inboxName: "INBOX",
          namespacePrefix: null,
          uidvalidity: 99,
          highestUid: 30,
          supportsMove: true,
          supportsUidplus: true,
          supportsUidExpunge: true,
          capabilities: [],
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
    expect(page.gapDetected).toBe(true);
    expect(page.accountPatch?.state).toBe("gap_review_required");
    expect(page.accountPatch?.recoveryState).toBe("uidvalidity_changed");
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
    expect(persistMarkerDestination).toHaveBeenCalledWith("42:7", {
      mailbox: "Trackdidia-Triage-Ignore/other",
      uid: 5,
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
});
