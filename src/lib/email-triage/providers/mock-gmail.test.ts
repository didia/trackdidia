import { describe, expect, it } from "vitest";
import { MockGmailAdapter, type MockGmailHistoryEntry, type MockGmailMessage } from "./mock-gmail";

describe("mock gmail adapter", () => {
  it("ignores label-only history and dedupes messagesAdded", async () => {
    const messages = new Map<string, MockGmailMessage>([
      [
        "m1",
        {
          id: "m1",
          threadId: "t1",
          historyId: "2",
          internalDate: "1700000000000",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "a@b.com" },
            ],
            body: { data: btoa("Body") },
          },
        },
      ],
    ]);
    const history: MockGmailHistoryEntry[] = [
      { historyId: "2", labelsAdded: [{ message: { id: "m1" }, labelIds: ["Trackdidia-Inbox"] }] },
      { historyId: "3", messagesAdded: [{ id: "m1", threadId: "t1" }] },
    ];
    const adapter = new MockGmailAdapter(history, messages);
    const baseline = await adapter.fetchPage({});
    expect(baseline.cursorUpdate?.baselineHistoryId).toBe("3");
    const page = await adapter.fetchPage({
      baselineHistoryId: "3",
      cursorHistoryId: "2",
      pagesConsumed: 0,
      trackedMessageIds: [],
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.providerMessageId).toBe("m1");
  });

  it("flags expired history as gap review", async () => {
    const adapter = new MockGmailAdapter([], new Map(), { expiredHistoryAt: "99" });
    const page = await adapter.fetchPage({ baselineHistoryId: "1", cursorHistoryId: "99" });
    expect(page.gapDetected).toBe(true);
    expect(page.cursorUpdate?.recoveryStartHistoryId).toBe("99");
  });
});
