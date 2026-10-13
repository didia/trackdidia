const BASE64_URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const toBase64Url = (bytes: Uint8Array): string => {
  let output = "";
  for (const byte of bytes) {
    output += BASE64_URL_CHARS[byte % BASE64_URL_CHARS.length];
  }
  return output;
};

export const generateOAuthState = (): string => toBase64Url(randomBytes(32));

export const generatePkceVerifier = (): string => toBase64Url(randomBytes(64));

export const createPkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const validateOAuthState = (
  expected: string,
  received: string | null | undefined,
): boolean => Boolean(received) && expected === received;
