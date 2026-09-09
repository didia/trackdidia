import { describe, expect, it } from "vitest";
import { MockYahooAdapter, resolveYahooConversationKey } from "./mock-yahoo";

describe("mock yahoo adapter", () => {
  it("links conversations by Message-ID references", () => {
    const aliasMap = new Map<string, string>();
    const parentKey = resolveYahooConversationKey(
      {
        uid: 1,
        messageId: "<parent@mail>",
        references: [],
        inReplyTo: null,
        subject: "Parent",
        from: "a@b.com",
        to: ["me@example.com"],
        internalDate: "2026-01-01T00:00:00Z",
        body: "",
        folder: "INBOX",
      },
      aliasMap,
    );
    const childKey = resolveYahooConversationKey(
      {
        uid: 2,
        messageId: "<child@mail>",
        references: ["<parent@mail>"],
        inReplyTo: "<parent@mail>",
        subject: "Re: Parent",
        from: "a@b.com",
        to: ["me@example.com"],
        internalDate: "2026-01-02T00:00:00Z",
        body: "",
        folder: "INBOX",
      },
      aliasMap,
    );
    expect(childKey).toBe(parentKey);
  });

  it("enters gap review on UIDVALIDITY change", async () => {
    const adapter = new MockYahooAdapter([], { uidvalidityChange: true });
    const result = await adapter.fetchPage({ baselineUid: 10, uidvalidity: 1 });
    expect(result.gapDetected).toBe(true);
  });
});
