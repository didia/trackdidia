/**
 * Connect / reconnect / disconnect the single Google Calendar connection. Mirrors the shape
 * of `src/lib/email-triage/runtime.ts`'s Gmail connect flow: PKCE, loopback listener,
 * refresh token in the OS vault, access token in memory. See "Loopback collision" and the
 * Settings card section in `specs/todo/calendar-sync.md`.
 */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AppRepository } from "../storage/repository";
import { isTauriRuntime } from "../storage/factory";
import { nowIso } from "../gtd/shared";
import { createTauriHttpClient } from "../email-triage/provider-http";
import {
  createPkceChallenge,
  generateOAuthState,
  generatePkceVerifier,
  validateOAuthState,
} from "../email-triage/oauth/pkce";
import { acquireOAuthLoopbackLease } from "../oauth-loopback-guard";
import { GoogleCalendarApiClient } from "./google-calendar-api";
import {
  buildCalendarSyncAuthorizationUrl,
  exchangeCalendarSyncAuthorizationCode,
  resolveCalendarSyncOAuthClientId,
  serializeCalendarSyncCredentials,
  type CalendarSyncOAuthTokens,
} from "./google-calendar-oauth";
import { CALENDAR_SYNC_TOKEN_CACHE_KEY, clearCalendarSyncAccessTokenCache } from "./session";
import { deleteCalendarVaultSecret, storeCalendarVaultSecret } from "./vault";
import { setCachedAccessToken } from "../email-triage/token-cache";

export interface CalendarSyncConnectResult {
  ok: boolean;
  error?: string;
}

/**
 * Runs the OAuth flow and (re)connects the single calendar account. Safe to call again for
 * an already-connected account (reconnect): a different authenticated Google account bumps
 * `generation` and clears every link, handled by `saveCalendarSyncSettings`
 * (`src/lib/storage/calendar-sync-{sqlite,memory}-store.ts`); the same account keeps its
 * existing `calendarId` so `ensureCalendar` does not create a second calendar.
 */
export const connectCalendarSyncAccount = async (
  repository: AppRepository,
  options: { clientId?: string | null } = {},
): Promise<CalendarSyncConnectResult> => {
  if (!isTauriRuntime()) {
    return { ok: false, error: "browser_preview" };
  }

  let settings = await repository.getCalendarSyncSettings();
  const draftClientId = options.clientId?.trim();
  if (draftClientId && draftClientId !== settings.oauthClientId.trim()) {
    settings = { ...settings, oauthClientId: draftClientId, updatedAt: nowIso() };
    await repository.saveCalendarSyncSettings(settings);
  }
  const clientId = resolveCalendarSyncOAuthClientId(settings.oauthClientId);
  if (!clientId) {
    return { ok: false, error: "missing_client_id" };
  }

  const loopbackLease = acquireOAuthLoopbackLease("calendar_sync");
  if (!loopbackLease.ok) {
    return { ok: false, error: "oauth_loopback_busy" };
  }

  let tokens: CalendarSyncOAuthTokens;
  try {
    const oauthState = generateOAuthState();
    const verifier = generatePkceVerifier();
    const challenge = await createPkceChallenge(verifier);
    const loopback = await invoke<{ port: number; redirectUri: string }>("oauth_loopback_start", {
      expectedState: oauthState,
    });
    const authUrl = buildCalendarSyncAuthorizationUrl({
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

    tokens = await exchangeCalendarSyncAuthorizationCode(createTauriHttpClient(), {
      clientId,
      code: callback.code,
      redirectUri: loopback.redirectUri,
      codeVerifier: verifier,
    });
  } catch {
    return { ok: false, error: "connect_failed" };
  } finally {
    loopbackLease.lease.release();
  }
  if (!tokens.refreshToken) {
    return { ok: false, error: "missing_refresh_token" };
  }

  setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, tokens.accessToken, tokens.expiresIn);
  const bootstrapApi = new GoogleCalendarApiClient(
    createTauriHttpClient(),
    async () => tokens.accessToken,
  );
  let accountEmail: string;
  try {
    accountEmail = (await bootstrapApi.getAccountProfile()).email;
  } catch {
    clearCalendarSyncAccessTokenCache();
    return { ok: false, error: "connect_failed" };
  }

  const current = await repository.getCalendarSyncSettings();
  const sameAccount = current.connectedAccountId === accountEmail;
  let calendarId: string;
  try {
    calendarId = await bootstrapApi.ensureCalendar({
      existingCalendarId: sameAccount ? current.calendarId : null,
      summary: current.calendarSummary || "TrackDidia",
    });
  } catch {
    clearCalendarSyncAccessTokenCache();
    return { ok: false, error: "connect_failed" };
  }

  const timestamp = nowIso();
  const credentials = serializeCalendarSyncCredentials({
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
  });
  await storeCalendarVaultSecret("calendar_credentials", credentials);
  try {
    await repository.saveCalendarSyncSettings({
      ...current,
      enabled: true,
      oauthClientId: clientId,
      connectedAccountId: accountEmail,
      calendarId,
      state: "active",
      lastError: null,
      updatedAt: timestamp,
    });
  } catch (error) {
    clearCalendarSyncAccessTokenCache();
    await deleteCalendarVaultSecret("calendar_credentials");
    throw error;
  }
  return { ok: true };
};

/** Reconnect is the same flow as connect: identity comparison happens inside it. */
export const reconnectCalendarSyncAccount = connectCalendarSyncAccount;

export const disconnectCalendarSyncAccount = async (repository: AppRepository): Promise<void> => {
  const settings = await repository.getCalendarSyncSettings();
  await deleteCalendarVaultSecret("calendar_credentials");
  clearCalendarSyncAccessTokenCache();
  // Identity (connectedAccountId/calendarId) is kept so reconnecting the same account
  // resumes without bumping `generation` or clearing links; see "generation" in
  // specs/todo/calendar-sync.md.
  await repository.saveCalendarSyncSettings({
    ...settings,
    enabled: false,
    state: "disconnected",
    lastError: null,
    updatedAt: nowIso(),
  });
};
