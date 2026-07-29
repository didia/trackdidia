import type { CoachMessage } from "../../domain/types";
import type { AiPromptContext, AiProvider } from "./provider";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "moonshotai/kimi-k2.6";

/** Strip accidental endpoint suffixes so settings can be a bare API root. */
export const normalizeAiBaseUrl = (rawUrl: string): string => {
  let base = rawUrl.trim().replace(/\/+$/, "");
  base = base.replace(/\/(chat\/completions|responses)$/i, "");
  return base || DEFAULT_OPENROUTER_BASE_URL;
};

const extractChatCompletionText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    return "";
  }

  const firstChoice = record.choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) {
    return "";
  }

  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return "";
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content.trim();
  }

  return "";
};

const readErrorDetail = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } };
    if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
  } catch {
    // Ignore parse failures; status code is enough.
  }

  return `AI request failed with status ${response.status}`;
};

export class OpenRouterProvider implements AiProvider {
  async generate(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string> {
    const baseUrl = normalizeAiBaseUrl(context.settings.aiBaseUrl);
    const url = `${baseUrl}/chat/completions`;

    const systemPrompt =
      kind === "morning"
        ? "Tu es un coach de discipline doux, clair et concret. Reponds en francais avec un paragraphe court pour ouvrir la journee. Tiens compte du fuseau horaire et du moment de la journee fournis."
        : "Tu es un coach de discipline doux, clair et concret. Reponds en francais avec un paragraphe court pour aider a cloturer la journee. Tiens compte du fuseau horaire et du moment de la journee fournis.";

    const payload = {
      model: context.settings.aiModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            timeZone: context.timeZone,
            partOfDay: context.partOfDay,
            currentPartOfDay: context.currentPartOfDay,
            inputContent: context.inputContent,
            today: context.entry,
            recentEntries: context.recentEntries.slice(0, 7)
          })
        }
      ]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.settings.aiApiKey}`,
        "HTTP-Referer": "https://trackdidia.app",
        "X-Title": "Trackdidia"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(await readErrorDetail(response));
    }

    const body = await response.json();
    const text = extractChatCompletionText(body);
    if (!text) {
      throw new Error("AI response did not contain usable text");
    }

    return text;
  }
}
