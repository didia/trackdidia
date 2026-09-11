import type { EmailTriageAccount } from "../../domain/email-triage";

export interface ReconnectTargetSnapshot {
  id: string;
  generation: number;
  providerAccountId: string;
}

export type ReconnectGuardFailure =
  | "account_not_found"
  | "reconnect_cancelled"
  | "reconnect_account_mismatch";

export const snapshotReconnectTarget = (account: EmailTriageAccount): ReconnectTargetSnapshot => ({
  id: account.id,
  generation: account.generation,
  providerAccountId: account.providerAccountId,
});

export const validateReconnectCanProceed = (input: {
  snapshot: ReconnectTargetSnapshot | null;
  currentAccount: EmailTriageAccount | null;
  authenticatedProviderAccountId: string;
}): { ok: true } | { ok: false; error: ReconnectGuardFailure } => {
  if (!input.snapshot) {
    return { ok: false, error: "account_not_found" };
  }
  if (!input.currentAccount || input.currentAccount.id !== input.snapshot.id) {
    return { ok: false, error: "account_not_found" };
  }
  if (input.currentAccount.generation !== input.snapshot.generation) {
    return { ok: false, error: "reconnect_cancelled" };
  }
  if (input.currentAccount.providerAccountId !== input.snapshot.providerAccountId) {
    return { ok: false, error: "reconnect_account_mismatch" };
  }
  if (input.authenticatedProviderAccountId !== input.snapshot.providerAccountId) {
    return { ok: false, error: "reconnect_account_mismatch" };
  }
  return { ok: true };
};
