import { describe, expect, it } from "vitest";
import {
  buildMicrosoftAuthorizationUrl,
  MICROSOFT_OAUTH_SCOPE,
  resolveMicrosoftOAuthClientId,
} from "./microsoft-oauth";

describe("microsoft oauth helpers", () => {
  it("builds an authorization URL with PKCE, loopback redirect, scopes, and response_mode=query", () => {
    const url = new URL(
      buildMicrosoftAuthorizationUrl({
        clientId: "00000000-0000-0000-0000-000000000000",
        redirectUri: "http://127.0.0.1:8765/oauth/callback",
        state: "state-123",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("00000000-0000-0000-0000-000000000000");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toBe(MICROSOFT_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("scope")).toContain("Mail.ReadWrite");
    expect(url.searchParams.get("scope")).toContain("MailboxSettings.ReadWrite");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("resolves client id from settings then env fallback", () => {
    expect(resolveMicrosoftOAuthClientId(" settings-id ", "env-id")).toBe("settings-id");
    expect(resolveMicrosoftOAuthClientId("", "env-id")).toBe("env-id");
    expect(resolveMicrosoftOAuthClientId("  ", "")).toBe("");
  });
});
