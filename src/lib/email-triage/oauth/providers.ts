import type { EmailTriageAccount } from "../../../domain/email-triage";
import { GmailApiClient } from "../providers/gmail-api";
import { GraphApiClient } from "../providers/graph-api";
import { isInvalidGrantError } from "../provider-http";
import {
  buildGmailAuthorizationUrl,
  GMAIL_TOKEN_URL,
  gmailExchangePolicy,
  gmailRefreshPolicy,
  resolveGmailOAuthClientId,
} from "./gmail-oauth";
import {
  buildMicrosoftAuthorizationUrl,
  classifyMicrosoftAuthorizationCallbackError,
  MICROSOFT_OAUTH_TOKEN_URL,
  MICROSOFT_OAUTH_SCOPE,
  microsoftTokenPolicy,
  resolveMicrosoftOAuthClientId,
} from "./microsoft-oauth";
import type { HttpClient, TokenResponsePolicy } from "./shared";

export interface OAuthProfile {
  providerAccountId: string;
  displayAddress: string;
  historyId?: string;
}
export interface OAuthProviderDescriptor {
  provider: "gmail" | "microsoft_graph";
  settingsClientIdKey: "gmailOAuthClientId" | "microsoftOAuthClientId";
  resolveClientId(settingsClientId: string): string;
  authUrl(options: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    loginHint?: string;
  }): string;
  tokenUrl: string;
  tokenScope?: string;
  exchangePolicy: TokenResponsePolicy;
  refreshPolicy: TokenResponsePolicy;
  fetchProfile(http: HttpClient, token: string): Promise<OAuthProfile>;
  initialSyncState(profile: OAuthProfile): EmailTriageAccount["syncState"];
  initialAccountState: EmailTriageAccount["state"];
  preserveExistingAccount: boolean;
  rotateRefreshToken: boolean;
  mapCallbackError(error: string, description?: string): string;
  mapConnectError?: (error: unknown, phase: "exchange" | "profile") => string;
  isReconnectError(error: unknown): boolean;
}

export const gmailOAuthProvider: OAuthProviderDescriptor = {
  provider: "gmail",
  settingsClientIdKey: "gmailOAuthClientId",
  resolveClientId: resolveGmailOAuthClientId,
  authUrl: buildGmailAuthorizationUrl,
  tokenUrl: GMAIL_TOKEN_URL,
  exchangePolicy: gmailExchangePolicy,
  refreshPolicy: gmailRefreshPolicy,
  fetchProfile: async (http, token) => {
    const profile = await new GmailApiClient(http, async () => token).getProfile();
    return {
      providerAccountId: profile.emailAddress.trim().toLowerCase(),
      displayAddress: profile.emailAddress,
      historyId: profile.historyId,
    };
  },
  initialSyncState: (profile) => ({
    baselineHistoryId: profile.historyId,
    cursorHistoryId: profile.historyId,
    trackedMessageIds: [],
  }),
  initialAccountState: "active",
  preserveExistingAccount: false,
  rotateRefreshToken: false,
  mapCallbackError: (error) => error,
  isReconnectError: (error) =>
    isInvalidGrantError(error) ||
    (error instanceof Error && error.message.includes("invalid_grant")),
};

export const microsoftOAuthProvider: OAuthProviderDescriptor = {
  provider: "microsoft_graph",
  settingsClientIdKey: "microsoftOAuthClientId",
  resolveClientId: resolveMicrosoftOAuthClientId,
  authUrl: buildMicrosoftAuthorizationUrl,
  tokenUrl: MICROSOFT_OAUTH_TOKEN_URL,
  tokenScope: MICROSOFT_OAUTH_SCOPE,
  exchangePolicy: microsoftTokenPolicy,
  refreshPolicy: microsoftTokenPolicy,
  fetchProfile: async (http, token) => {
    const profile = await new GraphApiClient(http, async () => token).getMe();
    return {
      providerAccountId: profile.id,
      displayAddress:
        profile.userPrincipalName ?? profile.mail ?? profile.displayName ?? profile.id,
    };
  },
  initialSyncState: () => ({
    baselineAt: null,
    deltaLink: null,
    nextLink: null,
    snapshotComplete: false,
    trackedMessageIds: [],
  }),
  initialAccountState: "baselining",
  preserveExistingAccount: true,
  rotateRefreshToken: true,
  mapCallbackError: classifyMicrosoftAuthorizationCallbackError,
  mapConnectError: (error, phase) =>
    phase === "exchange" && error instanceof Error && error.message === "admin_consent_required"
      ? "admin_consent_required"
      : "connect_failed",
  isReconnectError: (error) =>
    error instanceof Error &&
    (error.message === "reconnect_required" || error.message.includes("invalid_grant")),
};
