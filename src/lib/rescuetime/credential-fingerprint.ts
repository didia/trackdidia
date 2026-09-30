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
