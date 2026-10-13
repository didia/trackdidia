import { describe, expect, it } from "vitest";
import { ProviderHttpError, isInvalidGrantError } from "../provider-http";
import {
  GMAIL_OAUTH_SCOPE,
  maskEmailAddress,
  parseProviderCredentials,
  refreshGmailAccessToken,
  serializeProviderCredentials,
} from "./google-oauth";

describe("google oauth helpers", () => {
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

  it("preserves invalid_grant from a non-2xx refresh response", async () => {
    const http = {
      request: async () => ({
        status: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "Token revoked" }),
      }),
    };
    const caught = await refreshGmailAccessToken(http, {
      clientId: "client-id",
      refreshToken: "refresh-token",
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect(isInvalidGrantError(caught)).toBe(true);
    expect((caught as ProviderHttpError).message).toBe("invalid_grant");
  });
});
