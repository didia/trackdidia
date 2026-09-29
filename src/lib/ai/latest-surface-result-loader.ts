import type { AiMessage, AiSurface } from "../../domain/types";
import type { AppRepository } from "../storage/repository";

export interface LoadLatestSurfaceResultOptions {
  surface: AiSurface;
  scopeKey: string;
  /**
   * When set, a stored row whose `promptVersion` does not match is treated as absent. Guards
   * against rendering a result shaped by an older prompt/schema as if it were current — see
   * docs/ai-settings-and-privacy.md.
   */
  promptVersion?: string;
  /** Defaults to `"ok"`: only a real AI (or local-fallback-persisted) success is hydrated. */
  status?: AiMessage["status"];
}

/**
 * Shared "latest cached surface result" lookup used by the weekly synthesis, monthly synthesis,
 * and goal pacing loaders. Finds the latest `AiMessage` row for `surface`/`scopeKey`/`status`,
 * rejects it if `promptVersion` is given and doesn't match, and hands the row to `toResult` for
 * surface-specific hydration (typically the owning service's `resultFromMessage`). Returns `null`
 * when there is no matching row, the prompt version is stale, or `toResult` itself returns `null`
 * (e.g. the stored `bodyJson` no longer parses).
 */
export const loadLatestSurfaceResult = async <R>(
  repository: AppRepository,
  options: LoadLatestSurfaceResultOptions,
  toResult: (message: AiMessage) => Promise<R | null>,
): Promise<R | null> => {
  const { surface, scopeKey, promptVersion, status = "ok" } = options;
  const latest = await repository.getLatestAiMessage(surface, scopeKey, status);

  if (!latest?.bodyJson) {
    return null;
  }

  if (promptVersion !== undefined && latest.promptVersion !== promptVersion) {
    return null;
  }

  return toResult(latest);
};
