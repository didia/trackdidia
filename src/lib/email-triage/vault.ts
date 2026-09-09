import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";

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

export const storeVaultSecret = async (
  kind: EmailTriageVaultEntryKind,
  secret: string,
  accountId: string | null = null,
): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error("Vault unavailable in browser preview");
  }
  await invoke("vault_store_secret", {
    kind,
    secret,
    accountId,
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
      kind,
      accountId,
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
    kind,
    accountId,
  });
};
