import type { AiMemory } from "../../../../domain/types";

export interface AiMemoryRow {
  id: string;
  kind: string;
  statement: string;
  detail: string;
  confidence: number;
  source: string;
  status: string;
  evidence_from: string | null;
  evidence_to: string | null;
  created_at: string;
  last_confirmed_at: string;
  expires_at: string | null;
  pinned: number;
}
export const COLUMNS =
  "id, kind, statement, detail, confidence, source, status, evidence_from, evidence_to, created_at, last_confirmed_at, expires_at, pinned";
export const fromRow = (row: AiMemoryRow): AiMemory => {
  return {
    id: row.id,
    kind: row.kind as AiMemory["kind"],
    statement: row.statement,
    detail: row.detail,
    confidence: row.confidence,
    source: row.source as AiMemory["source"],
    status: row.status as AiMemory["status"],
    evidenceFrom: row.evidence_from,
    evidenceTo: row.evidence_to,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    expiresAt: row.expires_at,
    pinned: row.pinned === 1,
  };
};
export const toParams = (entity: AiMemory): unknown[] => [
  entity.id,
  entity.kind,
  entity.statement,
  entity.detail,
  entity.confidence,
  entity.source,
  entity.status,
  entity.evidenceFrom,
  entity.evidenceTo,
  entity.createdAt,
  entity.lastConfirmedAt,
  entity.expiresAt,
  entity.pinned ? 1 : 0,
];
