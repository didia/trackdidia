import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type HttpClient,
  type OAuthTokens,
  type TokenResponsePolicy,
} from "./shared";
export const MICROSOFT_OAUTH_AUTHORITY = "https://login.microsoftonline.com/common";
export const MICROSOFT_OAUTH_AUTH_URL = `${MICROSOFT_OAUTH_AUTHORITY}/oauth2/v2.0/authorize`;
export const MICROSOFT_OAUTH_TOKEN_URL = `${MICROSOFT_OAUTH_AUTHORITY}/oauth2/v2.0/token`;

export const MICROSOFT_OAUTH_SCOPES = [
  "User.Read",
  "Mail.ReadWrite",
  "MailboxSettings.ReadWrite",
  "offline_access",
  "openid",
  "profile",
  "email",
] as const;

export const MICROSOFT_OAUTH_SCOPE = MICROSOFT_OAUTH_SCOPES.join(" ");

export type { OAuthTokens as MicrosoftOAuthTokens } from "./shared";
export { maskEmailAddress, parseProviderCredentials, serializeProviderCredentials } from "./shared";

export const buildMicrosoftAuthorizationUrl = (options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string => {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MICROSOFT_OAUTH_SCOPE,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${MICROSOFT_OAUTH_AUTH_URL}?${params.toString()}`;
};

export const isAdminConsentRequiredError = (body: string): boolean =>
  body.includes("AADSTS65001") || body.toLowerCase().includes("admin_consent");

export const classifyMicrosoftAuthorizationCallbackError = (
  error: string,
  errorDescription?: string | null,
): string => {
  const combined = `${error} ${errorDescription ?? ""}`;
  if (isAdminConsentRequiredError(combined)) {
    return "admin_consent_required";
  }
  return error;
};

export const isMicrosoftReconnectRequiredError = (body: string, status: number): boolean =>
  status === 401 ||
  body.includes("invalid_grant") ||
  body.includes("interaction_required") ||
  body.includes("invalid_token");

export const microsoftTokenPolicy: TokenResponsePolicy = {
  defaultScope: MICROSOFT_OAUTH_SCOPE,
  httpFailure: (response) => {
    if (isAdminConsentRequiredError(response.body)) throw new Error("admin_consent_required");
    if (isMicrosoftReconnectRequiredError(response.body, response.status))
      throw new Error("reconnect_required");
    throw new Error("microsoft_token_exchange_failed");
  },
  missingAccessToken: (payload) => {
    const description = payload.error_description ?? payload.error ?? "";
    if (isAdminConsentRequiredError(description)) throw new Error("admin_consent_required");
    throw new Error(payload.error ?? "microsoft_token_exchange_failed");
  },
};

export const exchangeMicrosoftAuthorizationCode = (
  http: HttpClient,
  options: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthTokens> =>
  exchangeAuthorizationCode(
    http,
    MICROSOFT_OAUTH_TOKEN_URL,
    options,
    microsoftTokenPolicy,
    MICROSOFT_OAUTH_SCOPE,
  );

export const refreshMicrosoftAccessToken = async (
  http: HttpClient,
  options: { clientId: string; refreshToken: string },
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
}> => {
  const tokens = await refreshAccessToken(
    http,
    MICROSOFT_OAUTH_TOKEN_URL,
    options,
    microsoftTokenPolicy,
    MICROSOFT_OAUTH_SCOPE,
  );
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    tokenType: tokens.tokenType,
  };
};

export const resolveMicrosoftOAuthClientId = (
  settingsClientId: string,
  envClientId: string | undefined = import.meta.env.VITE_MICROSOFT_OAUTH_CLIENT_ID,
): string => settingsClientId.trim() || (envClientId?.trim() ?? "");
