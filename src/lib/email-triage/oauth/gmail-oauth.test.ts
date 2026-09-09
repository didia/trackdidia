import { describe, expect, it } from "vitest";
import {
  buildGmailAuthorizationUrl,
  GMAIL_OAUTH_SCOPE,
  maskEmailAddress,
  parseProviderCredentials,
  serializeProviderCredentials,
} from "./gmail-oauth";

describe("gmail oauth helpers", () => {
  it("builds an installed-app authorization URL with PKCE and offline consent", () => {
    const url = new URL(
      buildGmailAuthorizationUrl({
        clientId: "client-id.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:8765/oauth/callback",
        state: "state-123",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");
    expect(url.searchParams.get("scope")).toBe(GMAIL_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("round-trips provider credentials without secrets in helper output", () => {
    const raw = serializeProviderCredentials({
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      scope: GMAIL_OAUTH_SCOPE,
    });
    expect(raw).toContain("refresh-token");
    expect(parseProviderCredentials(raw)?.refreshToken).toBe("refresh-token");
  });

  it("masks email addresses safely", () => {
    expect(maskEmailAddress("alice@example.com")).toBe("a***@example.com");
    expect(maskEmailAddress("a@example.com")).toBe("a***@example.com");
  });
});
