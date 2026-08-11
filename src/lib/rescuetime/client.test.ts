import { HttpRescueTimeClient } from "./client";

describe("HttpRescueTimeClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the Analytic Data API with bearer auth and week bounds", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 3600, "Software Development"]]
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new HttpRescueTimeClient();
    const payload = await client.fetchAnalyticData("rt-test-key", {
      kind: "category",
      begin: "2026-08-03",
      end: "2026-08-09"
    });

    expect(payload.rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    const urlText = String(url);
    expect(urlText).toContain("https://www.rescuetime.com/anapi/data");
    expect(urlText).toContain("restrict_kind=category");
    expect(urlText).toContain("restrict_begin=2026-08-03");
    expect(urlText).toContain("restrict_end=2026-08-09");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer rt-test-key");
  });

  it("surfaces RescueTime error responses", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 })
    ) as typeof fetch;

    const client = new HttpRescueTimeClient();

    await expect(
      client.fetchAnalyticData("bad-key", {
        kind: "category",
        begin: "2026-08-03",
        end: "2026-08-09"
      })
    ).rejects.toThrow("RescueTime API 401");
  });
});
