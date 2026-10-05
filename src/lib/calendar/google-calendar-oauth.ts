/**
 * Google Calendar OAuth: reuses the Gmail installed-app flow (PKCE, loopback, same Google
 * token endpoint) from `src/lib/email-triage/oauth/gmail-oauth.ts`, with a calendar-scoped
 * authorization URL. See "Auth machinery" in `specs/todo/calendar-sync.md`.
 */
import {
  GMAIL_AUTH_URL,
  exchangeGmailAuthorizationCode,
  maskEmailAddress,
  parseProviderCredentials,
  refreshGmailAccessToken,
  serializeProviderCredentials,
  type GmailOAuthTokens,
  type GmailProviderCredentials,
} from "../email-triage/oauth/gmail-oauth";

export const CALENDAR_SYNC_OAUTH_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

/**
 * `calendar.app.created` alone cannot read the primary calendar or the account's email;
 * the minimal, non-sensitive `email` scope is requested alongside it so the connected
 * account can be identified via `GoogleCalendarApiClient.getAccountProfile`.
 */
export const CALENDAR_SYNC_OAUTH_REQUESTED_SCOPES = `${CALENDAR_SYNC_OAUTH_SCOPE} email`;

export type CalendarSyncOAuthTokens = GmailOAuthTokens;
export type CalendarSyncProviderCredentials = GmailProviderCredentials;

// Reused, not duplicated: the authorization-code exchange and refresh calls hit the same
// Google token endpoint regardless of requested scope, so the Gmail helpers apply as-is.
export {
  exchangeGmailAuthorizationCode as exchangeCalendarSyncAuthorizationCode,
  refreshGmailAccessToken as refreshCalendarSyncAccessToken,
  parseProviderCredentials as parseCalendarSyncCredentials,
  serializeProviderCredentials as serializeCalendarSyncCredentials,
  maskEmailAddress as maskCalendarSyncAccountEmail,
};

export const buildCalendarSyncAuthorizationUrl = (options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string => {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: CALENDAR_SYNC_OAUTH_REQUESTED_SCOPES,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
};

export const resolveCalendarSyncOAuthClientId = (
  settingsClientId: string,
  envClientId: string | undefined = import.meta.env.VITE_CALENDAR_OAUTH_CLIENT_ID,
): string => settingsClientId.trim() || (envClientId?.trim() ?? "");
