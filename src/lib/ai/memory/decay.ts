import type { AiMemory, MemoryKind } from "../../../domain/types";
import { MEMORY_DECAY_HALF_LIFE_DAYS, MEMORY_RETRIEVAL_THRESHOLD } from "./constants";

const DECAYABLE_KINDS = new Set<MemoryKind>(["pattern", "preference"]);

const daysBetween = (fromIso: string, toIso: string): number => {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  return Math.max(0, (toMs - fromMs) / 86_400_000);
};

/** Exponential half-life decay; pinned/principle/context/commitment skip decay. */
export const effectiveConfidence = (memory: AiMemory, nowIso: string): number => {
  if (memory.pinned || !DECAYABLE_KINDS.has(memory.kind)) {
    return memory.confidence;
  }

  const ageDays = daysBetween(memory.lastConfirmedAt, nowIso);
  const factor = Math.pow(0.5, ageDays / MEMORY_DECAY_HALF_LIFE_DAYS);
  return memory.confidence * factor;
};

export const isBelowRetrievalThreshold = (memory: AiMemory, nowIso: string): boolean =>
  effectiveConfidence(memory, nowIso) < MEMORY_RETRIEVAL_THRESHOLD;
