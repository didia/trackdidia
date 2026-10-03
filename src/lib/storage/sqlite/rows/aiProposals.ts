import type { AiProposal } from "../../../../domain/types";

export interface AiProposalRow {
  id: string;
  message_id: string;
  type: string;
  payload_json: string;
  status: string;
  applied_entity_id: string | null;
  decided_at: string | null;
  created_at: string;
}
export const COLUMNS =
  "id, message_id, type, payload_json, status, applied_entity_id, decided_at, created_at";
export const fromRow = (row: AiProposalRow): AiProposal => {
  return {
    id: row.id,
    messageId: row.message_id,
    type: row.type as AiProposal["type"],
    payloadJson: row.payload_json,
    status: row.status as AiProposal["status"],
    appliedEntityId: row.applied_entity_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
};
export const toParams = (entity: AiProposal): unknown[] => [
  entity.id,
  entity.messageId,
  entity.type,
  entity.payloadJson,
  entity.status,
  entity.appliedEntityId,
  entity.decidedAt,
  entity.createdAt,
];
