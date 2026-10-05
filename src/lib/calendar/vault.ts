/**
 * OS-vault access for the Google Calendar refresh token. Mirrors
 * `src/lib/email-triage/vault.ts`, with a single fixed `calendar_credentials` kind: there is
 * only ever one connected calendar account, so no `accountId` is needed. See
 * `src-tauri/src/vault.rs` `resolve_key` for the native side.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";

export type CalendarVaultEntryKind = "calendar_credentials";

export interface CalendarVaultAvailability {
  available: boolean;
  reason: string | null;
}

export const checkCalendarVaultAvailability = async (): Promise<CalendarVaultAvailability> => {
  if (!isTauriRuntime()) {
    return { available: false, reason: "browser_preview" };
  }
  try {
    return await invoke<CalendarVaultAvailability>("vault_check_availability");
  } catch {
    return { available: false, reason: "vault_unavailable" };
  }
};

export const storeCalendarVaultSecret = async (
  kind: CalendarVaultEntryKind,
  secret: string,
): Promise<void> => {
  if (!isTauriRuntime()) {
    throw new Error("Vault unavailable in browser preview");
  }
  await invoke("vault_store_secret", {
    kind,
    secret,
    accountId: null,
  });
};

export const loadCalendarVaultSecret = async (
  kind: CalendarVaultEntryKind,
  options: { throwOnError?: boolean } = {},
): Promise<string | null> => {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<string | null>("vault_load_secret", {
      kind,
      accountId: null,
    });
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
};

export const deleteCalendarVaultSecret = async (kind: CalendarVaultEntryKind): Promise<void> => {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("vault_delete_secret", {
    kind,
    accountId: null,
  });
};
