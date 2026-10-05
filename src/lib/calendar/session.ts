/**
 * Access-token handling for the single connected Google Calendar account. There is only
 * ever one account (unlike email triage's per-account map), so the in-memory access-token
 * cache (`src/lib/email-triage/token-cache.ts`) is keyed by one fixed id.
 */
import { createTauriHttpClient } from "../email-triage/provider-http";
import {
  clearCachedAccessToken,
  getCachedAccessToken,
  setCachedAccessToken,
} from "../email-triage/token-cache";
import type { CalendarSyncSettings } from "../../domain/calendar-sync";
import { GoogleCalendarApiClient, isCalendarSyncInvalidGrantError } from "./google-calendar-api";
import {
  parseCalendarSyncCredentials,
  refreshCalendarSyncAccessToken,
  resolveCalendarSyncOAuthClientId,
} from "./google-calendar-oauth";
import { loadCalendarVaultSecret } from "./vault";

/** Fixed cache key: only one calendar account is ever connected. */
export const CALENDAR_SYNC_TOKEN_CACHE_KEY = "calendar-sync";

export const clearCalendarSyncAccessTokenCache = (): void =>
  clearCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY);

/**
 * Builds an access-token getter that serves the in-memory cache first, then refreshes from
 * the vault-stored refresh token. Throws `reconnect_required` when no credentials are
 * stored or the refresh token has been revoked (`invalid_grant`), matching the email-triage
 * convention consumed by the reconciler (Phase 2).
 */
export const createCalendarSyncAccessTokenGetter = (
  clientId: string,
): ((forceRefresh?: boolean) => Promise<string>) => {
  return async (forceRefresh = false) => {
    if (forceRefresh) clearCalendarSyncAccessTokenCache();
    const cached = getCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY);
    if (cached) {
      return cached;
    }
    const raw = await loadCalendarVaultSecret("calendar_credentials");
    const credentials = parseCalendarSyncCredentials(raw);
    if (!credentials) {
      throw new Error("reconnect_required");
    }
    try {
      const refreshed = await refreshCalendarSyncAccessToken(createTauriHttpClient(), {
        clientId,
        refreshToken: credentials.refreshToken,
      });
      setCachedAccessToken(
        CALENDAR_SYNC_TOKEN_CACHE_KEY,
        refreshed.accessToken,
        refreshed.expiresIn,
      );
      return refreshed.accessToken;
    } catch (error) {
      if (
        isCalendarSyncInvalidGrantError(error) ||
        (error instanceof Error && error.message.includes("invalid_grant"))
      ) {
        throw new Error("reconnect_required");
      }
      throw error;
    }
  };
};

/** `null` when no OAuth client id is configured yet (no Settings UI path can reach it). */
export const createCalendarSyncApiClient = (
  settings: Pick<CalendarSyncSettings, "oauthClientId">,
): GoogleCalendarApiClient | null => {
  const clientId = resolveCalendarSyncOAuthClientId(settings.oauthClientId);
  if (!clientId) {
    return null;
  }
  return new GoogleCalendarApiClient(
    createTauriHttpClient(),
    createCalendarSyncAccessTokenGetter(clientId),
  );
};
