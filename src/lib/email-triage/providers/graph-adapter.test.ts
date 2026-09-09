import { describe, expect, it, vi } from "vitest";
import { GraphAdapter } from "./graph-adapter";
import {
  GraphApiClient,
  type GraphDeltaPage,
  type GraphMessage,
} from "./graph-api";
import { ProviderHttpError } from "../provider-http";

const sampleMessage = (
  id: string,
  overrides: Partial<GraphMessage> = {},
): GraphMessage => ({
  id,
  conversationId: "conv-1",
  receivedDateTime: "2026-01-02T10:00:00.000Z",
  subject: "Hello",
  from: { emailAddress: { address: "sender@example.com" } },
  toRecipients: [{ emailAddress: { address: "me@example.com" } }],
  body: { contentType: "text", content: "Body" },
  categories: ["Personal"],
  webLink: "https://outlook.example/m1",
  internetMessageId: "<msg@example.com>",
  ...overrides,
});

const createFakeApi = (handlers: {
  fetchDeltaPage?: (url: string) => Promise<GraphDeltaPage>;
  getMessage?: (messageId: string) => Promise<GraphMessage & { "@odata.etag"?: string }>;
  patchMessageCategories?: (
    messageId: string,
    categories: string[],
    etag?: string,
  ) => Promise<void>;
  listMasterCategories?: () => Promise<Array<{ displayName: string }>>;
  createMasterCategory?: (displayName: string) => Promise<{ displayName: string }>;
  buildInitialDeltaUrl?: () => string;
}) => {
  const api = {
    fetchDeltaPage:
      handlers.fetchDeltaPage ??
      (async () => ({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/delta/final",
      })),
    getMessage: handlers.getMessage ?? (async (messageId: string) => sampleMessage(messageId)),
    patchMessageCategories: handlers.patchMessageCategories ?? (async () => undefined),
    listMasterCategories:
      handlers.listMasterCategories ?? (async () => [{ displayName: "Trackdidia-Inbox" }]),
    createMasterCategory:
      handlers.createMasterCategory ?? (async (displayName: string) => ({ displayName })),
    buildInitialDeltaUrl:
      handlers.buildInitialDeltaUrl ??
      (() => "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"),
  };
  return api as unknown as GraphApiClient;
};

describe("GraphAdapter", () => {
  it("records baselineAt without returning messages on first fetch", async () => {
    const adapter = new GraphAdapter(createFakeApi({}), () => []);
    const page = await adapter.fetchPage({});
    expect(page.messages).toEqual([]);
    expect(page.cursorUpdate?.baselineAt).toBeTruthy();
    expect(page.hasMore).toBe(true);
  });

  it("paginates snapshot pages and stores deltaLink only on the last snapshot page", async () => {
    const fetchDeltaPage = vi.fn(async (url: string): Promise<GraphDeltaPage> => {
      if (url.includes("next-page")) {
        return {
          value: [
            sampleMessage("m2", { receivedDateTime: "2026-01-02T11:00:00.000Z" }),
          ],
          "@odata.deltaLink": "https://graph.microsoft.com/delta/final",
        };
      }
      return {
        value: [
          sampleMessage("old", { receivedDateTime: "2025-12-31T10:00:00.000Z" }),
          sampleMessage("m1", { receivedDateTime: "2026-01-02T10:00:00.000Z" }),
        ],
        "@odata.nextLink": "https://graph.microsoft.com/next-page",
      };
    });
    const adapter = new GraphAdapter(createFakeApi({ fetchDeltaPage }), () => []);
    const baselineAt = "2026-01-01T00:00:00.000Z";
    const first = await adapter.fetchPage({
      baselineAt,
      snapshotComplete: false,
      trackedMessageIds: [],
    });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]?.providerMessageId).toBe("m1");
    expect(first.cursorUpdate?.deltaLink).toBeNull();
    expect(first.cursorUpdate?.nextLink).toBe("https://graph.microsoft.com/next-page");
    expect(first.hasMore).toBe(true);

    const second = await adapter.fetchPage({
      baselineAt,
      snapshotComplete: false,
      nextLink: "https://graph.microsoft.com/next-page",
      trackedMessageIds: ["m1"],
    });
    expect(second.messages).toHaveLength(1);
    expect(second.cursorUpdate?.deltaLink).toBe("https://graph.microsoft.com/delta/final");
    expect(second.cursorUpdate?.snapshotComplete).toBe(true);
    expect(second.accountPatch?.state).toBe("active");
    expect(second.accountPatch?.recoveryState).toBe("none");
    expect(second.hasMore).toBe(true);
  });

  it("drops pre-baseline messages on post-snapshot delta replay", async () => {
    const fetchDeltaPage = vi.fn(async (): Promise<GraphDeltaPage> => ({
      value: [
        sampleMessage("old-delta", { receivedDateTime: "2025-12-31T10:00:00.000Z" }),
        sampleMessage("new-delta", { receivedDateTime: "2026-01-03T10:00:00.000Z" }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/delta/caught-up",
    }));
    const adapter = new GraphAdapter(createFakeApi({ fetchDeltaPage }), () => []);
    const page = await adapter.fetchPage({
      baselineAt: "2026-01-01T00:00:00.000Z",
      snapshotComplete: true,
      deltaLink: "https://graph.microsoft.com/delta/final",
      trackedMessageIds: [],
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.providerMessageId).toBe("new-delta");
  });

  it("replays delta after snapshot until caught up", async () => {
    const fetchDeltaPage = vi.fn(async (url: string): Promise<GraphDeltaPage> => {
      if (url.includes("delta-replay-next")) {
        return {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/delta/caught-up",
        };
      }
      return {
        value: [sampleMessage("m3", { receivedDateTime: "2026-01-02T12:00:00.000Z" })],
        "@odata.nextLink": "https://graph.microsoft.com/delta-replay-next",
      };
    });
    const adapter = new GraphAdapter(createFakeApi({ fetchDeltaPage }), () => []);
    const replayStart = await adapter.fetchPage({
      baselineAt: "2026-01-01T00:00:00.000Z",
      snapshotComplete: true,
      deltaLink: "https://graph.microsoft.com/delta/final",
      trackedMessageIds: [],
    });
    expect(replayStart.hasMore).toBe(true);
    expect(replayStart.cursorUpdate?.nextLink).toBe("https://graph.microsoft.com/delta-replay-next");

    const caughtUp = await adapter.fetchPage({
      baselineAt: "2026-01-01T00:00:00.000Z",
      snapshotComplete: true,
      nextLink: "https://graph.microsoft.com/delta-replay-next",
      deltaLink: "https://graph.microsoft.com/delta/final",
      trackedMessageIds: ["m3"],
    });
    expect(caughtUp.hasMore).toBe(false);
    expect(caughtUp.cursorUpdate?.deltaLink).toBe("https://graph.microsoft.com/delta/caught-up");
  });

  it("invalid 410 delta starts reseed without keeping old deltaLink", async () => {
    const fetchDeltaPage = vi.fn(async () => {
      throw new ProviderHttpError("graph_delta_invalid", 410, "syncStateNotFound");
    });
    const adapter = new GraphAdapter(createFakeApi({ fetchDeltaPage }), () => []);
    const page = await adapter.fetchPage({
      baselineAt: "2026-01-01T00:00:00.000Z",
      snapshotComplete: true,
      deltaLink: "https://graph.microsoft.com/delta/stale",
      trackedMessageIds: [],
    });
    expect(page.cursorUpdate?.deltaLink).toBeNull();
    expect(page.cursorUpdate?.nextLink).toBeNull();
    expect(page.cursorUpdate?.baselineAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(page.hasMore).toBe(true);
    expect(page.gapDetected).toBe(false);
    expect(page.accountPatch?.recoveryState).toBe("delta_invalid");
  });

  it("rethrows transient snapshot failures so the same nextLink can retry", async () => {
    const fetchDeltaPage = vi.fn(async () => {
      throw new Error("network_failure");
    });
    const adapter = new GraphAdapter(createFakeApi({ fetchDeltaPage }), () => []);
    await expect(
      adapter.fetchPage({
        baselineAt: "2026-01-01T00:00:00.000Z",
        snapshotComplete: false,
        nextLink: "https://graph.microsoft.com/next-page",
        trackedMessageIds: [],
      }),
    ).rejects.toThrow("network_failure");
  });

  it("applies relevant category and preserves unrelated categories", async () => {
    const patch = vi.fn(async () => undefined);
    const adapter = new GraphAdapter(
      createFakeApi({
        patchMessageCategories: patch,
        getMessage: async () => sampleMessage("m1", { categories: ["Personal"] }),
        listMasterCategories: async () => [],
        createMasterCategory: async (displayName) => ({ displayName }),
      }),
      () => ["m1"],
    );
    await adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" });
    expect(patch).toHaveBeenCalledWith("m1", ["Personal", "Trackdidia-Inbox"], undefined);
  });

  it("applies ignore base and reason categories with colon separator", async () => {
    const patch = vi.fn(async () => undefined);
    const adapter = new GraphAdapter(
      createFakeApi({
        patchMessageCategories: patch,
        getMessage: async () => sampleMessage("m1"),
        listMasterCategories: async () => [],
        createMasterCategory: async (displayName) => ({ displayName }),
      }),
      () => ["m1"],
    );
    await adapter.applyMarkers({
      messageIds: ["m1"],
      decision: "ignore",
      ignoreReason: "newsletter",
    });
    expect(patch).toHaveBeenCalledWith(
      "m1",
      ["Personal", "Trackdidia-Triage-Ignore", "Trackdidia-Triage-Ignore:newsletter"],
      undefined,
    );
  });

  it("retries marker application after concurrency conflict refetch", async () => {
    const patch = vi
      .fn()
      .mockRejectedValueOnce(new ProviderHttpError("category_concurrency_conflict", 412, ""))
      .mockResolvedValueOnce(undefined);
    const adapter = new GraphAdapter(
      createFakeApi({
        patchMessageCategories: patch,
        getMessage: async () => sampleMessage("m1", { categories: ["Personal"] }),
        listMasterCategories: async () => [{ displayName: "Trackdidia-Inbox" }],
      }),
      () => ["m1"],
    );
    await adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" });
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it("refuses marker application for untracked message ids", async () => {
    const adapter = new GraphAdapter(createFakeApi({}), () => []);
    await expect(
      adapter.applyMarkers({ messageIds: ["m1"], decision: "relevant" }),
    ).rejects.toThrow(/untracked_message_id/);
  });
});
