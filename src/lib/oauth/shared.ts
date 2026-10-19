import {
  parseJsonBody,
  ProviderHttpError,
  type ProviderHttpClient,
  type ProviderHttpResponse,
} from "../provider-http";

export type HttpClient = ProviderHttpClient;
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string;
}
export interface ProviderCredentials {
  refreshToken: string;
  tokenType: string;
  scope: string;
}
export interface OAuthTokenPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}
export interface TokenResponsePolicy {
  defaultScope: string;
  httpFailure(response: ProviderHttpResponse): never;
  missingAccessToken(payload: OAuthTokenPayload, response: ProviderHttpResponse): never;
}

export const serializeProviderCredentials = (credentials: ProviderCredentials): string =>
  JSON.stringify(credentials);
export const parseProviderCredentials = (raw: string | null): ProviderCredentials | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderCredentials> | null;
    if (!parsed || !parsed.refreshToken || typeof parsed.refreshToken !== "string") return null;
    return {
      refreshToken: parsed.refreshToken,
      tokenType: parsed.tokenType ?? "Bearer",
      // Compatibility default for credentials saved before a scope was recorded.
      scope: parsed.scope ?? "https://www.googleapis.com/auth/gmail.modify",
    };
  } catch {
    return null;
  }
};
export const maskEmailAddress = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) return "***";
  const local = normalized.slice(0, atIndex);
  return `${local[0]}***@${normalized.slice(atIndex + 1)}`;
};

const requestToken = async (
  http: HttpClient,
  tokenUrl: string,
  params: Record<string, string>,
  policy: TokenResponsePolicy,
): Promise<OAuthTokens> => {
  const response = await http.request({
    method: "POST",
    url: tokenUrl,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (response.status < 200 || response.status >= 300) policy.httpFailure(response);
  const payload = parseJsonBody<OAuthTokenPayload | null>(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderHttpError("invalid_json", response.status, response.body);
  }
  if (!payload.access_token || typeof payload.access_token !== "string")
    policy.missingAccessToken(payload, response);
  return {
    accessToken: payload.access_token!,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
    tokenType: payload.token_type ?? "Bearer",
    scope: payload.scope ?? policy.defaultScope,
  };
};
export const exchangeAuthorizationCode = (
  http: HttpClient,
  tokenUrl: string,
  options: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
  policy: TokenResponsePolicy,
  scope?: string,
): Promise<OAuthTokens> =>
  requestToken(
    http,
    tokenUrl,
    {
      client_id: options.clientId,
      code: options.code,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
      code_verifier: options.codeVerifier,
      ...(scope ? { scope } : {}),
    },
    policy,
  );
export const refreshAccessToken = (
  http: HttpClient,
  tokenUrl: string,
  options: { clientId: string; refreshToken: string },
  policy: TokenResponsePolicy,
  scope?: string,
): Promise<OAuthTokens> =>
  requestToken(
    http,
    tokenUrl,
    {
      client_id: options.clientId,
      refresh_token: options.refreshToken,
      grant_type: "refresh_token",
      ...(scope ? { scope } : {}),
    },
    policy,
  );
