import { runStructuredSurface, sourceFromStatus } from "./structured-generation";
import type {
  AiMessage,
  AiProposal,
  AppSettings,
  WeeklyRitualSectionKey,
  WeeklySynthesisResponse,
  WeeklySynthesisResult,
} from "../../domain/types";
import { computeGtdHealthFindings } from "../../domain/insights/gtd-health";
import { clampAiAsOfDate, stableAiNowIso } from "../date";
import { createEntityId, nowIso } from "../gtd/shared";
import { toLocalDateString } from "../date";
import type { AppRepository } from "../storage/repository";
import { buildWeeklySnapshot, type WeeklySnapshotInputs } from "./context/weekly-snapshot";
import { buildAiInputHash } from "./input-hash";
import { retrieveMemoriesForWeekly } from "./memory/retrieval";
import { buildLocalWeeklySynthesis } from "./proposals/weekly-synthesis-fallback";
import { parseWeeklySynthesisJson } from "./proposals/weekly-synthesis-validator";
import type { AiProvider } from "./provider";

export const WEEKLY_SYNTHESIS_PROMPT_VERSION = "weekly_synthesis.v1";

export interface WeeklySynthesisRequest {
  weekStartDate: string;
  settings: AppSettings;
  snapshotInputs: WeeklySnapshotInputs;
  bypassCache?: boolean;
  trigger?: "auto" | "explicit";
}

const synthesisToBodyText = (synthesis: WeeklySynthesisResponse): string =>
  [synthesis.headline, synthesis.scoreExplanation].filter(Boolean).join("\n\n");

/**
 * Titles keyed by the ids of tasks the coach is actually allowed to name in a `gtd_action`
 * proposal (currently: tasks the deterministic `stale_next_actions` finding flagged), resolved
 * from the unredacted repository data rather than the (possibly title-redacted) model-facing
 * snapshot. A `gtd_action` whose `taskId` isn't a key here is dropped, and the title used to
 * persist/render an accepted action always comes from this map, never from the model's own
 * `taskTitle` — the model only chooses which eligible task to act on, not what it's called or
 * whether it exists, so a hallucinated or mismatched id/title pair can never reach acceptance.
 */
const resolveEligibleGtdTaskTitles = (
  inputs: WeeklySnapshotInputs,
  now: string,
): Map<string, string> => {
  const staleFinding = computeGtdHealthFindings(inputs.tasks, inputs.projects, now).find(
    (finding) => finding.kind === "stale_next_actions",
  );
  const taskTitleById = new Map(inputs.tasks.map((task) => [task.id, task.title] as const));

  return new Map(
    (staleFinding?.taskIds ?? []).map((id) => [id, taskTitleById.get(id) ?? id] as const),
  );
};

const buildProposals = (
  messageId: string,
  synthesis: WeeklySynthesisResponse,
  createdAt: string,
  eligibleGtdTaskTitles: Map<string, string>,
): AiProposal[] => {
  const proposals: AiProposal[] = [];

  for (const [sectionKey, text] of Object.entries(synthesis.sectionDrafts ?? {})) {
    if (!text?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "review_section_draft",
      payloadJson: JSON.stringify({ sectionKey, text: text.trim() }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  for (const objective of synthesis.nextWeekObjectives ?? []) {
    if (!objective.title?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "weekly_objective",
      payloadJson: JSON.stringify(objective),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  for (const action of synthesis.gtdActions ?? []) {
    const canonicalTitle = action.taskId ? eligibleGtdTaskTitles.get(action.taskId) : undefined;
    if (!action.taskId?.trim() || !canonicalTitle || !action.reason?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "gtd_action",
      payloadJson: JSON.stringify({ ...action, taskTitle: canonicalTitle }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  return proposals;
};

const cachedResult = async (
  repository: AppRepository,
  message: AiMessage,
): Promise<WeeklySynthesisResult | null> => {
  if (!message.bodyJson) {
    return null;
  }

  const parsed = parseWeeklySynthesisJson(message.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  const proposals = await repository.listAiProposals(message.id);
  return {
    message,
    synthesis: parsed.value,
    proposals,
    source: sourceFromStatus(message.status, { cached: true }),
  };
};

export class WeeklySynthesisService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
    message: AiMessage,
  ): Promise<WeeklySynthesisResult | null> {
    return cachedResult(repository, message);
  }

  async buildSynthesis(
    repository: AppRepository,
    request: WeeklySynthesisRequest,
  ): Promise<WeeklySynthesisResult> {
    const { weekStartDate, settings, snapshotInputs, bypassCache = false } = request;
    const asOfDate = clampAiAsOfDate(
      toLocalDateString(snapshotInputs.now),
      snapshotInputs.summary.weekEndDate,
    );
    const snapshot = buildWeeklySnapshot(
      { ...snapshotInputs, now: stableAiNowIso(asOfDate) },
      settings.aiPayloadScope,
    );
    const scopeKey = weekStartDate;
    const createdAt = nowIso();
    const eligibleGtdTaskTitles = resolveEligibleGtdTaskTitles(
      snapshotInputs,
      stableAiNowIso(asOfDate),
    );

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.weekEndDate,
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForWeekly(activeMemories, settings, {
      nowIso: stableAiNowIso(asOfDate),
    });
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: WEEKLY_SYNTHESIS_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds,
      asOfDate,
    });

    const result = await runStructuredSurface({
      repository,
      provider: this.provider,
      settings,
      surface: "weekly_synthesis",
      scopeKey,
      kind: "weekly",
      promptVersion: WEEKLY_SYNTHESIS_PROMPT_VERSION,
      inputHash,
      createdAt,
      bypassCache,
      reuseMessageId: false,
      localFallback: buildLocalWeeklySynthesis(snapshot),
      toBodyText: synthesisToBodyText,
      parse: parseWeeklySynthesisJson,
      request: (repairHint) => ({
        surface: "weekly_synthesis",
        settings,
        snapshot,
        memoryBlock,
        repairHint,
      }),
      buildProposals: (id, response, at) => buildProposals(id, response, at, eligibleGtdTaskTitles),
      cachedResult: async (message) => {
        const cached = await cachedResult(repository, message);
        return cached ? { response: cached.synthesis, proposals: cached.proposals } : null;
      },
    });
    return {
      message: result.message,
      synthesis: result.response,
      proposals: result.proposals,
      source: result.source,
      warning: result.warning,
    };
  }
}

export const weeklySectionKeyFromProposal = (
  payloadJson: string,
): WeeklyRitualSectionKey | null => {
  try {
    const payload = JSON.parse(payloadJson) as { sectionKey?: WeeklyRitualSectionKey };
    return payload.sectionKey ?? null;
  } catch {
    return null;
  }
};
