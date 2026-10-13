interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
}

const cache = new Map<string, CachedAccessToken>();

export const getCachedAccessToken = (accountId: string): string | null => {
  const entry = cache.get(accountId);
  if (!entry) {
    return null;
  }
  if (Date.now() >= entry.expiresAt - 30_000) {
    cache.delete(accountId);
    return null;
  }
  return entry.accessToken;
};

export const setCachedAccessToken = (
  accountId: string,
  accessToken: string,
  expiresInSeconds: number,
): void => {
  cache.set(accountId, {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1_000,
  });
};

export const clearCachedAccessToken = (accountId: string): void => {
  cache.delete(accountId);
};

export const clearAllCachedAccessTokens = (): void => {
  cache.clear();
};

/** Test-only visibility into the in-memory cache. */
export const __tokenCacheForTests = {
  size: () => cache.size,
  has: (accountId: string) => cache.has(accountId),
};
