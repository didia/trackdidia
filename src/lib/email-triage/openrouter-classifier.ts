import {
  chatCompletion,
  DEFAULT_OPENROUTER_BASE_URL,
  OpenRouterHttpError,
} from "../ai/openrouter-client";
import type { EmailTriageClassifierProvider } from "./classifier";

export const createOpenRouterClassifierProvider = (
  baseUrl: string = DEFAULT_OPENROUTER_BASE_URL,
): EmailTriageClassifierProvider => ({
  async completeStructured({ apiKey, model, systemPrompt, userPrompt, timeoutMs, temperature }) {
    let text: string;
    try {
      ({ text } = await chatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
        timeoutMs,
        transport: "native",
      }));
    } catch (error) {
      if (error instanceof OpenRouterHttpError) {
        throw new Error("classifier_http_error");
      }
      throw error;
    }
    if (!text) {
      throw new Error("classifier_empty_response");
    }
    return text;
  },
});
