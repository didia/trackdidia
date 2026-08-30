import type { MetricKey, PrincipleKey } from "../../../domain/types";

export interface CommitmentMemoryDetail {
  metricKey?: MetricKey | null;
  target?: number | null;
  principleKey?: PrincipleKey | null;
}

export interface PatternMemoryDetail {
  principleKey?: PrincipleKey;
  diff?: number;
}

const detailJsonPrefix = (detail: string): string => detail.split(/\s+\[/)[0]?.trim() ?? detail;

export const parseCommitmentDetail = (detail: string): CommitmentMemoryDetail => {
  try {
    return JSON.parse(detailJsonPrefix(detail)) as CommitmentMemoryDetail;
  } catch {
    return {};
  }
};

export const parsePatternDetail = (detail: string): PatternMemoryDetail => {
  try {
    return JSON.parse(detail) as PatternMemoryDetail;
  } catch {
    return {};
  }
};

export const stringifyCommitmentDetail = (payload: CommitmentMemoryDetail): string =>
  JSON.stringify(payload);

export const stringifyPatternDetail = (payload: PatternMemoryDetail): string =>
  JSON.stringify(payload);
