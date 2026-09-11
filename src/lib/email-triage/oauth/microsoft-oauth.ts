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

export interface MicrosoftOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export {
  maskEmailAddress,
  parseProviderCredentials,
  serializeProviderCredentials,
} from "./gmail-oauth";

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

const parseTokenResponse = (response: { status: number; body: string }): MicrosoftOAuthTokens => {
  if (response.status < 200 || response.status >= 300) {
    if (isAdminConsentRequiredError(response.body)) {
      throw new Error("admin_consent_required");
    }
    if (isMicrosoftReconnectRequiredError(response.body, response.status)) {
      throw new Error("reconnect_required");
    }
    throw new Error("microsoft_token_exchange_failed");
  }
  const payload = JSON.parse(response.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!payload.access_token) {
    const description = payload.error_description ?? payload.error ?? "";
    if (isAdminConsentRequiredError(description)) {
      throw new Error("admin_consent_required");
    }
    throw new Error(payload.error ?? "microsoft_token_exchange_failed");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
    tokenType: payload.token_type ?? "Bearer",
    scope: payload.scope ?? MICROSOFT_OAUTH_SCOPE,
  };
};

export const exchangeMicrosoftAuthorizationCode = async (
  http: {
    request(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; body: string }>;
  },
  options: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<MicrosoftOAuthTokens> => {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
    code_verifier: options.codeVerifier,
    scope: MICROSOFT_OAUTH_SCOPE,
  }).toString();
  const response = await http.request({
    method: "POST",
    url: MICROSOFT_OAUTH_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return parseTokenResponse(response);
};

export const refreshMicrosoftAccessToken = async (
  http: {
    request(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; body: string }>;
  },
  options: { clientId: string; refreshToken: string },
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
}> => {
  const body = new URLSearchParams({
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
    scope: MICROSOFT_OAUTH_SCOPE,
  }).toString();
  const response = await http.request({
    method: "POST",
    url: MICROSOFT_OAUTH_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokens = parseTokenResponse(response);
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
