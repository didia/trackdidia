// AI categorization for unknown finance merchants — see specs/done/finance.md "AI stage" and
// docs/ai-settings-and-privacy.md. Mirrors `GoalPacingService`'s cache/repair/persist shape, but
// operates over one or more request-sized chunks (see `buildFinanceCategorizationSnapshots`)
// instead of a single snapshot, and applies results to the database afterwards via
// `AppRepository.applyFinanceCategorizationResults` rather than just rendering a card.
//
// Gating (the three flags from specs/done/finance.md "AI stage"): `financeAiCategorizationEnabled`
// off means `classifyPending` does nothing at all — no repository read, no AI call, no write.
// With it on but `aiEnabled`/`aiApiKey` unset, every chunk is persisted with `status: "skipped"`
// and no categorization happens (stages 1-5 of `classify.ts` still work — this surface only adds
// a 6th stage). `aiPayloadScope === "metrics"` also disables the stage entirely, matching
// `buildFinanceCategorizationSnapshots`.

import type { AiMessage, AppSettings, FinanceCategorizationResponse } from "../../domain/types";
import type { ApplyFinanceCategorizationResultsOutcome } from "../../domain/finance";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import {
  buildFinanceCategorizationSnapshots,
  type FinanceCategorizationSnapshotChunk,
} from "./context/finance-categorization-snapshot";
import { buildAiInputHash } from "./input-hash";
import { parseFinanceCategorizationJson } from "./proposals/finance-categorization-validator";
import type { AiProvider } from "./provider";

export const FINANCE_CATEGORIZATION_PROMPT_VERSION = "finance_categorization.v1";

export interface FinanceCategorizationRunResult extends ApplyFinanceCategorizationResultsOutcome {
  /** False when the surface is disabled (`financeAiCategorizationEnabled` off) — nothing ran. */
  ran: boolean;
  chunksProcessed: number;
  /** Merchants in the built snapshot(s), whether or not a provider request was needed. */
  merchantsRequested: number;
  /** Merchants actually sent to the provider (cache hits and unconfigured AI send nothing). */
  merchantsSent: number;
  warning?: string;
}

const ZERO_OUTCOME: ApplyFinanceCategorizationResultsOutcome = {
  suggestionsCreated: 0,
  autoApplied: 0,
  suppressedDismissed: 0,
};

const emptyResponse: FinanceCategorizationResponse = { merchants: [] };

export class FinanceCategorizationService {
  constructor(private readonly provider: AiProvider) {}

  /**
   * Lists unknown merchants, builds the (possibly multi-chunk) sanitized snapshot, classifies
   * each chunk (cache -> AI with one repair round-trip -> fallback), and applies every result in
   * a short exclusive block per chunk. The AI call itself always happens between
   * `listFinanceUnknownMerchants` (a plain read) and `applyFinanceCategorizationResults` (a
   * short write) — never inside a `DbSerialQueue`/`BEGIN IMMEDIATE` slot.
   */
  async classifyPending(
    repository: AppRepository,
    settings: AppSettings,
    options: { bypassCache?: boolean } = {},
  ): Promise<FinanceCategorizationRunResult> {
    if (!settings.financeAiCategorizationEnabled || settings.aiPayloadScope === "metrics") {
      return {
        ran: false,
        chunksProcessed: 0,
        merchantsRequested: 0,
        merchantsSent: 0,
        ...ZERO_OUTCOME,
      };
    }

    const unknownMerchants = await repository.listFinanceUnknownMerchants(400);
    if (unknownMerchants.length === 0) {
      return {
        ran: true,
        chunksProcessed: 0,
        merchantsRequested: 0,
        merchantsSent: 0,
        ...ZERO_OUTCOME,
      };
    }

    const categories = await repository.listFinanceCategories();
    const allowedCategories = categories
      .filter((category) => !category.archived && !category.isSystem)
      .map((category) => ({ id: category.id, name: category.name }));

    const chunks = buildFinanceCategorizationSnapshots(
      { unknownMerchants, allowedCategories, baseCurrency: settings.financeBaseCurrency },
      settings.aiPayloadScope,
    );
    if (chunks.length === 0) {
      return {
        ran: true,
        chunksProcessed: 0,
        merchantsRequested: 0,
        merchantsSent: 0,
        ...ZERO_OUTCOME,
      };
    }

    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
    const bypassCache = options.bypassCache ?? false;

    let suggestionsCreated = 0;
    let autoApplied = 0;
    let suppressedDismissed = 0;
    let merchantsRequested = 0;
    let merchantsSent = 0;
    let warning: string | undefined;

    for (const chunk of chunks) {
      merchantsRequested += chunk.snapshot.merchants.length;
      const outcome = await this.runChunk(repository, settings, chunk, aiConfigured, bypassCache);
      suggestionsCreated += outcome.suggestionsCreated;
      autoApplied += outcome.autoApplied;
      suppressedDismissed += outcome.suppressedDismissed;
      if (outcome.sent) {
        merchantsSent += chunk.snapshot.merchants.length;
      }
      if (outcome.warning) {
        warning = outcome.warning;
      }
    }

    return {
      ran: true,
      chunksProcessed: chunks.length,
      merchantsRequested,
      merchantsSent,
      suggestionsCreated,
      autoApplied,
      suppressedDismissed,
      warning,
    };
  }

  private async runChunk(
    repository: AppRepository,
    settings: AppSettings,
    chunk: FinanceCategorizationSnapshotChunk,
    aiConfigured: boolean,
    bypassCache: boolean,
  ): Promise<ApplyFinanceCategorizationResultsOutcome & { warning?: string; sent?: boolean }> {
    const allowedCategoryIds = new Set(
      chunk.snapshot.allowedCategories.map((category) => category.id),
    );
    const allowedMerchantKeys = new Set(
      chunk.snapshot.merchants.map((merchant) => merchant.merchantKey),
    );
    const inputHash = buildAiInputHash({
      promptVersion: FINANCE_CATEGORIZATION_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot: chunk.snapshot,
    });
    const scopeKey = inputHash;
    const createdAt = nowIso();

    const applyParsed = async (
      parsed: FinanceCategorizationResponse,
      model: string,
      promptVersion: string,
    ): Promise<ApplyFinanceCategorizationResultsOutcome> => {
      if (parsed.merchants.length === 0) {
        return ZERO_OUTCOME;
      }
      return repository.applyFinanceCategorizationResults({
        results: parsed.merchants,
        merchantKeyMap: chunk.merchantKeyMap,
        transactionIds: chunk.transactionIds,
        model,
        promptVersion,
        autoApply: settings.financeAiAutoApplyEnabled,
        autoApplyMinConfidence: settings.financeAiAutoApplyMinConfidence,
      });
    };

    if (!bypassCache) {
      if (aiConfigured) {
        const cached = await repository.getAiMessage("finance_categorization", scopeKey, inputHash);
        if (cached?.bodyJson) {
          const parsed = parseFinanceCategorizationJson(
            cached.bodyJson,
            allowedCategoryIds,
            allowedMerchantKeys,
          );
          if (parsed.ok) {
            const outcome = await applyParsed(parsed.value, cached.model, cached.promptVersion);
            // A cached answer that only collides with dismissed suggestions would stay stuck
            // (same snapshot -> same hash -> same answer), so treat it as a cache miss.
            if (outcome.suggestionsCreated > 0 || outcome.suppressedDismissed === 0) {
              return outcome;
            }
          }
        }
      } else {
        const skipped = await repository.getAiMessageRecord(
          "finance_categorization",
          scopeKey,
          inputHash,
        );
        if (skipped?.status === "skipped") {
          return ZERO_OUTCOME;
        }
      }
    }

    const baseMessage = (): AiMessage => ({
      id: createEntityId("ai-message"),
      surface: "finance_categorization",
      scopeKey,
      stance: null,
      kind: "finance",
      inputHash,
      promptVersion: FINANCE_CATEGORIZATION_PROMPT_VERSION,
      model: settings.aiSurfaceModels.finance_categorization ?? settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(emptyResponse),
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt,
    });

    if (!aiConfigured) {
      await repository.saveCoachPulseEpisode(
        { ...baseMessage(), status: "skipped", model: "local" },
        [],
      );
      return ZERO_OUTCOME;
    }

    let sent = false;
    try {
      sent = true;
      const first = await this.provider.generateStructured({
        surface: "finance_categorization",
        settings,
        snapshot: chunk.snapshot,
      });

      let parsed = parseFinanceCategorizationJson(
        first.text,
        allowedCategoryIds,
        allowedMerchantKeys,
      );
      let finalText = first.text;
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "finance_categorization",
          settings,
          snapshot: chunk.snapshot,
          repairHint: parsed.error,
        });
        parsed = parseFinanceCategorizationJson(
          repair.text,
          allowedCategoryIds,
          allowedMerchantKeys,
        );
        finalText = repair.text;
        usage = {
          tokensPrompt: usage.tokensPrompt + repair.usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion + repair.usage.tokensCompletion,
          latencyMs: usage.latencyMs + repair.usage.latencyMs,
        };
        model = repair.model;
      }

      if (!parsed.ok) {
        await repository.saveCoachPulseEpisode(
          {
            ...baseMessage(),
            status: "fallback",
            model,
            tokensPrompt: usage.tokensPrompt,
            tokensCompletion: usage.tokensCompletion,
            latencyMs: usage.latencyMs,
          },
          [],
        );
        return { ...ZERO_OUTCOME, warning: parsed.error, sent };
      }

      await repository.saveCoachPulseEpisode(
        {
          ...baseMessage(),
          status: "ok",
          model,
          bodyJson: finalText,
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs,
        },
        [],
      );

      return {
        ...(await applyParsed(parsed.value, model, FINANCE_CATEGORIZATION_PROMPT_VERSION)),
        sent,
      };
    } catch (error) {
      await repository.saveCoachPulseEpisode({ ...baseMessage(), status: "fallback" }, []);
      return {
        ...ZERO_OUTCOME,
        sent,
        // Constant on purpose: provider/transport error text can embed request content and this
        // warning is logged by callers.
        warning: "provider request failed",
      };
    }
  }
}
