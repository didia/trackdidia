import { chatCompletion, type ChatCompletionRequest } from "./openrouter-client";

const request: ChatCompletionRequest = {
  baseUrl: "https://openrouter.ai/api/v1/chat/completions/",
  apiKey: "test-key",
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.4,
  timeoutMs: 20_000,
  transport: "fetch",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared OpenRouter client", () => {
  it("parses usage and both finish reasons, normalizes the endpoint, and omits optional payload fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: { content: "  result  " },
            finish_reason: "stop",
            native_finish_reason: "  done  ",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatCompletion(request)).resolves.toEqual({
      text: "result",
      usage: { tokensPrompt: 4, tokensCompletion: 5 },
      finishReasons: ["stop", "done"],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "test-model",
      temperature: 0.4,
      messages: request.messages,
    });
  });

  it.each([
    null,
    {},
    { choices: [] },
    { choices: [null] },
    { choices: [{ message: { content: [] } }] },
  ])("returns empty text and zero usage for unusable response %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(chatCompletion(request)).resolves.toEqual({
      text: "",
      usage: { tokensPrompt: 0, tokensCompletion: 0 },
      finishReasons: [],
    });
  });

  it.each([429, 500, 503])("retries status %i once when requested", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "temporary" } }, { status }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = chatCompletion({ ...request, retry: true });
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight request and clears its timer without retry by default", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rejection = expect(chatCompletion({ ...request, timeoutMs: 50 })).rejects.toThrow(
      "AI request timed out.",
    );
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
