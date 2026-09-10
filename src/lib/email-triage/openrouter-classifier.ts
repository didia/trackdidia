import { DEFAULT_OPENROUTER_BASE_URL, normalizeAiBaseUrl } from "../ai/openrouter-provider";
import type { EmailTriageClassifierProvider } from "./classifier";
import { providerHttpRequest } from "./provider-http";

const extractChatCompletionText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    return "";
  }
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content.trim() : "";
};

export const createOpenRouterClassifierProvider = (
  baseUrl: string = DEFAULT_OPENROUTER_BASE_URL,
): EmailTriageClassifierProvider => ({
  async completeStructured({ apiKey, model, systemPrompt, userPrompt, timeoutMs, temperature }) {
    const endpoint = `${normalizeAiBaseUrl(baseUrl)}/chat/completions`;
    const response = await providerHttpRequest({
      method: "POST",
      url: endpoint,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error("classifier_http_error");
    }
    const text = extractChatCompletionText(JSON.parse(response.body));
    if (!text) {
      throw new Error("classifier_empty_response");
    }
    return text;
  },
});
