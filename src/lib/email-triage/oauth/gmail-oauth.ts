import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type HttpClient,
  type OAuthTokens,
  type TokenResponsePolicy,
} from "./shared";
import { ProviderHttpError } from "../provider-http";

export const GMAIL_OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const readOAuthErrorCode = (body: string): string | null => {
  try {
    const payload = JSON.parse(body) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
  } catch {
    return null;
  }
};

export type {
  OAuthTokens as GmailOAuthTokens,
  ProviderCredentials as GmailProviderCredentials,
} from "./shared";
export { serializeProviderCredentials, parseProviderCredentials, maskEmailAddress } from "./shared";

export const gmailExchangePolicy: TokenResponsePolicy = {
  defaultScope: GMAIL_OAUTH_SCOPE,
  httpFailure: () => {
    throw new Error("gmail_token_exchange_failed");
  },
  missingAccessToken: (payload) => {
    throw new Error(payload.error ?? "gmail_token_exchange_failed");
  },
};
export const gmailRefreshPolicy: TokenResponsePolicy = {
  defaultScope: GMAIL_OAUTH_SCOPE,
  httpFailure: (response) => {
    throw new ProviderHttpError(
      readOAuthErrorCode(response.body) ?? "gmail_token_refresh_failed",
      response.status,
      response.body,
    );
  },
  missingAccessToken: (payload, response) => {
    throw new ProviderHttpError(
      payload.error ?? "gmail_token_refresh_failed",
      response.status,
      response.body,
    );
  },
};

export const buildGmailAuthorizationUrl = (options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}): string => {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GMAIL_OAUTH_SCOPE,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    // select_account forces the chooser so a second Gmail can be added while the
    // browser is already signed in to another Google account.
    prompt: "select_account consent",
  });
  if (options.loginHint) params.set("login_hint", options.loginHint);
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
};

export const exchangeGmailAuthorizationCode = (
  http: HttpClient,
  options: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthTokens> =>
  exchangeAuthorizationCode(http, GMAIL_TOKEN_URL, options, gmailExchangePolicy);

export const refreshGmailAccessToken = async (
  http: HttpClient,
  options: { clientId: string; refreshToken: string },
): Promise<{ accessToken: string; expiresIn: number; tokenType: string }> => {
  const tokens = await refreshAccessToken(http, GMAIL_TOKEN_URL, options, gmailRefreshPolicy);
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    tokenType: tokens.tokenType,
  };
};

export const resolveGmailOAuthClientId = (
  settingsClientId: string,
  envClientId: string | undefined = import.meta.env.VITE_GMAIL_OAUTH_CLIENT_ID,
): string => settingsClientId.trim() || (envClientId?.trim() ?? "");
