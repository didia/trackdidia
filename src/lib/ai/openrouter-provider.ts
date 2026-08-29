import type { AppSettings, AiSurface } from "../../domain/types";
import type { CoachMessage } from "../../domain/types";
import type { AiPromptContext, AiProvider, AiStructuredRequest, AiStructuredResult } from "./provider";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "moonshotai/kimi-k2.6";
export const DEFAULT_AI_TEMPERATURE = 0.4;

/** Strip accidental endpoint suffixes so settings can be a bare API root. */
export const normalizeAiBaseUrl = (rawUrl: string): string => {
  let base = rawUrl.trim().replace(/\/+$/, "");
  base = base.replace(/\/(chat\/completions|responses)$/i, "");
  return base || DEFAULT_OPENROUTER_BASE_URL;
};

const createTimeoutController = (timeoutMs: number): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timeoutId);
    }
  };
};

const toTimeoutError = (error: unknown): Error => {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : "";

  if (name === "AbortError" || /aborted|timed out/i.test(message)) {
    return new Error("AI request timed out.");
  }

  return error instanceof Error ? error : new Error("AI request failed.");
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

const extractUsage = (payload: unknown): { tokensPrompt: number; tokensCompletion: number } => {
  if (typeof payload !== "object" || payload === null) {
    return { tokensPrompt: 0, tokensCompletion: 0 };
  }

  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) {
    return { tokensPrompt: 0, tokensCompletion: 0 };
  }

  const record = usage as Record<string, unknown>;
  return {
    tokensPrompt: typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0,
    tokensCompletion: typeof record.completion_tokens === "number" ? record.completion_tokens : 0
  };
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

const shouldRetryStatus = (status: number): boolean => status === 429 || status >= 500;

const resolveModel = (settings: AppSettings, surface: AiSurface): string =>
  settings.aiSurfaceModels[surface]?.trim() || settings.aiModel;

const buildSystemPrompt = (stance: AiStructuredRequest["stance"], repairHint?: string): string => {
  const stanceInstruction =
    stance === "open"
      ? "Tu es un coach de discipline pour l'ouverture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse."
      : stance === "close"
        ? "Tu es un coach de discipline pour la cloture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse."
        : "Tu es un coach de discipline. Reponds en francais avec un JSON strict conforme au schema coach_pulse.";

  if (!repairHint) {
    return stanceInstruction;
  }

  return `${stanceInstruction}\n\nCorrection demandee: ${repairHint}`;
};

export class OpenRouterProvider implements AiProvider {
  /** @deprecated Legacy morning/evening free-text coach. */
  async generate(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string> {
    const result = await this.generateStructured({
      surface: "coach_pulse",
      stance: kind === "morning" ? "open" : "close",
      settings: context.settings,
      snapshot: {
        surface: "daily",
        scope: context.settings.aiPayloadScope,
        date: context.entry.date,
        status: context.entry.status,
        metrics: [],
        principles: [],
        notes: {
          morningIntention: context.entry.morningIntention,
          nightReflection: context.entry.nightReflection,
          tomorrowFocus: context.entry.tomorrowFocus
        },
        gtd: {
          inboxBacklog: 0,
          projectsWithoutNextAction: 0,
          projectsWithoutNextActionSample: [],
          staleNextActions: 0,
          agingWaitingFor: 0,
          overdueDeadlines: 0,
          scheduledVsCompletedRatio: 0
        },
        pomodoro: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null
        },
        rescueTime: { configured: false, productivityPulseWeekToDate: null },
        history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
        weeklyScoreTrend: null,
        findings: []
      }
    });

    try {
      const parsed = JSON.parse(result.text) as { read?: string; headline?: string };
      if (typeof parsed.read === "string" && parsed.read.trim()) {
        return parsed.read.trim();
      }
      if (typeof parsed.headline === "string" && parsed.headline.trim()) {
        return parsed.headline.trim();
      }
    } catch {
      // Fall through to raw text.
    }

    return result.text;
  }

  async generateStructured(request: AiStructuredRequest): Promise<AiStructuredResult> {
    const startedAt = Date.now();
    const baseUrl = normalizeAiBaseUrl(request.settings.aiBaseUrl);
    const url = `${baseUrl}/chat/completions`;
    const model = resolveModel(request.settings, request.surface);
    const timeoutMs = request.settings.aiTimeoutMs;

    const payload = {
      model,
      temperature: DEFAULT_AI_TEMPERATURE,
      max_tokens: request.settings.aiMaxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(request.stance, request.repairHint)
        },
        {
          role: "user",
          content: JSON.stringify({
            surface: request.surface,
            stance: request.stance,
            snapshot: request.snapshot
          })
        }
      ]
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeout = createTimeoutController(timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          signal: timeout.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${request.settings.aiApiKey}`,
            "HTTP-Referer": "https://trackdidia.app",
            "X-Title": "Trackdidia"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const detail = await readErrorDetail(response);
          if (attempt === 0 && shouldRetryStatus(response.status)) {
            lastError = new Error(detail);
            await new Promise((resolve) => {
              setTimeout(resolve, 500);
            });
            continue;
          }

          throw new Error(detail);
        }

        const body = await response.json();
        const text = extractChatCompletionText(body);
        if (!text) {
          throw new Error("AI response did not contain usable text");
        }

        const usage = extractUsage(body);
        return {
          text,
          model,
          usage: {
            tokensPrompt: usage.tokensPrompt,
            tokensCompletion: usage.tokensCompletion,
            latencyMs: Date.now() - startedAt
          }
        };
      } catch (error) {
        const normalized = toTimeoutError(error);
        if (attempt === 0 && /timed out/i.test(normalized.message)) {
          lastError = normalized;
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
          continue;
        }

        throw normalized;
      } finally {
        timeout.clear();
      }
    }

    throw lastError ?? new Error("AI request failed.");
  }
}
