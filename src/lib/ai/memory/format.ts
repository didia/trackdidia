import type { AiMemory } from "../../../domain/types";
import { effectiveConfidence } from "./decay";

export const formatMemoryBlock = (memories: AiMemory[], nowIso: string): string => {
  if (memories.length === 0) {
    return "";
  }

  const lines = memories.map((memory) => {
    const confidence = effectiveConfidence(memory, nowIso);
    const pin = memory.pinned ? " [epingle]" : "";
    const expiry = memory.expiresAt ? ` (expire ${memory.expiresAt})` : "";
    return `- [${memory.kind}${pin}] ${memory.statement} (conf=${confidence.toFixed(2)}${expiry})`;
  });

  return ["Memoires pertinentes:", ...lines].join("\n");
};
