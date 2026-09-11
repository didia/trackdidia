import { describe, expect, it } from "vitest";
import {
  resolveYahooConversationKey,
  resolveYahooConversationKeySync,
  InMemoryYahooConversationResolver,
} from "./yahoo-conversation";

describe("resolveYahooConversationKey", () => {
  it("assigns distinct orphan keys to Message-ID-less messages in the same millisecond", async () => {
    const resolver = new InMemoryYahooConversationResolver(new Map());
    const input = {
      messageIdHeader: null,
      references: [],
      inReplyTo: null,
    };
    const first = await resolveYahooConversationKey(
      { ...input, providerMessageId: "42:11" },
      resolver,
    );
    const second = await resolveYahooConversationKey(
      { ...input, providerMessageId: "42:12" },
      resolver,
    );
    expect(first).toBe("orphan:42:11");
    expect(second).toBe("orphan:42:12");
    expect(first).not.toBe(second);
  });

  it("returns the same orphan key for the same provider message on a later pass", async () => {
    const resolver = new InMemoryYahooConversationResolver(new Map());
    const input = {
      providerMessageId: "99:5",
      messageIdHeader: null,
      references: [],
      inReplyTo: null,
    };
    const first = await resolveYahooConversationKey(input, resolver);
    const second = await resolveYahooConversationKey(input, resolver);
    expect(first).toBe("orphan:99:5");
    expect(second).toBe("orphan:99:5");
  });

  it("uses providerMessageId for ambiguous reference fallback without own Message-ID", () => {
    const aliasMap = new Map<string, string>([
      ["<a@mail>", "<a@mail>"],
      ["<b@mail>", "<b@mail>"],
    ]);
    const key = resolveYahooConversationKeySync(
      {
        providerMessageId: "42:7",
        messageIdHeader: null,
        references: ["<a@mail>", "<b@mail>"],
        inReplyTo: "<a@mail>",
      },
      aliasMap,
    );
    expect(key).toBe("orphan:42:7");
  });
});
