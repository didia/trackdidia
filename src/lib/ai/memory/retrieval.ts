import type { AiMemory, AppSettings, CoachPulseStance } from "../../../domain/types";
import { effectiveConfidence } from "./decay";
import { formatMemoryBlock } from "./format";
import { KIND_PRIORITY_BY_STANCE, MEMORY_RETRIEVAL_CAP } from "./constants";

export interface RetrieveMemoriesOptions {
  stance: CoachPulseStance;
  nowIso?: string;
}

const kindRank = (stance: CoachPulseStance, kind: AiMemory["kind"]): number => {
  const order = KIND_PRIORITY_BY_STANCE[stance];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
};

export const rankMemories = (
  memories: AiMemory[],
  stance: CoachPulseStance,
  nowIso: string
): AiMemory[] => {
  return [...memories].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftKind = kindRank(stance, left.kind);
    const rightKind = kindRank(stance, right.kind);
    if (leftKind !== rightKind) {
      return leftKind - rightKind;
    }

    const leftConfidence = effectiveConfidence(left, nowIso);
    const rightConfidence = effectiveConfidence(right, nowIso);
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }

    return right.lastConfirmedAt.localeCompare(left.lastConfirmedAt);
  });
};

export const selectMemoriesForPrompt = (
  memories: AiMemory[],
  stance: CoachPulseStance,
  nowIso: string
): AiMemory[] => {
  const ranked = rankMemories(memories, stance, nowIso);
  const pinned = ranked.filter((memory) => memory.pinned);
  const nonPinned = ranked.filter((memory) => !memory.pinned).slice(0, MEMORY_RETRIEVAL_CAP);
  return [...pinned, ...nonPinned];
};

export const retrieveMemories = (
  memories: AiMemory[],
  settings: AppSettings,
  options: RetrieveMemoriesOptions
): { selected: AiMemory[]; block: string } => {
  if (!settings.aiMemoryEnabled) {
    return { selected: [], block: "" };
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  const active = memories.filter((memory) => memory.status === "active");
  const selected = selectMemoriesForPrompt(active, options.stance, nowIso);

  return {
    selected,
    block: formatMemoryBlock(selected, nowIso)
  };
};
