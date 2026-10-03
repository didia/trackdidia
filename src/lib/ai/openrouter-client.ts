import { providerHttpRequest } from "../email-triage/provider-http";
import { createTimeoutController, toTimeoutError } from "../http/timeout";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Strip accidental endpoint suffixes so settings can be a bare API root. */
export const normalizeAiBaseUrl = (rawUrl: string): string => {
  let base = rawUrl.trim().replace(/\/+$/, "");
  base = base.replace(/\/(chat\/completions|responses)$/i, "");
  return base || DEFAULT_OPENROUTER_BASE_URL;
};

export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
  timeoutMs: number;
  retry?: boolean;
  transport: "fetch" | "native";
}

export interface ChatCompletionResult {
  text: string;
  usage: { tokensPrompt: number; tokensCompletion: number };
  finishReasons: string[];
}

export class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
}

const firstChoiceRecord = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
};

export const extractChatCompletionText = (payload: unknown): string => {
  const message = firstChoiceRecord(payload)?.message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content.trim() : "";
};

const extractFinishReasons = (payload: unknown): string[] => {
  const first = firstChoiceRecord(payload);
  if (!first) return [];
  return [first.finish_reason, first.native_finish_reason]
    .filter((reason): reason is string => typeof reason === "string" && Boolean(reason.trim()))
    .map((reason) => reason.trim());
};

const extractUsage = (payload: unknown): ChatCompletionResult["usage"] => {
  if (typeof payload !== "object" || payload === null)
    return { tokensPrompt: 0, tokensCompletion: 0 };
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return { tokensPrompt: 0, tokensCompletion: 0 };
  const record = usage as Record<string, unknown>;
  return {
    tokensPrompt: typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0,
    tokensCompletion: typeof record.completion_tokens === "number" ? record.completion_tokens : 0,
  };
};

const errorDetail = (body: unknown, status: number): string => {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return `AI request failed with status ${status}`;
};

const shouldRetry = (status: number): boolean => status === 429 || status >= 500;
const pauseBeforeRetry = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

const requestOnce = async (request: ChatCompletionRequest): Promise<ChatCompletionResult> => {
  const url = `${normalizeAiBaseUrl(request.baseUrl)}/chat/completions`;
  const payload = {
    model: request.model,
    temperature: request.temperature,
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    messages: request.messages,
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${request.apiKey}`,
    "HTTP-Referer": "https://trackdidia.app",
    "X-Title": "Trackdidia",
    Accept: "application/json",
  };
  let body: unknown;
  if (request.transport === "native") {
    const response = await providerHttpRequest({
      method: "POST",
      url,
      headers,
      body: JSON.stringify(payload),
      timeoutMs: request.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new OpenRouterHttpError(
        errorDetail(parseOptionalJson(response.body), response.status),
        response.status,
      );
    }
    body = JSON.parse(response.body);
  } else {
    const timeout = createTimeoutController(request.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: timeout.signal,
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        let detail: unknown;
        try {
          detail = await response.json();
        } catch {
          /* status is enough */
        }
        throw new OpenRouterHttpError(errorDetail(detail, response.status), response.status);
      }
      body = await response.json();
    } finally {
      timeout.clear();
    }
  }
  return {
    text: extractChatCompletionText(body),
    usage: extractUsage(body),
    finishReasons: extractFinishReasons(body),
  };
};

const parseOptionalJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

export const chatCompletion = async (
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> => {
  const attempts = request.retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestOnce(request);
    } catch (error) {
      const normalized =
        error instanceof OpenRouterHttpError
          ? error
          : toTimeoutError(
              error,
              "AI request timed out.",
              "AI request failed.",
              request.transport === "native",
            );
      const retryable =
        normalized.message === "AI request timed out." ||
        (error instanceof OpenRouterHttpError && shouldRetry(error.status));
      if (attempt + 1 < attempts && retryable) {
        await pauseBeforeRetry();
        continue;
      }
      throw normalized;
    }
  }
  throw new Error("AI request failed.");
};
