import type { AiMessage, AiSurface, CoachPulseStance } from "../../../../domain/types";

export interface AiMessageRow {
  id: string;
  surface: string;
  scope_key: string;
  stance: string | null;
  kind: string;
  input_hash: string;
  prompt_version: string;
  model: string;
  status: string;
  body_json: string | null;
  body_text: string | null;
  delta_class: string | null;
  notified: number;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  latency_ms: number | null;
  created_at: string;
}
export const COLUMNS =
  "id, surface, scope_key, stance, kind, input_hash, prompt_version, model, status, body_json, body_text, delta_class, notified, tokens_prompt, tokens_completion, latency_ms, created_at";
export const fromRow = (row: AiMessageRow): AiMessage => {
  return {
    id: row.id,
    surface: row.surface as AiSurface,
    scopeKey: row.scope_key,
    stance: row.stance as CoachPulseStance | null,
    kind: row.kind,
    inputHash: row.input_hash,
    promptVersion: row.prompt_version,
    model: row.model,
    status: row.status as AiMessage["status"],
    bodyJson: row.body_json,
    bodyText: row.body_text,
    deltaClass: row.delta_class as AiMessage["deltaClass"],
    notified: row.notified === 1,
    tokensPrompt: row.tokens_prompt,
    tokensCompletion: row.tokens_completion,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
};
export const toParams = (entity: AiMessage): unknown[] => [
  entity.id,
  entity.surface,
  entity.scopeKey,
  entity.stance,
  entity.kind,
  entity.inputHash,
  entity.promptVersion,
  entity.model,
  entity.status,
  entity.bodyJson,
  entity.bodyText,
  entity.deltaClass,
  entity.notified ? 1 : 0,
  entity.tokensPrompt,
  entity.tokensCompletion,
  entity.latencyMs,
  entity.createdAt,
];
