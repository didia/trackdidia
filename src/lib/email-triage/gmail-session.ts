import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import type { AppRepository } from "../storage/repository";
import { isTauriRuntime } from "../storage/factory";
import { MockGmailAdapter } from "./providers/mock-gmail";
import { MockGraphAdapter } from "./providers/mock-graph";
import { MockYahooAdapter } from "./providers/mock-yahoo";
import type { EmailTriageProviderAdapter } from "./providers/types";
import { GmailAdapter } from "./providers/gmail-adapter";
import { GmailApiClient } from "./providers/gmail-api";
import { GraphAdapter } from "./providers/graph-adapter";
import { GraphApiClient } from "./providers/graph-api";
import { createTauriHttpClient, isInvalidGrantError } from "./provider-http";
import {
  parseProviderCredentials,
  refreshGmailAccessToken,
  resolveGmailOAuthClientId,
} from "./oauth/gmail-oauth";
import {
  refreshMicrosoftAccessToken,
  resolveMicrosoftOAuthClientId,
} from "./oauth/microsoft-oauth";
import { clearCachedAccessToken, getCachedAccessToken, setCachedAccessToken } from "./token-cache";
import { deleteVaultSecret, loadVaultSecret, storeVaultSecret } from "./vault";
import type { EmailTriageCoordinator } from "./coordinator";

let coordinatorRef: EmailTriageCoordinator | null = null;

export const setEmailTriageCoordinator = (coordinator: EmailTriageCoordinator | null): void => {
  coordinatorRef = coordinator;
};

export const getEmailTriageCoordinator = (): EmailTriageCoordinator | null => coordinatorRef;

export const syncEmailTriageAccountNow = async (
  accountId: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const coordinator = coordinatorRef;
  if (!coordinator) {
    return { ok: false, reason: "coordinator_not_running" };
  }
  return coordinator.syncNow(accountId);
};

const createGmailAccessTokenGetter = (
  account: EmailTriageAccount,
  clientId: string,
): (() => Promise<string>) => {
  return async () => {
    const cached = getCachedAccessToken(account.id);
    if (cached) {
      return cached;
    }
    const raw = await loadVaultSecret("provider_credentials", account.id);
    const credentials = parseProviderCredentials(raw);
    if (!credentials) {
      throw new Error("reconnect_required");
    }
    try {
      const refreshed = await refreshGmailAccessToken(createTauriHttpClient(), {
        clientId,
        refreshToken: credentials.refreshToken,
      });
      setCachedAccessToken(account.id, refreshed.accessToken, refreshed.expiresIn);
      return refreshed.accessToken;
    } catch (error) {
      if (
        isInvalidGrantError(error) ||
        (error instanceof Error && error.message.includes("invalid_grant"))
      ) {
        throw new Error("reconnect_required");
      }
      throw error;
    }
  };
};

const createMicrosoftAccessTokenGetter = (
  account: EmailTriageAccount,
  clientId: string,
): (() => Promise<string>) => {
  return async () => {
    const cached = getCachedAccessToken(account.id);
    if (cached) {
      return cached;
    }
    const raw = await loadVaultSecret("provider_credentials", account.id);
    const credentials = parseProviderCredentials(raw);
    if (!credentials) {
      throw new Error("reconnect_required");
    }
    try {
      const refreshed = await refreshMicrosoftAccessToken(createTauriHttpClient(), {
        clientId,
        refreshToken: credentials.refreshToken,
      });
      setCachedAccessToken(account.id, refreshed.accessToken, refreshed.expiresIn);
      return refreshed.accessToken;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "reconnect_required" || error.message.includes("invalid_grant"))
      ) {
        throw new Error("reconnect_required");
      }
      throw error;
    }
  };
};

export const createEmailTriageAdapter = async (
  account: EmailTriageAccount,
  settings: EmailTriageGlobalSettings,
): Promise<EmailTriageProviderAdapter | null> => {
  if (account.provider === "yahoo") {
    return new MockYahooAdapter([]);
  }
  if (!isTauriRuntime()) {
    if (account.provider === "gmail") {
      return new MockGmailAdapter([], new Map());
    }
    if (account.provider === "microsoft_graph") {
      return new MockGraphAdapter([]);
    }
    return null;
  }
  const credentials = parseProviderCredentials(
    await loadVaultSecret("provider_credentials", account.id),
  );
  if (account.provider === "gmail") {
    if (!credentials) {
      return null;
    }
    const clientId = resolveGmailOAuthClientId(settings.gmailOAuthClientId);
    if (!clientId) {
      return null;
    }
    const http = createTauriHttpClient();
    const getAccessToken = createGmailAccessTokenGetter(account, clientId);
    const api = new GmailApiClient(http, getAccessToken);
    const email = account.providerAccountId;
    return new GmailAdapter(api, email, () => {
      const tracked = account.syncState.trackedMessageIds;
      return Array.isArray(tracked) ? (tracked as string[]) : [];
    });
  }
  if (account.provider === "microsoft_graph") {
    if (!credentials) {
      return null;
    }
    const clientId = resolveMicrosoftOAuthClientId(settings.microsoftOAuthClientId);
    if (!clientId) {
      return null;
    }
    const http = createTauriHttpClient();
    const getAccessToken = createMicrosoftAccessTokenGetter(account, clientId);
    const api = new GraphApiClient(http, getAccessToken);
    return new GraphAdapter(api, () => {
      const tracked = account.syncState.trackedMessageIds;
      return Array.isArray(tracked) ? (tracked as string[]) : [];
    });
  }
  return null;
};

export const persistGmailAccountCredentials = async (options: {
  repository: Pick<AppRepository, "saveEmailTriageAccount">;
  account: EmailTriageAccount;
  credentials: string;
  accessToken: string;
  expiresIn: number;
}): Promise<void> => {
  const previous = await loadVaultSecret("provider_credentials", options.account.id);
  await storeVaultSecret("provider_credentials", options.credentials, options.account.id);
  setCachedAccessToken(options.account.id, options.accessToken, options.expiresIn);
  try {
    await options.repository.saveEmailTriageAccount(options.account);
  } catch (error) {
    clearCachedAccessToken(options.account.id);
    try {
      if (previous) {
        await storeVaultSecret("provider_credentials", previous, options.account.id);
      } else {
        await deleteVaultSecret("provider_credentials", options.account.id);
      }
    } catch {
      // Prefer the original persistence error over a compensating-vault failure.
    }
    throw error;
  }
};
