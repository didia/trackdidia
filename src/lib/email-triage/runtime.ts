import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import type { AppRepository } from "../storage/repository";
import { isTauriRuntime } from "../storage/factory";
import { createEntityId, nowIso } from "../gtd/shared";
import { MockGmailAdapter } from "./providers/mock-gmail";
import { MockGraphAdapter } from "./providers/mock-graph";
import { MockYahooAdapter } from "./providers/mock-yahoo";
import type { EmailTriageProviderAdapter } from "./providers/types";
import { GmailAdapter } from "./providers/gmail-adapter";
import { GmailApiClient } from "./providers/gmail-api";
import { createTauriHttpClient, isInvalidGrantError } from "./provider-http";
import {
  exchangeGmailAuthorizationCode,
  maskEmailAddress,
  parseProviderCredentials,
  refreshGmailAccessToken,
  resolveGmailOAuthClientId,
  serializeProviderCredentials,
  buildGmailAuthorizationUrl,
} from "./oauth/gmail-oauth";
import { createPkceChallenge, generateOAuthState, generatePkceVerifier, validateOAuthState } from "./oauth/pkce";
import {
  clearCachedAccessToken,
  getCachedAccessToken,
  setCachedAccessToken,
} from "./token-cache";
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
  if (!coordinator.isRunning()) {
    return { ok: false, reason: "coordinator_not_running" };
  }
  await coordinator.runAccountSync(accountId);
  return { ok: true };
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
      if (isInvalidGrantError(error) || (error instanceof Error && error.message.includes("invalid_grant"))) {
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
  if (account.provider === "microsoft_graph") {
    return new MockGraphAdapter([]);
  }
  if (account.provider === "yahoo") {
    return new MockYahooAdapter([]);
  }
  if (account.provider !== "gmail") {
    return null;
  }
  if (!isTauriRuntime()) {
    return new MockGmailAdapter([], new Map());
  }
  const credentials = parseProviderCredentials(
    await loadVaultSecret("provider_credentials", account.id),
  );
  if (!credentials) {
    return new MockGmailAdapter([], new Map());
  }
  const clientId = resolveGmailOAuthClientId(settings.gmailOAuthClientId);
  if (!clientId) {
    return new MockGmailAdapter([], new Map());
  }
  const http = createTauriHttpClient();
  const getAccessToken = createGmailAccessTokenGetter(account, clientId);
  const api = new GmailApiClient(http, getAccessToken);
  const email = account.providerAccountId;
  return new GmailAdapter(api, email, () => {
    const tracked = account.syncState.trackedMessageIds;
    return Array.isArray(tracked) ? (tracked as string[]) : [];
  });
};

export interface GmailConnectResult {
  ok: boolean;
  accountId?: string;
  error?: string;
  reconnectMismatch?: boolean;
}

export const connectGmailAccount = async (
  repository: AppRepository,
  options: { reconnectAccountId?: string | null } = {},
): Promise<GmailConnectResult> => {
  if (!isTauriRuntime()) {
    return { ok: false, error: "browser_preview" };
  }
  const settings = await repository.getEmailTriageGlobalSettings();
  const clientId = resolveGmailOAuthClientId(settings.gmailOAuthClientId);
  if (!clientId) {
    return { ok: false, error: "missing_client_id" };
  }

  const oauthState = generateOAuthState();
  const verifier = generatePkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  const loopback = await invoke<{ port: number; redirectUri: string }>("oauth_loopback_start", {
    expectedState: oauthState,
  });
  const authUrl = buildGmailAuthorizationUrl({
    clientId,
    redirectUri: loopback.redirectUri,
    state: oauthState,
    codeChallenge: challenge,
  });
  await openUrl(authUrl);
  const callback = await invoke<{ code?: string; state?: string; error?: string }>(
    "oauth_loopback_wait",
    { timeoutMs: 180_000 },
  );
  if (callback.error) {
    return { ok: false, error: callback.error };
  }
  if (!validateOAuthState(oauthState, callback.state) || !callback.code) {
    return { ok: false, error: "oauth_state_mismatch" };
  }

  const http = createTauriHttpClient();
  const tokens = await exchangeGmailAuthorizationCode(http, {
    clientId,
    code: callback.code,
    redirectUri: loopback.redirectUri,
    codeVerifier: verifier,
  });
  if (!tokens.refreshToken) {
    return { ok: false, error: "missing_refresh_token" };
  }

  setCachedAccessToken("oauth-bootstrap", tokens.accessToken, tokens.expiresIn);
  const bootstrapApi = new GmailApiClient(http, async () => tokens.accessToken);
  const profile = await bootstrapApi.getProfile();
  clearCachedAccessToken("oauth-bootstrap");

  const providerAccountId = profile.emailAddress.trim().toLowerCase();
  const timestamp = nowIso();
  const existing = (await repository.listEmailTriageAccounts()).find(
    (account) => account.provider === "gmail" && account.providerAccountId === providerAccountId,
  );

  if (options.reconnectAccountId) {
    const target = await repository.getEmailTriageAccount(options.reconnectAccountId);
    if (!target) {
      return { ok: false, error: "account_not_found" };
    }
    if (target.providerAccountId !== providerAccountId) {
      return { ok: false, error: "reconnect_account_mismatch", reconnectMismatch: true };
    }
    await storeVaultSecret(
      "provider_credentials",
      serializeProviderCredentials({
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
      }),
      target.id,
    );
    setCachedAccessToken(target.id, tokens.accessToken, tokens.expiresIn);
    await repository.saveEmailTriageAccount({
      ...target,
      enabled: true,
      state: "active",
      recoveryState: "none",
      lastError: null,
      syncState: {
        ...target.syncState,
        baselineHistoryId: profile.historyId,
        cursorHistoryId: profile.historyId,
      },
      updatedAt: timestamp,
    });
    coordinatorRef?.scheduleAccount(
      {
        ...(await repository.getEmailTriageAccount(target.id))!,
      },
      settings,
    );
    void coordinatorRef?.runAccountSync(target.id);
    return { ok: true, accountId: target.id };
  }

  const accountId = existing?.id ?? createEntityId("email-account");
  await storeVaultSecret(
    "provider_credentials",
    serializeProviderCredentials({
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
    }),
    accountId,
  );
  setCachedAccessToken(accountId, tokens.accessToken, tokens.expiresIn);

  const account: EmailTriageAccount = {
    id: accountId,
    provider: "gmail",
    providerAccountId,
    label: profile.emailAddress,
    maskedAddress: maskEmailAddress(profile.emailAddress),
    generation: existing?.generation ?? 1,
    enabled: true,
    mutationEnabled: false,
    paused: false,
    state: "active",
    recoveryState: "none",
    lastSuccessAt: null,
    lastError: null,
    pollIntervalMinutes: settings.pollIntervalMinutes,
    syncState: {
      baselineHistoryId: profile.historyId,
      cursorHistoryId: profile.historyId,
      trackedMessageIds: [],
    },
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await repository.saveEmailTriageAccount(account);
  coordinatorRef?.scheduleAccount(account, settings);
  void coordinatorRef?.runAccountSync(accountId);
  return { ok: true, accountId };
};

export const disconnectGmailAccount = async (
  repository: AppRepository,
  accountId: string,
): Promise<void> => {
  const account = await repository.getEmailTriageAccount(accountId);
  if (!account) {
    return;
  }
  await deleteVaultSecret("provider_credentials", accountId);
  clearCachedAccessToken(accountId);
  await repository.saveEmailTriageAccount({
    ...account,
    enabled: false,
    state: "disconnected",
    generation: account.generation + 1,
    lastError: null,
    updatedAt: nowIso(),
  });
};

export const openExternalUrl = async (url: string, browserPreview: boolean): Promise<void> => {
  if (browserPreview || !isTauriRuntime()) {
    return;
  }
  await openUrl(url);
};
