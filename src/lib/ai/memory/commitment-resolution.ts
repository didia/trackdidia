import { resolveMetricValue } from "../../../domain/daily-entry";
import type { AiMemory, CoachPulseStance, DailyEntry, MetricKey, PrincipleKey } from "../../../domain/types";
import type { AppRepository } from "../../storage/repository";
import { parseCommitmentDetail } from "./detail";

export interface CommitmentResolution {
  memoryId: string;
  statement: string;
  metricKey: MetricKey | null;
  principleKey: PrincipleKey | null;
  target: number | null;
  currentValue: number | boolean | null;
  progressLabel: string;
  met: boolean | null;
}

const formatMetricProgress = (current: number | null, target: number | null): string => {
  if (current === null) {
    return target === null ? "Pas encore mesure" : `0/${target}`;
  }

  if (target === null) {
    return String(current);
  }

  return `${current}/${target}`;
};

export const resolveCommitment = (memory: AiMemory, entry: DailyEntry): CommitmentResolution => {
  const detail = parseCommitmentDetail(memory.detail);
  const metricKey = detail.metricKey ?? null;
  const principleKey = detail.principleKey ?? null;
  const target = detail.target ?? null;

  if (principleKey) {
    const currentValue = entry.principleChecks[principleKey];
    const met = currentValue === true;
    const progressLabel =
      currentValue === null
        ? "Principe non evalue"
        : currentValue
          ? "Principe respecte"
          : "Principe non respecte";

    return {
      memoryId: memory.id,
      statement: memory.statement,
      metricKey,
      principleKey,
      target,
      currentValue,
      progressLabel,
      met: currentValue === null ? null : met
    };
  }

  if (metricKey) {
    const currentValue = resolveMetricValue(entry, metricKey);
    const met = target === null ? null : currentValue !== null && currentValue >= target;

    return {
      memoryId: memory.id,
      statement: memory.statement,
      metricKey,
      principleKey,
      target,
      currentValue,
      progressLabel: formatMetricProgress(currentValue, target),
      met
    };
  }

  return {
    memoryId: memory.id,
    statement: memory.statement,
    metricKey,
    principleKey,
    target,
    currentValue: null,
    progressLabel: "Engagement sans metrique liee",
    met: null
  };
};

export const findActiveCommitment = (memories: AiMemory[]): AiMemory | null => {
  const commitments = memories.filter((memory) => memory.kind === "commitment" && memory.status === "active");
  if (commitments.length === 0) {
    return null;
  }

  return commitments.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
};

/** Active commitment, or on close the commitment archived today after resolve (for stable cache hash). */
export const findDueCommitment = async (
  repository: AppRepository,
  date: string,
  stance: CoachPulseStance,
  activeMemories: AiMemory[]
): Promise<AiMemory | null> => {
  const active = findActiveCommitment(activeMemories);
  if (active) {
    return active;
  }

  if (stance !== "close") {
    return null;
  }

  const archivedToday = await repository.listAiMemories({
    status: "archived",
    kind: "commitment"
  });

  return archivedToday.find((memory) => memory.expiresAt === date) ?? null;
};

export const buildCloseMemoryIds = (selectedIds: string[], dueCommitment: AiMemory | null): string[] => {
  const ids = new Set(selectedIds);
  if (dueCommitment) {
    ids.add(dueCommitment.id);
  }

  return [...ids].sort();
};
