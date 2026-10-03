import type {
  AiMessage,
  AiProposal,
  AiSurface,
  AppSettings,
  CoachPulseStance,
} from "../../domain/types";
import { t } from "../../i18n";
import { createEntityId } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import type { AiProvider, AiStructuredRequest, AiUsage } from "./provider";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type SurfaceSource = "ai" | "cache" | "fallback" | "local";
export interface StructuredSurfaceResult<T> {
  message: AiMessage | null;
  response: T;
  proposals: AiProposal[];
  source: SurfaceSource;
  warning?: string;
}
type PersistedSurfaceResult<T> = StructuredSurfaceResult<T> & { message: AiMessage };

export const sumUsage = (a: AiUsage, b: AiUsage): AiUsage => ({
  tokensPrompt: a.tokensPrompt + b.tokensPrompt,
  tokensCompletion: a.tokensCompletion + b.tokensCompletion,
  latencyMs: a.latencyMs + b.latencyMs,
});

export const sourceFromStatus = (
  status: AiMessage["status"],
  { cached = false }: { cached?: boolean } = {},
): SurfaceSource =>
  status === "ok" ? (cached ? "cache" : "ai") : status === "fallback" ? "fallback" : "local";

interface StructuredSurfaceOptions<T> {
  repository: AppRepository;
  provider: AiProvider;
  settings: AppSettings;
  surface: AiSurface;
  scopeKey: string;
  kind: string;
  stance?: CoachPulseStance | null;
  deltaClass?: AiMessage["deltaClass"];
  promptVersion: string;
  inputHash: string;
  createdAt: string;
  request: (repairHint?: string) => AiStructuredRequest;
  parse: (text: string) => ParseResult<T>;
  localFallback: T;
  toBodyText: (response: T) => string;
  buildProposals?: (messageId: string, response: T, createdAt: string) => AiProposal[];
  cachedResult?: (message: AiMessage) => Promise<{ response: T; proposals: AiProposal[] } | null>;
  bypassCache?: boolean;
  /** Pastor is date-sticky via its loader; coach only reuses successful AI episodes. */
  cachePolicy?: "configured" | "ok-only" | "none";
  reuseMessageId?: boolean;
  shouldCallProvider?: boolean;
  localStatus?: "skipped" | "local";
  persistLocal?: boolean;
  persistFallback?: boolean;
  /** Pastor stores the validated body; other surfaces retain the provider's raw JSON. */
  serializeResponse?: (response: T, rawText: string) => string;
  model?: string;
  /** Runs on persisted and cached outcomes, but not ephemeral local paint. */
  finalize?: () => Promise<void>;
}

export function runStructuredSurface<T>(
  options: StructuredSurfaceOptions<T> & { persistFallback?: true },
): Promise<PersistedSurfaceResult<T>>;
export function runStructuredSurface<T>(
  options: StructuredSurfaceOptions<T>,
): Promise<StructuredSurfaceResult<T>>;
export async function runStructuredSurface<T>(
  options: StructuredSurfaceOptions<T>,
): Promise<StructuredSurfaceResult<T>> {
  const {
    repository,
    provider,
    settings,
    surface,
    scopeKey,
    inputHash,
    localFallback,
    parse,
    toBodyText,
    request,
    cachePolicy = "configured",
    bypassCache = false,
  } = options;
  const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  if (!bypassCache && cachePolicy !== "none") {
    const message =
      aiConfigured || cachePolicy === "ok-only"
        ? await repository.getAiMessage(surface, scopeKey, inputHash)
        : await repository.getAiMessageRecord(surface, scopeKey, inputHash);
    if (message && (aiConfigured || cachePolicy === "ok-only" || message.status === "skipped")) {
      const cached = options.cachedResult
        ? await options.cachedResult(message)
        : await (async () => {
            if (!message.bodyJson) return null;
            const parsed = parse(message.bodyJson);
            return parsed.ok
              ? { response: parsed.value, proposals: await repository.listAiProposals(message.id) }
              : null;
          })();
      if (cached) {
        await options.finalize?.();
        return { message, ...cached, source: "cache" };
      }
    }
  }

  const existing = options.reuseMessageId
    ? await repository.getAiMessageRecord(surface, scopeKey, inputHash)
    : null;
  const baseMessage = (): AiMessage => ({
    id: existing?.id ?? createEntityId("ai-message"),
    surface,
    scopeKey,
    stance: options.stance ?? null,
    kind: options.kind,
    inputHash,
    promptVersion: options.promptVersion,
    model: options.model ?? settings.aiSurfaceModels[surface] ?? settings.aiModel,
    status: "ok",
    bodyJson: JSON.stringify(localFallback),
    bodyText: toBodyText(localFallback),
    deltaClass: options.deltaClass ?? null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: options.createdAt,
  });
  const persist = async (message: AiMessage, response: T): Promise<PersistedSurfaceResult<T>> => {
    const proposals = options.buildProposals?.(message.id, response, message.createdAt) ?? [];
    const saved = await repository.saveCoachPulseEpisode(message, proposals);
    await options.finalize?.();
    return {
      message: saved.message,
      response,
      proposals: saved.proposals,
      source: sourceFromStatus(message.status),
    };
  };
  if (!(options.shouldCallProvider ?? aiConfigured)) {
    const message = { ...baseMessage(), status: options.localStatus ?? "skipped", model: "local" };
    if (options.persistLocal === false)
      return { message, response: localFallback, proposals: [], source: "local" };
    return persist(message, localFallback);
  }

  try {
    const first = await provider.generateStructured(request());
    let parsed = parse(first.text);
    let finalText = first.text;
    let usage = first.usage;
    let model = first.model;
    if (!parsed.ok) {
      const repair = await provider.generateStructured(request(parsed.error));
      parsed = parse(repair.text);
      finalText = repair.text;
      usage = sumUsage(usage, repair.usage);
      model = repair.model;
    }
    if (!parsed.ok) {
      if (options.persistFallback === false)
        return {
          message: null,
          response: localFallback,
          proposals: [],
          source: "fallback",
          warning: parsed.error,
        };
      const result = await persist(
        {
          ...baseMessage(),
          status: "fallback",
          model,
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs,
        },
        localFallback,
      );
      return { ...result, warning: parsed.error };
    }
    return await persist(
      {
        ...baseMessage(),
        model,
        bodyJson: options.serializeResponse?.(parsed.value, finalText) ?? finalText,
        bodyText: toBodyText(parsed.value),
        tokensPrompt: usage.tokensPrompt,
        tokensCompletion: usage.tokensCompletion,
        latencyMs: usage.latencyMs,
      },
      parsed.value,
    );
  } catch (error) {
    const warning =
      error instanceof Error ? error.message : t("aiGenerationFailed", { ns: "common" });
    if (options.persistFallback === false)
      return { message: null, response: localFallback, proposals: [], source: "fallback", warning };
    // Preserve the original policy: exceptions record no usage and the configured model,
    // even if a first response arrived before a repair or persistence failure.
    const result = await persist({ ...baseMessage(), status: "fallback" }, localFallback);
    return { ...result, warning };
  }
}
