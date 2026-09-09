import { describe, expect, it } from "vitest";
import { MockGraphAdapter } from "./mock-graph";

describe("mock graph adapter", () => {
  it("paginates delta and stores delta link only after snapshot", async () => {
    const adapter = new MockGraphAdapter([
      {
        value: [
          {
            id: "m1",
            conversationId: "c1",
            receivedDateTime: "2026-01-02T10:00:00Z",
            subject: "New",
            from: { emailAddress: { address: "a@b.com" } },
            toRecipients: [{ emailAddress: { address: "me@example.com" } }],
            body: { content: "Hello" },
            categories: [],
            webLink: "https://outlook.example/m1",
          },
        ],
        nextLink: "next",
      },
      {
        value: [],
        deltaLink: "delta-token",
      },
    ]);
    const baselineAt = "2026-01-01T00:00:00Z";
    const first = await adapter.fetchPage({ baselineAt, pageIndex: 0 });
    expect(first.messages).toHaveLength(1);
    const second = await adapter.fetchPage({ baselineAt, pageIndex: 1 });
    expect(second.cursorUpdate?.deltaLink).toBe("delta-token");
    expect(second.cursorUpdate?.snapshotComplete).toBe(true);
  });

  it("invalid delta token triggers reseed state", async () => {
    const adapter = new MockGraphAdapter([], { invalidDeltaToken: true });
    const page = await adapter.fetchPage({
      baselineAt: "2026-01-01T00:00:00Z",
      deltaLink: "stale",
    });
    expect(page.gapDetected).toBe(true);
    expect(page.cursorUpdate?.deltaLink).toBeNull();
    expect(page.cursorUpdate?.baselineAt).toBeUndefined();
    expect(page.hasMore).toBe(true);
  });
});
