export const GMAIL_OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface GmailOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface GmailProviderCredentials {
  refreshToken: string;
  tokenType: string;
  scope: string;
}

export const serializeProviderCredentials = (credentials: GmailProviderCredentials): string =>
  JSON.stringify(credentials);

export const parseProviderCredentials = (raw: string | null): GmailProviderCredentials | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GmailProviderCredentials>;
    if (!parsed.refreshToken || typeof parsed.refreshToken !== "string") {
      return null;
    }
    return {
      refreshToken: parsed.refreshToken,
      tokenType: parsed.tokenType ?? "Bearer",
      scope: parsed.scope ?? GMAIL_OAUTH_SCOPE,
    };
  } catch {
    return null;
  }
};

export const buildGmailAuthorizationUrl = (options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
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
    prompt: "consent",
  });
  return `${GMAIL_AUTH_URL}?${params.toString()}`;
};

export const exchangeGmailAuthorizationCode = async (
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
): Promise<GmailOAuthTokens> => {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
    code_verifier: options.codeVerifier,
  }).toString();
  const response = await http.request({
    method: "POST",
    url: GMAIL_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("gmail_token_exchange_failed");
  }
  const payload = JSON.parse(response.body) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
  };
  if (!payload.access_token) {
    throw new Error(payload.error ?? "gmail_token_exchange_failed");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
    tokenType: payload.token_type ?? "Bearer",
    scope: payload.scope ?? GMAIL_OAUTH_SCOPE,
  };
};

export const refreshGmailAccessToken = async (
  http: {
    request(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; body: string }>;
  },
  options: { clientId: string; refreshToken: string },
): Promise<{ accessToken: string; expiresIn: number; tokenType: string }> => {
  const body = new URLSearchParams({
    client_id: options.clientId,
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const response = await http.request({
    method: "POST",
    url: GMAIL_TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("gmail_token_refresh_failed");
  }
  const payload = JSON.parse(response.body) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
  };
  if (!payload.access_token) {
    throw new Error(payload.error ?? "gmail_token_refresh_failed");
  }
  return {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in ?? 3600,
    tokenType: payload.token_type ?? "Bearer",
  };
};

export const resolveGmailOAuthClientId = (
  settingsClientId: string,
  envClientId: string | undefined = import.meta.env.VITE_GMAIL_OAUTH_CLIENT_ID,
): string => settingsClientId.trim() || (envClientId?.trim() ?? "");

export const maskEmailAddress = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) {
    return "***";
  }
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const visible = local.length <= 1 ? local : local[0];
  return `${visible}***@${domain}`;
};
