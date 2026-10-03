import { runStructuredSurface, sourceFromStatus } from "./structured-generation";
import type {
  AiMessage,
  AppSettings,
  PastorVerseBody,
  PastorVerseResult,
} from "../../domain/types";
import { nowIso } from "../gtd/shared";
import { formatReferenceFr } from "../pastor/bible-books";
import { pickLocalVerse } from "../pastor/local-pick";
import { buildCatalogWithCustomVerses } from "../pastor/verse-catalog";
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

export class PastorVerseService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
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

    const settings = await repository.getSettings();
    const catalog = buildCatalogWithCustomVerses(settings.aiPastorCustomVerses).verses;
    const verse = body.verseId ? (catalog.find((item) => item.id === body.verseId) ?? null) : null;

    return {
      message,
      body,
      verse,
      source: sourceFromStatus(message.status, { cached: true }),
    };
  }

  async buildVerse(
    repository: AppRepository,
    request: PastorVerseRequest,
  ): Promise<PastorVerseResult> {
    const { date, settings, trigger, excludeVerseIds = [], localOnly = false } = request;
    const promptVersion = PASTOR_VERSE_PROMPT_VERSION;
    const inputs = await resolvePastorSnapshotInputs(
      repository,
      date,
      promptVersion,
      settings.aiPastorCustomVerses,
    );
    const blockedVerseIds = [...new Set([...inputs.history.blockedVerseIds, ...excludeVerseIds])];
    const history = { ...inputs.history, blockedVerseIds };
    const snapshot = buildPastorSnapshot({ ...inputs, history }, settings.aiPayloadScope);
    const scopeKey = `pastor:${date}`;
    const createdAt = nowIso();

    const localBody = pickLocalVerse(
      date,
      inputs.catalog,
      snapshot.principleSignals.struggling,
      blockedVerseIds,
    );
    const verseForBody = (body: PastorVerseBody) =>
      body.verseId ? (inputs.catalog.find((item) => item.id === body.verseId) ?? null) : null;

    // `inputHash` is audit-only here: unlike `goal_pacing`, pastor caching is scope-key/date
    // sticky (one row per day), driven entirely by `pastor-verse-loader.ts` reading the latest
    // `ok`/`local` row for `scopeKey`.
    const inputHash = buildAiInputHash({ promptVersion, scope: settings.aiPayloadScope, snapshot });
    if (localOnly) {
      return { message: null, body: localBody, verse: verseForBody(localBody), source: "local" };
    }
    const ctx: PastorVerseValidationContext = {
      catalog: inputs.catalog,
      blockedVerseIds,
      offListAllowed: history.offListAllowed,
    };
    const result = await runStructuredSurface({
      repository,
      provider: this.provider,
      settings,
      surface: "pastor_verse",
      scopeKey,
      kind: "daily",
      promptVersion,
      inputHash,
      createdAt,
      cachePolicy: "none",
      localStatus: "local",
      persistFallback: trigger !== "explicit",
      model: settings.aiSurfaceModels.pastor_verse?.trim() || settings.aiModel,
      localFallback: localBody,
      toBodyText: buildBodyText,
      parse: (text) => parsePastorVerseJson(text, ctx),
      serializeResponse: (body) => JSON.stringify(body),
      request: (repairHint) => ({ surface: "pastor_verse", settings, snapshot, repairHint }),
    });
    return {
      message: result.message,
      body: result.response,
      verse: verseForBody(result.response),
      source: result.source,
      warning: result.warning,
    };
  }
}
