import type { CoachPulseStance, MemoryKind } from "../../../domain/types";

/** Non-pinned memories injected per prompt (spec open question #4). */
export const MEMORY_RETRIEVAL_CAP = 8;

/** Confidence below this after decay excludes a memory from retrieval. */
export const MEMORY_RETRIEVAL_THRESHOLD = 0.35;

/** Half-life for confidence decay in days (pattern/preference). */
export const MEMORY_DECAY_HALF_LIFE_DAYS = 90;

/** Minimum |diff| swing to mark a stored pattern as contradicted. */
export const PATTERN_CONTRADICTION_DIFF = 0.1;

export const KIND_PRIORITY_BY_STANCE: Record<CoachPulseStance, MemoryKind[]> = {
  open: ["commitment", "principle", "preference", "context", "pattern"],
  steer: ["commitment", "pattern", "preference", "context", "principle"],
  wind_down: ["commitment", "context", "pattern", "preference", "principle"],
  close: ["pattern", "preference", "context", "principle", "commitment"]
};

export const KIND_PRIORITY_WEEKLY: MemoryKind[] = [
  "pattern",
  "preference",
  "principle",
  "context",
  "commitment"
];

export const KIND_PRIORITY_MONTHLY: MemoryKind[] = [
  "pattern",
  "context",
  "preference",
  "principle",
  "commitment"
];

export const KIND_PRIORITY_GOAL: MemoryKind[] = [
  "principle",
  "pattern",
  "context",
  "preference",
  "commitment"
];
