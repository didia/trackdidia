import { computeCorrelationFindings } from "../../../domain/insights/correlations";
import type { DailyEntry } from "../../../domain/types";
import { addDays } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { isBelowRetrievalThreshold } from "./decay";
import { parsePatternDetail, stringifyPatternDetail } from "./detail";
import { resolveCommitment } from "./commitment-resolution";
import { PATTERN_CONTRADICTION_DIFF } from "./constants";

export interface MemoryLifecycleResult {
  archivedExpired: number;
  archivedDecay: number;
  contradicted: number;
  resolvedCommitments: number;
}

const isExpiredContext = (expiresAt: string | null, date: string): boolean =>
  Boolean(expiresAt && expiresAt < date);

export const runMemoryLifecycle = async (
  repository: AppRepository,
  date: string,
  historyEntries: DailyEntry[],
  nowIso: string
): Promise<MemoryLifecycleResult> => {
  const result: MemoryLifecycleResult = {
    archivedExpired: 0,
    archivedDecay: 0,
    contradicted: 0,
    resolvedCommitments: 0
  };

  const memories = await repository.listAiMemories({ status: "active" });
  const correlations = computeCorrelationFindings(historyEntries);
  const correlationByPrinciple = new Map(correlations.map((finding) => [finding.principleKey, finding]));

  for (const memory of memories) {
    if (memory.kind === "context" && isExpiredContext(memory.expiresAt, date)) {
      await repository.archiveAiMemory(memory.id, "expired");
      result.archivedExpired += 1;
      continue;
    }

    if (memory.kind === "commitment" && memory.expiresAt && memory.expiresAt < date) {
      await repository.archiveAiMemory(memory.id, "expired");
      result.archivedExpired += 1;
      continue;
    }

    if (memory.kind === "pattern") {
      const detail = parsePatternDetail(memory.detail);
      if (detail.principleKey) {
        const current = correlationByPrinciple.get(detail.principleKey);
        if (current && detail.diff !== undefined) {
          const signFlipped =
            Math.sign(current.diff) !== Math.sign(detail.diff) &&
            Math.abs(current.diff) >= PATTERN_CONTRADICTION_DIFF &&
            Math.abs(detail.diff) >= PATTERN_CONTRADICTION_DIFF;

          if (signFlipped) {
            await repository.archiveAiMemory(memory.id, "contradicted");
            result.contradicted += 1;
            continue;
          }

          if (Math.abs(current.diff - detail.diff) > 0.2) {
            await repository.saveAiMemory({
              ...memory,
              detail: stringifyPatternDetail({
                principleKey: detail.principleKey,
                diff: current.diff
              }),
              confidence: Math.min(1, memory.confidence + 0.05),
              lastConfirmedAt: nowIso,
              evidenceTo: date
            });
            continue;
          }

          await repository.saveAiMemory({
            ...memory,
            lastConfirmedAt: nowIso,
            evidenceTo: date
          });
          continue;
        }
      }
    }

    if (isBelowRetrievalThreshold(memory, nowIso)) {
      await repository.archiveAiMemory(memory.id, "expired");
      result.archivedDecay += 1;
    }
  }

  return result;
};

export const resolveDueCommitmentsOnClose = async (
  repository: AppRepository,
  date: string,
  entry: DailyEntry,
  nowIso: string
): Promise<number> => {
  const commitments = await repository.listAiMemories({
    status: "active",
    kind: "commitment",
    activeOnDate: date
  });

  let resolved = 0;
  for (const memory of commitments) {
    if (memory.expiresAt !== date) {
      continue;
    }

    const resolution = resolveCommitment(memory, entry);
    const outcome = resolution.met === true ? "atteint" : resolution.met === false ? "non atteint" : "inconnu";
    const resolvedSuffix = `[resolved:${outcome};${resolution.progressLabel}]`;
    const detail = memory.detail.includes("[resolved:")
      ? memory.detail
      : `${memory.detail} ${resolvedSuffix}`.trim();
    await repository.saveAiMemory({
      ...memory,
      detail,
      lastConfirmedAt: nowIso
    });
    await repository.archiveAiMemory(memory.id, "resolved");
    resolved += 1;
  }

  return resolved;
};

export const commitmentExpiresAt = (acceptedDate: string): string => addDays(acceptedDate, 1);
