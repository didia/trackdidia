import type { EmailTriageTransientMessage } from "../../../domain/email-triage";

export interface ProviderSyncPage {
  messages: EmailTriageTransientMessage[];
  cursorUpdate: Record<string, unknown> | null;
  hasMore: boolean;
  gapDetected: boolean;
}

export interface ProviderMarkerRequest {
  messageIds: string[];
  decision: "relevant" | "ignore";
  ignoreReason?: string | null;
}

export interface EmailTriageProviderAdapter {
  readonly provider: "gmail" | "microsoft_graph" | "yahoo";
  fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage>;
  applyMarkers?(request: ProviderMarkerRequest): Promise<void>;
}

export interface SyncPersistInput {
  accountId: string;
  page: ProviderSyncPage;
}

export const mergeSyncState = (
  current: Record<string, unknown>,
  update: Record<string, unknown> | null,
): Record<string, unknown> => ({
  ...current,
  ...(update ?? {}),
});
