import { describe, expect, it } from "vitest";
import { MockYahooAdapter, resolveYahooConversationKey } from "./mock-yahoo";

describe("mock yahoo adapter", () => {
  it("links conversations by Message-ID references", () => {
    const aliasMap = new Map<string, string>();
    const parentKey = resolveYahooConversationKey(
      {
        messageIdHeader: "<parent@mail>",
        references: [],
        inReplyTo: null,
      },
      aliasMap,
    );
    const childKey = resolveYahooConversationKey(
      {
        messageIdHeader: "<child@mail>",
        references: ["<parent@mail>"],
        inReplyTo: "<parent@mail>",
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
