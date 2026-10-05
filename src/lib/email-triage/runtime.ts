import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EmailTriageAccount } from "../../domain/email-triage";
import type { AppRepository } from "../storage/repository";
import { isTauriRuntime } from "../storage/factory";
import { createEntityId, nowIso } from "../gtd/shared";
import { acquireOAuthLoopbackLease } from "../oauth-loopback-guard";
import { createTauriYahooImapClient } from "./providers/yahoo-api";
import { clearCachedYahooAppPassword, serializeYahooCredentials } from "./oauth/yahoo-credentials";
import { createTauriHttpClient } from "./provider-http";
import {
  exchangeAuthorizationCode,
  maskEmailAddress,
  serializeProviderCredentials,
  type OAuthTokens,
} from "./oauth/shared";
import {
  gmailOAuthProvider,
  microsoftOAuthProvider,
  type OAuthProviderDescriptor,
  type OAuthProfile,
} from "./oauth/providers";
import {
  snapshotReconnectTarget,
  type ReconnectTargetSnapshot,
  validateReconnectCanProceed,
} from "./reconnect-guard";
import {
  createPkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  validateOAuthState,
} from "./oauth/pkce";
import { clearCachedAccessToken, setCachedAccessToken } from "./token-cache";
import { checkVaultAvailability, deleteVaultSecret } from "./vault";
import {
  getEmailTriageCoordinator,
  persistProviderAccountCredentials,
  persistYahooAccountCredentials,
} from "./provider-session";

export {
  createEmailTriageAdapter,
  getEmailTriageCoordinator,
  persistProviderAccountCredentials,
  persistYahooAccountCredentials,
  setEmailTriageCoordinator,
  syncEmailTriageAccountNow,
} from "./provider-session";

export interface ProviderConnectResult {
  ok: boolean;
  accountId?: string;
  error?: string;
  reconnectMismatch?: boolean;
}

export type GmailConnectResult = ProviderConnectResult;
export type MicrosoftConnectResult = ProviderConnectResult;
export type YahooConnectResult = ProviderConnectResult;

export interface OAuthConnectOptions {
  reconnectAccountId?: string | null;
  clientId?: string | null;
}

export const connectOAuthAccount = async (
  repository: AppRepository,
  descriptor: OAuthProviderDescriptor,
  options: OAuthConnectOptions = {},
): Promise<ProviderConnectResult> => {
  if (!isTauriRuntime()) return { ok: false, error: "browser_preview" };
  let settings = await repository.emailTriage.getGlobalSettings();
  const key = descriptor.settingsClientIdKey;
  const draftClientId = options.clientId?.trim();
  if (draftClientId && draftClientId !== settings[key].trim()) {
    settings = { ...settings, [key]: draftClientId, updatedAt: nowIso() };
    await repository.emailTriage.saveGlobalSettings(settings);
  }
  const clientId = descriptor.resolveClientId(settings[key]);
  if (!clientId) return { ok: false, error: "missing_client_id" };

  let reconnectSnapshot: ReconnectTargetSnapshot | null = null;
  if (options.reconnectAccountId) {
    const target = await repository.emailTriage.getAccount(options.reconnectAccountId);
    if (!target) return { ok: false, error: "account_not_found" };
    reconnectSnapshot = snapshotReconnectTarget(target);
  }

  const loopbackLease = acquireOAuthLoopbackLease("email_triage");
  if (!loopbackLease.ok) {
    return { ok: false, error: "oauth_loopback_busy" };
  }
  let tokens: OAuthTokens;
  const http = createTauriHttpClient();
  try {
    const oauthState = generateOAuthState();
    const verifier = generatePkceVerifier();
    const challenge = await createPkceChallenge(verifier);
    const loopback = await invoke<{ port: number; redirectUri: string }>("oauth_loopback_start", {
      expectedState: oauthState,
    });
    await openUrl(
      descriptor.authUrl({
        clientId,
        redirectUri: loopback.redirectUri,
        state: oauthState,
        codeChallenge: challenge,
      }),
    );
    const callback = await invoke<{
      code?: string;
      state?: string;
      error?: string;
      errorDescription?: string;
    }>("oauth_loopback_wait", { timeoutMs: 180_000 });
    if (callback.error) {
      return {
        ok: false,
        error: descriptor.mapCallbackError(callback.error, callback.errorDescription),
      };
    }
    if (!validateOAuthState(oauthState, callback.state) || !callback.code) {
      return { ok: false, error: "oauth_state_mismatch" };
    }
    try {
      tokens = await exchangeAuthorizationCode(
        http,
        descriptor.tokenUrl,
        {
          clientId,
          code: callback.code,
          redirectUri: loopback.redirectUri,
          codeVerifier: verifier,
        },
        descriptor.exchangePolicy,
        descriptor.tokenScope,
      );
    } catch (error) {
      if (descriptor.mapConnectError) {
        return { ok: false, error: descriptor.mapConnectError(error, "exchange") };
      }
      throw error;
    }
  } finally {
    loopbackLease.lease.release();
  }
  if (!tokens.refreshToken) return { ok: false, error: "missing_refresh_token" };
  const refreshToken = tokens.refreshToken;
  let profile: OAuthProfile;
  setCachedAccessToken("oauth-bootstrap", tokens.accessToken, tokens.expiresIn);
  try {
    profile = await descriptor.fetchProfile(http, tokens.accessToken);
  } catch (error) {
    if (descriptor.mapConnectError)
      return { ok: false, error: descriptor.mapConnectError(error, "profile") };
    throw error;
  } finally {
    clearCachedAccessToken("oauth-bootstrap");
  }
  const { providerAccountId, displayAddress } = profile;
  const timestamp = nowIso();
  const existing = (await repository.emailTriage.listAccounts()).find(
    (account) =>
      account.provider === descriptor.provider && account.providerAccountId === providerAccountId,
  );
  const coordinator = getEmailTriageCoordinator();
  const persist = (account: EmailTriageAccount) =>
    persistProviderAccountCredentials({
      repository,
      account,
      credentials: serializeProviderCredentials({
        refreshToken,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
      }),
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });

  if (reconnectSnapshot) {
    const validation = validateReconnectCanProceed({
      snapshot: reconnectSnapshot,
      currentAccount: await repository.emailTriage.getAccount(reconnectSnapshot.id),
      authenticatedProviderAccountId: providerAccountId,
    });
    if (!validation.ok)
      return {
        ok: false,
        error: validation.error,
        reconnectMismatch: validation.error === "reconnect_account_mismatch",
      };
    const target = (await repository.emailTriage.getAccount(reconnectSnapshot.id))!;
    await persist({
      ...target,
      enabled: true,
      state: "active",
      recoveryState: "none",
      lastError: null,
      syncState: { ...target.syncState },
      updatedAt: timestamp,
    });
    coordinator?.scheduleAccount(
      { ...(await repository.emailTriage.getAccount(target.id))! },
      settings,
    );
    void coordinator?.runAccountSync(target.id);
    return { ok: true, accountId: target.id };
  }
  const accountId = existing?.id ?? createEntityId("email-account");
  const account: EmailTriageAccount =
    existing && descriptor.preserveExistingAccount
      ? {
          ...existing,
          label: displayAddress,
          maskedAddress: maskEmailAddress(displayAddress),
          enabled: true,
          state: "active",
          lastError: null,
          recoveryState: "none",
          updatedAt: timestamp,
        }
      : {
          id: accountId,
          provider: descriptor.provider,
          providerAccountId,
          label: displayAddress,
          maskedAddress: maskEmailAddress(displayAddress),
          generation: existing?.generation ?? 1,
          enabled: true,
          mutationEnabled: false,
          paused: false,
          state: descriptor.initialAccountState,
          recoveryState: "none",
          lastSuccessAt: null,
          lastError: null,
          pollIntervalMinutes: settings.pollIntervalMinutes,
          syncState: existing?.syncState ?? descriptor.initialSyncState(profile),
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
  await persist(account);
  coordinator?.scheduleAccount(account, settings);
  void coordinator?.runAccountSync(accountId);
  return { ok: true, accountId };
};

export const connectGmailAccount = (
  repository: AppRepository,
  options: OAuthConnectOptions = {},
): Promise<GmailConnectResult> => connectOAuthAccount(repository, gmailOAuthProvider, options);
export const connectMicrosoftAccount = (
  repository: AppRepository,
  options: OAuthConnectOptions = {},
): Promise<MicrosoftConnectResult> =>
  connectOAuthAccount(repository, microsoftOAuthProvider, options);

export const connectYahooAccount = async (
  repository: AppRepository,
  input: { email: string; appPassword: string; reconnectAccountId?: string | null },
): Promise<YahooConnectResult> => {
  if (!isTauriRuntime()) {
    return { ok: false, error: "browser_preview" };
  }
  const vault = await checkVaultAvailability();
  if (!vault.available) {
    return { ok: false, error: "vault_unavailable" };
  }

  const email = input.email.trim().toLowerCase();
  const appPassword = input.appPassword.trim();
  if (!email || !appPassword) {
    return { ok: false, error: "missing_credentials" };
  }

  let reconnectSnapshot: ReconnectTargetSnapshot | null = null;
  if (input.reconnectAccountId) {
    const target = await repository.emailTriage.getAccount(input.reconnectAccountId);
    if (!target) {
      return { ok: false, error: "account_not_found" };
    }
    reconnectSnapshot = snapshotReconnectTarget(target);
  }

  const imap = createTauriYahooImapClient();
  try {
    await imap.discover({ email, appPassword });
  } catch (error) {
    if (error instanceof Error && error.message === "reconnect_required") {
      return { ok: false, error: "reconnect_required" };
    }
    return { ok: false, error: "connect_failed" };
  }

  const settings = await repository.emailTriage.getGlobalSettings();
  const timestamp = nowIso();
  const existing = (await repository.emailTriage.listAccounts()).find(
    (account) => account.provider === "yahoo" && account.providerAccountId === email,
  );
  const coordinator = getEmailTriageCoordinator();
  const credentials = serializeYahooCredentials({
    email,
    appPassword,
    kind: "yahoo_app_password",
  });

  if (reconnectSnapshot) {
    const validation = validateReconnectCanProceed({
      snapshot: reconnectSnapshot,
      currentAccount: await repository.emailTriage.getAccount(reconnectSnapshot.id),
      authenticatedProviderAccountId: email,
    });
    if (!validation.ok) {
      return {
        ok: false,
        error: validation.error,
        reconnectMismatch: validation.error === "reconnect_account_mismatch",
      };
    }
    const target = (await repository.emailTriage.getAccount(reconnectSnapshot.id))!;
    await persistYahooAccountCredentials({
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
      credentials,
      appPassword,
    });
    coordinator?.scheduleAccount(
      {
        ...(await repository.emailTriage.getAccount(target.id))!,
      },
      settings,
    );
    void coordinator?.runAccountSync(target.id);
    return { ok: true, accountId: target.id };
  }

  const accountId = existing?.id ?? createEntityId("email-account");
  const account: EmailTriageAccount = existing
    ? {
        ...existing,
        enabled: true,
        state: "active",
        lastError: null,
        recoveryState: "none",
        updatedAt: timestamp,
      }
    : {
        id: accountId,
        provider: "yahoo",
        providerAccountId: email,
        label: email,
        maskedAddress: maskEmailAddress(email),
        generation: 1,
        enabled: true,
        mutationEnabled: false,
        paused: false,
        state: "baselining",
        recoveryState: "none",
        lastSuccessAt: null,
        lastError: null,
        pollIntervalMinutes: settings.pollIntervalMinutes,
        syncState: {
          trackedMessageIds: [],
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  await persistYahooAccountCredentials({
    repository,
    account,
    credentials,
    appPassword,
  });
  coordinator?.scheduleAccount(account, settings);
  void coordinator?.runAccountSync(accountId);
  return { ok: true, accountId };
};

export const disconnectEmailTriageAccount = async (
  repository: AppRepository,
  accountId: string,
): Promise<void> => {
  const account = await repository.emailTriage.getAccount(accountId);
  if (!account) {
    return;
  }
  getEmailTriageCoordinator()?.invalidateAccount(accountId);
  await deleteVaultSecret("provider_credentials", accountId);
  clearCachedAccessToken(accountId);
  clearCachedYahooAppPassword(accountId);
  await repository.emailTriage.saveAccount({
    ...account,
    enabled: false,
    state: "disconnected",
    generation: account.generation + 1,
    lastError: null,
    updatedAt: nowIso(),
  });
};

export const disconnectGmailAccount = disconnectEmailTriageAccount;

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

export { persistProviderAccountCredentials as persistGmailAccountCredentials } from "./provider-session";
