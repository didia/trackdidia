import type { EmailTriageReview } from "../../../../domain/email-triage";
export interface ReviewRow {
  id: string;
  account_id: string;
  conversation_id: string;
  message_id: string;
  expected_decision_version: number;
  status: EmailTriageReview["status"];
  reason: string;
  sanitized_preview_json: string | null;
  resolution: EmailTriageReview["resolution"];
  resolved_at: string | null;
  created_at: string;
}
export const COLUMNS =
  "id, account_id, conversation_id, message_id, expected_decision_version, status, reason, sanitized_preview_json, resolution, resolved_at, created_at";
export const fromRow = (row: ReviewRow): EmailTriageReview => ({
  id: row.id,
  accountId: row.account_id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  expectedDecisionVersion: row.expected_decision_version,
  status: row.status,
  reason: row.reason,
  sanitizedPreview: row.sanitized_preview_json
    ? (JSON.parse(row.sanitized_preview_json) as EmailTriageReview["sanitizedPreview"])
    : null,
  resolution: row.resolution,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
});
export const toParams = (entity: EmailTriageReview): unknown[] => [
  entity.id,
  entity.accountId,
  entity.conversationId,
  entity.messageId,
  entity.expectedDecisionVersion,
  entity.status,
  entity.reason,
  JSON.stringify(entity.sanitizedPreview),
  entity.resolution,
  entity.resolvedAt,
  entity.createdAt,
];
