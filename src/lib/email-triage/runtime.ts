import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EmailTriageAccount } from "../../domain/email-triage";
import type { AppRepository } from "../storage/repository";
import { isTauriRuntime } from "../storage/factory";
import { createEntityId, nowIso } from "../gtd/shared";
import { GmailApiClient } from "./providers/gmail-api";
import { createTauriHttpClient } from "./provider-http";
import {
  exchangeGmailAuthorizationCode,
  maskEmailAddress,
  resolveGmailOAuthClientId,
  serializeProviderCredentials,
  buildGmailAuthorizationUrl,
} from "./oauth/gmail-oauth";
import {
  createPkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  validateOAuthState,
} from "./oauth/pkce";
import { clearCachedAccessToken, setCachedAccessToken } from "./token-cache";
import { deleteVaultSecret } from "./vault";
import { getEmailTriageCoordinator, persistGmailAccountCredentials } from "./gmail-session";

export {
  createEmailTriageAdapter,
  getEmailTriageCoordinator,
  persistGmailAccountCredentials,
  setEmailTriageCoordinator,
  syncEmailTriageAccountNow,
} from "./gmail-session";

export interface GmailConnectResult {
  ok: boolean;
  accountId?: string;
  error?: string;
  reconnectMismatch?: boolean;
}

export const connectGmailAccount = async (
  repository: AppRepository,
  options: { reconnectAccountId?: string | null; clientId?: string | null } = {},
): Promise<GmailConnectResult> => {
  if (!isTauriRuntime()) {
    return { ok: false, error: "browser_preview" };
  }
  let settings = await repository.getEmailTriageGlobalSettings();
  const draftClientId = options.clientId?.trim();
  if (draftClientId && draftClientId !== settings.gmailOAuthClientId.trim()) {
    settings = {
      ...settings,
      gmailOAuthClientId: draftClientId,
      updatedAt: nowIso(),
    };
    await repository.saveEmailTriageGlobalSettings(settings);
  }
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
  const coordinator = getEmailTriageCoordinator();

  if (options.reconnectAccountId) {
    const target = await repository.getEmailTriageAccount(options.reconnectAccountId);
    if (!target) {
      return { ok: false, error: "account_not_found" };
    }
    if (target.providerAccountId !== providerAccountId) {
      return { ok: false, error: "reconnect_account_mismatch", reconnectMismatch: true };
    }
    await persistGmailAccountCredentials({
      repository,
      account: {
        ...target,
        enabled: true,
        state: "active",
        recoveryState: "none",
        lastError: null,
        syncState: {
          ...target.syncState,
        },
        updatedAt: timestamp,
      },
      credentials: serializeProviderCredentials({
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
      }),
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });
    coordinator?.scheduleAccount(
      {
        ...(await repository.getEmailTriageAccount(target.id))!,
      },
      settings,
    );
    void coordinator?.runAccountSync(target.id);
    return { ok: true, accountId: target.id };
  }

  const accountId = existing?.id ?? createEntityId("email-account");
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
    syncState: existing?.syncState ?? {
      baselineHistoryId: profile.historyId,
      cursorHistoryId: profile.historyId,
      trackedMessageIds: [],
    },
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await persistGmailAccountCredentials({
    repository,
    account,
    credentials: serializeProviderCredentials({
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      scope: tokens.scope,
    }),
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
  });
  coordinator?.scheduleAccount(account, settings);
  void coordinator?.runAccountSync(accountId);
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
  getEmailTriageCoordinator()?.invalidateAccount(accountId);
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
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return;
  }
  await openUrl(url);
};
