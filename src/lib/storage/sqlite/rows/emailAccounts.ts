import type { EmailTriageAccount } from "../../../../domain/email-triage";
export interface AccountRow {
  id: string;
  provider: EmailTriageAccount["provider"];
  provider_account_id: string;
  label: string;
  masked_address: string;
  generation: number;
  enabled: number;
  mutation_enabled: number;
  paused: number;
  state: EmailTriageAccount["state"];
  recovery_state: EmailTriageAccount["recoveryState"];
  last_success_at: string | null;
  last_error: string | null;
  poll_interval_minutes: number;
  sync_state_json: string;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, provider, provider_account_id, label, masked_address, generation, enabled, mutation_enabled, paused, state, recovery_state, last_success_at, last_error, poll_interval_minutes, sync_state_json, created_at, updated_at";
export const fromRow = (row: AccountRow): EmailTriageAccount => ({
  id: row.id,
  provider: row.provider,
  providerAccountId: row.provider_account_id,
  label: row.label,
  maskedAddress: row.masked_address,
  generation: row.generation,
  enabled: Boolean(row.enabled),
  mutationEnabled: Boolean(row.mutation_enabled),
  paused: Boolean(row.paused),
  state: row.state,
  recoveryState: row.recovery_state,
  lastSuccessAt: row.last_success_at,
  lastError: row.last_error,
  pollIntervalMinutes: row.poll_interval_minutes,
  syncState: JSON.parse(row.sync_state_json) as Record<string, unknown>,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export const toParams = (entity: EmailTriageAccount): unknown[] => [
  entity.id,
  entity.provider,
  entity.providerAccountId,
  entity.label,
  entity.maskedAddress,
  entity.generation,
  entity.enabled ? 1 : 0,
  entity.mutationEnabled ? 1 : 0,
  entity.paused ? 1 : 0,
  entity.state,
  entity.recoveryState,
  entity.lastSuccessAt,
  entity.lastError,
  entity.pollIntervalMinutes,
  JSON.stringify(entity.syncState),
  entity.createdAt,
  entity.updatedAt,
];
