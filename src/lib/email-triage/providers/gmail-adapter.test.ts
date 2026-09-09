import { describe, expect, it, vi } from "vitest";
import { GmailAdapter } from "./gmail-adapter";
import { GmailApiClient, type GmailHistoryRecord, type GmailMessagePayload } from "./gmail-api";

const sampleMessage = (
  id: string,
  overrides: Partial<GmailMessagePayload> = {},
): GmailMessagePayload => ({
  id,
  threadId: "thread-1",
  internalDate: "1700000001000",
  labelIds: ["INBOX"],
  payload: {
    headers: [
      { name: "Subject", value: "Hello" },
      { name: "From", value: "sender@example.com" },
      { name: "Message-ID", value: "<msg@example.com>" },
    ],
    body: { data: btoa("Body") },
  },
  ...overrides,
});

const createFakeApi = (handlers: {
  listHistory?: (options: { startHistoryId: string; pageToken?: string }) => Promise<{
    history?: GmailHistoryRecord[];
    historyId?: string;
    nextPageToken?: string;
    error?: { code?: number; status?: string; message?: string };
  }>;
  getMessage?: (messageId: string) => Promise<GmailMessagePayload>;
  listInboxMessages?: (options: { pageToken?: string }) => Promise<{
    messages?: Array<{ id: string }>;
    nextPageToken?: string;
  }>;
  getProfile?: () => Promise<{ emailAddress: string; historyId: string }>;
  listLabels?: () => Promise<Array<{ id: string; name: string }>>;
  createLabel?: (name: string) => Promise<{ id: string; name: string }>;
  modifyMessageLabels?: (
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ) => Promise<void>;
}) => {
  const api = {
    getProfile: handlers.getProfile ?? (async () => ({ emailAddress: "me@example.com", historyId: "500" })),
    listHistory:
      handlers.listHistory ??
      (async () => ({
        history: [],
        historyId: "100",
      })),
    getMessage: handlers.getMessage ?? (async (messageId: string) => sampleMessage(messageId)),
    listInboxMessages: handlers.listInboxMessages ?? (async () => ({ messages: [] })),
    listLabels:
      handlers.listLabels ??
      (async () => [
        { id: "lbl-inbox", name: "Trackdidia-Inbox" },
        { id: "lbl-ignore", name: "Trackdidia-Triage-Ignore" },
      ]),
    createLabel: handlers.createLabel ?? (async (name: string) => ({ id: `lbl-${name}`, name })),
    modifyMessageLabels:
      handlers.modifyMessageLabels ?? (async () => undefined),
  };
  return api as unknown as GmailApiClient;
};

describe("GmailAdapter", () => {
  it("records baseline historyId without returning messages", async () => {
    const adapter = new GmailAdapter(
      createFakeApi({
        getProfile: async () => ({ emailAddress: "me@example.com", historyId: "42" }),
      }),
      "me@example.com",
      () => [],
    );
    const page = await adapter.fetchPage({});
    expect(page.messages).toEqual([]);
    expect(page.cursorUpdate?.baselineHistoryId).toBe("42");
    expect(page.cursorUpdate?.cursorHistoryId).toBe("42");
  });

  it("processes messagesAdded inbox history and dedupes tracked ids", async () => {
    const getMessage = vi.fn(async (messageId: string) => sampleMessage(messageId));
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory: async () => ({
          history: [
            {
              id: "101",
              messagesAdded: [{ message: { id: "m1", threadId: "thread-1" } }],
            },
            {
              id: "102",
              messagesAdded: [{ message: { id: "m1", threadId: "thread-1" } }],
            },
          ],
          historyId: "102",
        }),
        getMessage,
      }),
      "me@example.com",
      () => ["m1"],
    );
    const page = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      trackedMessageIds: [],
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.providerMessageId).toBe("m1");
    expect(getMessage).toHaveBeenCalledTimes(1);
  });

  it("skips messages that are not currently in INBOX", async () => {
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory: async () => ({
          history: [{ id: "101", messagesAdded: [{ message: { id: "m1" } }] }],
          historyId: "101",
        }),
        getMessage: async () => sampleMessage("m1", { labelIds: ["SENT"] }),
      }),
      "me@example.com",
      () => [],
    );
    const page = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      trackedMessageIds: [],
    });
    expect(page.messages).toHaveLength(0);
  });

  it("ignores label-only history including TrackDidia labels", async () => {
    const getMessage = vi.fn(async (messageId: string) => sampleMessage(messageId));
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory: async () => ({
          history: [
            {
              id: "101",
              labelsAdded: [
                {
                  message: { id: "m1" },
                  labelIds: ["Trackdidia-Inbox"],
                },
              ],
            },
          ],
          historyId: "101",
        }),
        getMessage,
      }),
      "me@example.com",
      () => [],
    );
    const page = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      trackedMessageIds: [],
    });
    expect(page.messages).toHaveLength(0);
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("persists history page tokens in cursor updates", async () => {
    const listHistory = vi.fn(async ({ startHistoryId, pageToken }: { startHistoryId: string; pageToken?: string }) =>
      pageToken
        ? { history: [], historyId: "999" }
        : {
            history: [{ id: "101", messagesAdded: [{ message: { id: "m1" } }] }],
            historyId: "101",
            nextPageToken: "token-2",
          },
    );
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory,
        getMessage: async (messageId) => sampleMessage(messageId),
      }),
      "me@example.com",
      () => ["m1"],
    );
    const first = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      trackedMessageIds: [],
    });
    expect(first.hasMore).toBe(true);
    expect(first.cursorUpdate?.historyPageToken).toBe("token-2");
    expect(first.cursorUpdate?.cursorHistoryId).toBe("100");
    const second = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      historyPageToken: "token-2",
      trackedMessageIds: ["m1"],
    });
    expect(second.hasMore).toBe(false);
    expect(second.cursorUpdate?.cursorHistoryId).toBe("999");
    expect(listHistory).toHaveBeenNthCalledWith(1, {
      startHistoryId: "100",
      pageToken: undefined,
    });
    expect(listHistory).toHaveBeenNthCalledWith(2, {
      startHistoryId: "100",
      pageToken: "token-2",
    });
  });

  it("enters gap review when history expires without watermark", async () => {
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory: async () => ({
          error: { code: 404, status: "NOT_FOUND", message: "History not found" },
        }),
        getProfile: async () => ({ emailAddress: "me@example.com", historyId: "900" }),
      }),
      "me@example.com",
      () => [],
    );
    const page = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      trackedMessageIds: [],
    });
    expect(page.gapDetected).toBe(true);
    expect(page.cursorUpdate?.recoveryStartHistoryId).toBe("900");
  });

  it("scans inbox after expired history when watermark exists, then replays history", async () => {
    let historyCalls = 0;
    const adapter = new GmailAdapter(
      createFakeApi({
        listHistory: async () => {
          historyCalls += 1;
          if (historyCalls === 1) {
            return { error: { code: 404, status: "NOT_FOUND", message: "History not found" } };
          }
          return { history: [], historyId: "905" };
        },
        getProfile: async () => ({ emailAddress: "me@example.com", historyId: "900" }),
        listInboxMessages: async ({ pageToken }) =>
          pageToken
            ? { messages: [] }
            : {
                messages: [{ id: "m-new" }],
              },
        getMessage: async (messageId) =>
          sampleMessage(messageId, { internalDate: "1700000002000" }),
      }),
      "me@example.com",
      () => ["m-new"],
    );
    const expired = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      lastConfirmedInternalDate: "1700000000000",
      trackedMessageIds: [],
    });
    expect(expired.cursorUpdate?.recoveryPhase).toBe("scanning");
    const scanned = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      recoveryPhase: "scanning",
      lastConfirmedInternalDate: "1700000000000",
      trackedMessageIds: [],
    });
    expect(scanned.messages).toHaveLength(1);
    expect(scanned.cursorUpdate?.recoveryPhase).toBe("replaying");
    const replayed = await adapter.fetchPage({
      baselineHistoryId: "100",
      cursorHistoryId: "100",
      recoveryPhase: "replaying",
      recoveryStartHistoryId: "900",
      recoveryScanComplete: true,
      lastConfirmedInternalDate: "1700000002000",
      trackedMessageIds: ["m-new"],
    });
    expect(replayed.cursorUpdate?.recoveryPhase).toBe("none");
    expect(replayed.gapDetected).toBe(false);
  });

  it("applies markers only for tracked ids with expected label names", async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = new GmailAdapter(
      createFakeApi({
        modifyMessageLabels: modify,
        getMessage: async () => sampleMessage("m1", { labelIds: ["INBOX", "lbl-old"] }),
        listLabels: async () => [{ id: "lbl-inbox", name: "Trackdidia-Inbox" }],
        createLabel: async (name) => ({ id: `created-${name}`, name }),
      }),
      "me@example.com",
      () => ["m1"],
    );
    await adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" });
    expect(modify).toHaveBeenCalledWith("m1", ["lbl-inbox"], []);
  });

  it("adds ignore base and reason labels", async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = new GmailAdapter(
      createFakeApi({
        modifyMessageLabels: modify,
        getMessage: async () => sampleMessage("m1", { labelIds: ["INBOX"] }),
        listLabels: async () => [
          { id: "lbl-ignore", name: "Trackdidia-Triage-Ignore" },
          { id: "lbl-reason", name: "Trackdidia-Triage-Ignore/newsletter" },
        ],
      }),
      "me@example.com",
      () => ["m1"],
    );
    await adapter.applyMarkers({
      messageIds: ["m1"],
      decision: "ignore",
      ignoreReason: "newsletter",
    });
    expect(modify).toHaveBeenCalledWith("m1", ["lbl-ignore", "lbl-reason"], []);
  });

  it("removes obsolete ignore reason labels when applying relevant", async () => {
    const modify = vi.fn(async () => undefined);
    const adapter = new GmailAdapter(
      createFakeApi({
        modifyMessageLabels: modify,
        getMessage: async () =>
          sampleMessage("m1", {
            labelIds: ["INBOX", "lbl-ignore", "lbl-reason"],
          }),
        listLabels: async () => [
          { id: "lbl-inbox", name: "Trackdidia-Inbox" },
          { id: "lbl-ignore", name: "Trackdidia-Triage-Ignore" },
          { id: "lbl-reason", name: "Trackdidia-Triage-Ignore/promotion" },
        ],
      }),
      "me@example.com",
      () => ["m1"],
    );
    await adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" });
    expect(modify).toHaveBeenCalledWith("m1", ["lbl-inbox"], ["lbl-ignore", "lbl-reason"]);
  });

  it("refuses marker application for untracked message ids", async () => {
    const adapter = new GmailAdapter(createFakeApi({}), "me@example.com", () => []);
    await expect(
      adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" }),
    ).rejects.toThrow(/untracked_message_id/);
  });
});
