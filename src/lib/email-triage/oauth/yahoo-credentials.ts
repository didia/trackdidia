export interface YahooProviderCredentials {
  email: string;
  appPassword: string;
  kind: "yahoo_app_password";
}

const appPasswordCache = new Map<string, string>();

export const serializeYahooCredentials = (credentials: YahooProviderCredentials): string =>
  JSON.stringify(credentials);

export const parseYahooCredentials = (raw: string | null): YahooProviderCredentials | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<YahooProviderCredentials>;
    if (
      parsed.kind !== "yahoo_app_password" ||
      !parsed.email ||
      !parsed.appPassword ||
      typeof parsed.email !== "string" ||
      typeof parsed.appPassword !== "string"
    ) {
      return null;
    }
    return {
      email: parsed.email.trim().toLowerCase(),
      appPassword: parsed.appPassword,
      kind: "yahoo_app_password",
    };
  } catch {
    return null;
  }
};

export const setCachedYahooAppPassword = (accountId: string, appPassword: string): void => {
  appPasswordCache.set(accountId, appPassword);
};

export const getCachedYahooAppPassword = (accountId: string): string | null =>
  appPasswordCache.get(accountId) ?? null;

export const clearCachedYahooAppPassword = (accountId: string): void => {
  appPasswordCache.delete(accountId);
};

export const clearAllCachedYahooAppPasswords = (): void => {
  appPasswordCache.clear();
};
