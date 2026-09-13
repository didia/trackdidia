import type {
  AiMessage,
  AppSettings,
  PastorVerseBody,
  PastorVerseResult,
} from "../../domain/types";
import { createEntityId, nowIso } from "../gtd/shared";
import { formatReferenceFr } from "../pastor/bible-books";
import { pickLocalVerse } from "../pastor/local-pick";
import { loadVerseCatalog } from "../pastor/verse-catalog";
import type { AppRepository } from "../storage/repository";
import { buildPastorSnapshot, resolvePastorSnapshotInputs } from "./context/pastor-snapshot";
import { buildAiInputHash } from "./input-hash";
import {
  parsePastorVerseJson,
  parseStoredPastorBody,
  type PastorVerseValidationContext,
} from "./proposals/pastor-verse-validator";
import type { AiProvider } from "./provider";

export const PASTOR_VERSE_PROMPT_VERSION = "pastor_verse.v1";

export interface PastorVerseRequest {
  date: string;
  settings: AppSettings;
  /** `auto` loads in the background after the local pick is shown; `explicit` is "Nouveau verset". */
  trigger: "auto" | "explicit";
  /** Verse ids to treat as blocked in addition to history (e.g. the verse currently on screen). */
  excludeVerseIds?: string[];
  /** Never calls the provider; returns an ephemeral local pick without persisting a row. */
  localOnly?: boolean;
}

const buildBodyText = (body: PastorVerseBody): string => {
  const label = body.reference ? formatReferenceFr(body.reference) : "";
  return label ? `${label} — ${body.title}` : body.title;
};

const resultSourceFromMessage = (message: AiMessage): PastorVerseResult["source"] => {
  if (message.status === "ok") {
    return "cache";
  }
  if (message.status === "fallback") {
    return "fallback";
  }
  return "local";
};

export class PastorVerseService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    _repository: AppRepository,
    message: AiMessage,
  ): Promise<PastorVerseResult | null> {
    if (message.promptVersion !== PASTOR_VERSE_PROMPT_VERSION) {
      // A stale prompt version may be shaped for an older schema — regenerate instead.
      return null;
    }

    const body = parseStoredPastorBody(message.bodyJson);
    if (!body) {
      return null;
    }

    const catalog = loadVerseCatalog();
    const verse = body.verseId ? (catalog.find((item) => item.id === body.verseId) ?? null) : null;

    return {
      message,
      body,
      verse,
      source: resultSourceFromMessage(message),
    };
  }

  async buildVerse(
    repository: AppRepository,
    request: PastorVerseRequest,
  ): Promise<PastorVerseResult> {
    const { date, settings, trigger, excludeVerseIds = [], localOnly = false } = request;
    const promptVersion = PASTOR_VERSE_PROMPT_VERSION;
    const inputs = await resolvePastorSnapshotInputs(repository, date, promptVersion);
    const blockedVerseIds = [...new Set([...inputs.history.blockedVerseIds, ...excludeVerseIds])];
    const history = { ...inputs.history, blockedVerseIds };
    const snapshot = buildPastorSnapshot({ ...inputs, history }, settings.aiPayloadScope);
    const scopeKey = `pastor:${date}`;
    const createdAt = nowIso();
    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;

    const localBody = pickLocalVerse(
      date,
      inputs.catalog,
      snapshot.principleSignals.struggling,
      blockedVerseIds,
    );
    const verseForBody = (body: PastorVerseBody) =>
      body.verseId ? (inputs.catalog.find((item) => item.id === body.verseId) ?? null) : null;

    if (localOnly || !aiConfigured) {
      return { message: null, body: localBody, verse: verseForBody(localBody), source: "local" };
    }

    // `inputHash` is audit-only here: unlike `goal_pacing`, pastor caching is scope-key/date
    // sticky (one row per day), driven entirely by `pastor-verse-loader.ts` reading the latest
    // `ok` row for `scopeKey`.
    const inputHash = buildAiInputHash({ promptVersion, scope: settings.aiPayloadScope, snapshot });
    const baseMessage = (): AiMessage => ({
      id: createEntityId("ai-message"),
      surface: "pastor_verse",
      scopeKey,
      stance: null,
      kind: "daily",
      inputHash,
      promptVersion,
      model: settings.aiSurfaceModels.pastor_verse?.trim() || settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(localBody),
      bodyText: buildBodyText(localBody),
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt,
    });

    const ctx: PastorVerseValidationContext = {
      catalog: inputs.catalog,
      blockedVerseIds,
      offListAllowed: history.offListAllowed,
    };

    try {
      const first = await this.provider.generateStructured({
        surface: "pastor_verse",
        settings,
        snapshot,
      });

      let parsed = parsePastorVerseJson(first.text, ctx);
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "pastor_verse",
          settings,
          snapshot,
          repairHint: parsed.error,
        });
        parsed = parsePastorVerseJson(repair.text, ctx);
        usage = {
          tokensPrompt: usage.tokensPrompt + repair.usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion + repair.usage.tokensCompletion,
          latencyMs: usage.latencyMs + repair.usage.latencyMs,
        };
        model = repair.model;
      }

      if (!parsed.ok) {
        // An `explicit` (regenerate) failure never persists: the hook keeps showing the verse
        // already on screen rather than this local fallback body, so saving it here would leave
        // an unseen verse in `ai_messages` that still counts as "shown today" for future history
        // blocking (see `summarizePastorHistory`). `auto` failures still persist so the fallback
        // cooldown in `pastor-verse-loader.ts`/`use-pastor-verse.ts` keeps working.
        if (trigger === "explicit") {
          return {
            message: null,
            body: localBody,
            verse: verseForBody(localBody),
            source: "fallback",
            warning: parsed.error,
          };
        }

        const message: AiMessage = {
          ...baseMessage(),
          status: "fallback",
          model,
          bodyJson: JSON.stringify(localBody),
          bodyText: buildBodyText(localBody),
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs,
        };
        const saved = await repository.saveCoachPulseEpisode(message, []);
        return {
          message: saved.message,
          body: localBody,
          verse: verseForBody(localBody),
          source: "fallback",
          warning: parsed.error,
        };
      }

      const message: AiMessage = {
        ...baseMessage(),
        status: "ok",
        model,
        bodyJson: JSON.stringify(parsed.value),
        bodyText: buildBodyText(parsed.value),
        tokensPrompt: usage.tokensPrompt,
        tokensCompletion: usage.tokensCompletion,
        latencyMs: usage.latencyMs,
      };
      const saved = await repository.saveCoachPulseEpisode(message, []);
      return {
        message: saved.message,
        body: parsed.value,
        verse: verseForBody(parsed.value),
        source: "ai",
      };
    } catch (error) {
      const warning = error instanceof Error ? error.message : "L'IA n'a pas pu repondre.";

      // See the comment above the equivalent branch in the `!parsed.ok` case: an `explicit`
      // failure never persists an unseen verse into history.
      if (trigger === "explicit") {
        return {
          message: null,
          body: localBody,
          verse: verseForBody(localBody),
          source: "fallback",
          warning,
        };
      }

      const message: AiMessage = {
        ...baseMessage(),
        status: "fallback",
        bodyJson: JSON.stringify(localBody),
        bodyText: buildBodyText(localBody),
      };
      const saved = await repository.saveCoachPulseEpisode(message, []);
      return {
        message: saved.message,
        body: localBody,
        verse: verseForBody(localBody),
        source: "fallback",
        warning,
      };
    }
  }
}
