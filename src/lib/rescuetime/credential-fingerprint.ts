/**
 * Non-reversible fingerprint of a RescueTime API key, used to scope the snapshot cache to the
 * account that produced it. The key itself is never stored, logged or used as a cache key.
 */
export const rescueTimeCredentialFingerprint = async (apiKey: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey.trim()));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
};

/**
 * True when the key currently saved in settings is still the one whose fingerprint was captured
 * at the start of a pull. Failure fallbacks read the cache only when this holds, so removing or
 * switching the key never surfaces the old account's cached numbers.
 */
export const currentKeyMatchesFingerprint = async (
  repository: { getSettings(): Promise<{ rescuetimeApiKey: string }> },
  capturedFingerprint: string,
): Promise<boolean> => {
  try {
    const current = (await repository.getSettings()).rescuetimeApiKey.trim();
    return (
      current.length > 0 && (await rescueTimeCredentialFingerprint(current)) === capturedFingerprint
    );
  } catch {
    return false;
  }
};
