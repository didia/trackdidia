import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";
import { EMAIL_TRIAGE_VAULT_SERVICE, EMAIL_TRIAGE_VAULT_TRIAGE_KEY } from "./constants";

export type EmailTriageVaultEntryKind = "triage_api_key" | "provider_credentials";

export interface VaultAvailability {
  available: boolean;
  reason: string | null;
}

export const checkVaultAvailability = async (): Promise<VaultAvailability> => {
  if (!isTauriRuntime()) {
    return { available: false, reason: "browser_preview" };
  }
  try {
    return await invoke<VaultAvailability>("vault_check_availability");
  } catch {
    return { available: false, reason: "vault_unavailable" };
  }
};

const vaultKeyFor = (accountId: string | null, kind: EmailTriageVaultEntryKind): string => {
  if (kind === "triage_api_key") {
    return EMAIL_TRIAGE_VAULT_TRIAGE_KEY;
  }
  return `${EMAIL_TRIAGE_VAULT_SERVICE}:provider:${accountId}`;
};

export const storeVaultSecret = async (
  kind: EmailTriageVaultEntryKind,
  secret: string,
  accountId: string | null = null,
): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error("Vault unavailable in browser preview");
  }
  await invoke("vault_store_secret", {
    service: EMAIL_TRIAGE_VAULT_SERVICE,
    key: vaultKeyFor(accountId, kind),
    secret,
  });
};

export const loadVaultSecret = async (
  kind: EmailTriageVaultEntryKind,
  accountId: string | null = null,
): Promise<string | null> => {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<string | null>("vault_load_secret", {
      service: EMAIL_TRIAGE_VAULT_SERVICE,
      key: vaultKeyFor(accountId, kind),
    });
  } catch {
    return null;
  }
};

export const deleteVaultSecret = async (
  kind: EmailTriageVaultEntryKind,
  accountId: string | null = null,
): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("vault_delete_secret", {
    service: EMAIL_TRIAGE_VAULT_SERVICE,
    key: vaultKeyFor(accountId, kind),
  });
};
