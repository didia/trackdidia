import type { CoachPulseStance, AiMemory, AppSettings, MemoryKind } from "../../../domain/types";
import { effectiveConfidence } from "./decay";
import { formatMemoryBlock } from "./format";
import { KIND_PRIORITY_BY_STANCE, KIND_PRIORITY_GOAL, KIND_PRIORITY_MONTHLY, KIND_PRIORITY_WEEKLY, MEMORY_RETRIEVAL_CAP } from "./constants";

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

const kindRankWeekly = (kind: AiMemory["kind"]): number => {
  const index = KIND_PRIORITY_WEEKLY.indexOf(kind);
  return index === -1 ? KIND_PRIORITY_WEEKLY.length : index;
};

export const rankMemoriesForWeekly = (memories: AiMemory[], nowIso: string): AiMemory[] =>
  [...memories].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftKind = kindRankWeekly(left.kind);
    const rightKind = kindRankWeekly(right.kind);
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

export const retrieveMemoriesForWeekly = (
  memories: AiMemory[],
  settings: AppSettings,
  options: { nowIso?: string } = {}
): { selected: AiMemory[]; block: string } => {
  if (!settings.aiMemoryEnabled) {
    return { selected: [], block: "" };
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  const active = memories.filter((memory) => memory.status === "active");
  const ranked = rankMemoriesForWeekly(active, nowIso);
  const pinned = ranked.filter((memory) => memory.pinned);
  const nonPinned = ranked.filter((memory) => !memory.pinned).slice(0, MEMORY_RETRIEVAL_CAP);
  const selected = [...pinned, ...nonPinned];

  return {
    selected,
    block: formatMemoryBlock(selected, nowIso)
  };
};

const kindRankForOrder = (kind: AiMemory["kind"], order: MemoryKind[]): number => {
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
};

const rankMemoriesByKindOrder = (memories: AiMemory[], order: MemoryKind[], nowIso: string): AiMemory[] =>
  [...memories].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftKind = kindRankForOrder(left.kind, order);
    const rightKind = kindRankForOrder(right.kind, order);
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

const retrieveMemoriesByKindOrder = (
  memories: AiMemory[],
  settings: AppSettings,
  order: MemoryKind[],
  options: { nowIso?: string } = {}
): { selected: AiMemory[]; block: string } => {
  if (!settings.aiMemoryEnabled) {
    return { selected: [], block: "" };
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  const active = memories.filter((memory) => memory.status === "active");
  const ranked = rankMemoriesByKindOrder(active, order, nowIso);
  const pinned = ranked.filter((memory) => memory.pinned);
  const nonPinned = ranked.filter((memory) => !memory.pinned).slice(0, MEMORY_RETRIEVAL_CAP);
  const selected = [...pinned, ...nonPinned];

  return {
    selected,
    block: formatMemoryBlock(selected, nowIso)
  };
};

export const retrieveMemoriesForMonthly = (
  memories: AiMemory[],
  settings: AppSettings,
  options: { nowIso?: string } = {}
): { selected: AiMemory[]; block: string } => retrieveMemoriesByKindOrder(memories, settings, KIND_PRIORITY_MONTHLY, options);

export const retrieveMemoriesForGoalPacing = (
  memories: AiMemory[],
  settings: AppSettings,
  options: { nowIso?: string } = {}
): { selected: AiMemory[]; block: string } => retrieveMemoriesByKindOrder(memories, settings, KIND_PRIORITY_GOAL, options);
