import type { CoachMessage } from "../../domain/types";
import type { AiPromptContext, AiProvider } from "./provider";

const extractResponseText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text.trim();
  }

  if (Array.isArray(record.output)) {
    const fragments = record.output.flatMap((item) => {
      if (typeof item !== "object" || item === null) {
        return [];
      }

      const outputItem = item as Record<string, unknown>;
      if (!Array.isArray(outputItem.content)) {
        return [];
      }

      return outputItem.content.flatMap((contentItem) => {
        if (typeof contentItem !== "object" || contentItem === null) {
          return [];
        }

        const contentRecord = contentItem as Record<string, unknown>;
        if (typeof contentRecord.text === "string") {
          return [contentRecord.text];
        }

        return [];
      });
    });

    return fragments.join("\n").trim();
  }

  return "";
};

export class OpenAiProvider implements AiProvider {
  async generate(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string> {
    const url = `${context.settings.aiBaseUrl.replace(/\/$/, "")}/responses`;

    const systemPrompt =
      kind === "morning"
        ? "Tu es un coach de discipline doux, clair et concret. Reponds en francais avec un paragraphe court pour ouvrir la journee."
        : "Tu es un coach de discipline doux, clair et concret. Reponds en francais avec un paragraphe court pour aider a cloturer la journee.";

    const payload = {
      model: context.settings.aiModel,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                today: context.entry,
                recentEntries: context.recentEntries.slice(0, 7)
              })
            }
          ]
        }
      ]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.settings.aiApiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const body = await response.json();
    const text = extractResponseText(body);
    if (!text) {
      throw new Error("AI response did not contain usable text");
    }

    return text;
  }
}

