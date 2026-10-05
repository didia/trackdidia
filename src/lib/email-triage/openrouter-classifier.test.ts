import { invoke } from "@tauri-apps/api/core";
import { createOpenRouterClassifierProvider } from "./openrouter-classifier";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../storage/factory", () => ({ isTauriRuntime: () => true }));

const invokeMock = vi.mocked(invoke);
const request = {
  apiKey: "test-key",
  model: "test-model",
  systemPrompt: "system",
  userPrompt: "user",
  timeoutMs: 1234,
  temperature: 0.2,
};

afterEach(() => invokeMock.mockReset());

describe("OpenRouter classifier", () => {
  it("uses the shared response parser through the native transport", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '  {"label":"inbox"}  ' } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    });

    await expect(createOpenRouterClassifierProvider().completeStructured(request)).resolves.toBe(
      '{"label":"inbox"}',
    );
    expect(invokeMock).toHaveBeenCalledOnce();
    const [command, args] = invokeMock.mock.calls[0] as [
      string,
      { request: Record<string, unknown> },
    ];
    expect(command).toBe("provider_http_request");
    expect(args.request).toMatchObject({
      method: "POST",
      url: "https://openrouter.ai/api/v1/chat/completions",
      timeoutMs: 1234,
      headers: {
        Authorization: "Bearer test-key",
        "HTTP-Referer": "https://trackdidia.app",
        "X-Title": "Trackdidia",
      },
    });
    expect(JSON.parse(String(args.request.body))).toEqual({
      model: "test-model",
      temperature: 0.2,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
    });
  });

  it("preserves classifier errors for HTTP failures and empty choices without retry", async () => {
    invokeMock.mockResolvedValueOnce({ status: 429, body: '{"error":{"message":"rate limited"}}' });
    await expect(createOpenRouterClassifierProvider().completeStructured(request)).rejects.toThrow(
      "classifier_http_error",
    );
    expect(invokeMock).toHaveBeenCalledOnce();

    invokeMock.mockResolvedValueOnce({
      status: 200,
      body: '{"choices":[{"message":{"content":"  "}}]}',
    });
    await expect(createOpenRouterClassifierProvider().completeStructured(request)).rejects.toThrow(
      "classifier_empty_response",
    );
  });
});
