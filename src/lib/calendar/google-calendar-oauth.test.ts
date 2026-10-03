import { describe, expect, it } from "vitest";
import { ProviderHttpError, isInvalidGrantError } from "../email-triage/provider-http";
import {
  buildCalendarSyncAuthorizationUrl,
  CALENDAR_SYNC_OAUTH_REQUESTED_SCOPES,
  CALENDAR_SYNC_OAUTH_SCOPE,
  maskCalendarSyncAccountEmail,
  parseCalendarSyncCredentials,
  refreshCalendarSyncAccessToken,
  resolveCalendarSyncOAuthClientId,
  serializeCalendarSyncCredentials,
} from "./google-calendar-oauth";

describe("calendar sync oauth helpers", () => {
  it("builds an installed-app authorization URL scoped to calendar.app.created", () => {
    const url = new URL(
      buildCalendarSyncAuthorizationUrl({
        clientId: "client-id.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:8765/oauth/callback",
        state: "state-123",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");
    expect(url.searchParams.get("scope")).toBe(CALENDAR_SYNC_OAUTH_REQUESTED_SCOPES);
    expect(url.searchParams.get("scope")).toContain(CALENDAR_SYNC_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("round-trips provider credentials", () => {
    const raw = serializeCalendarSyncCredentials({
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      scope: CALENDAR_SYNC_OAUTH_SCOPE,
    });
    expect(raw).toContain("refresh-token");
    expect(parseCalendarSyncCredentials(raw)?.refreshToken).toBe("refresh-token");
  });

  it("masks email addresses safely", () => {
    expect(maskCalendarSyncAccountEmail("alice@example.com")).toBe("a***@example.com");
  });

  it("preserves invalid_grant from a non-2xx refresh response", async () => {
    const http = {
      request: async () => ({
        status: 400,
        body: JSON.stringify({ error: "invalid_grant", error_description: "Token revoked" }),
      }),
    };
    const caught = await refreshCalendarSyncAccessToken(http, {
      clientId: "client-id",
      refreshToken: "refresh-token",
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect(isInvalidGrantError(caught)).toBe(true);
    expect((caught as ProviderHttpError).message).toBe("invalid_grant");
  });

  it("falls back to settings, then env, client id", () => {
    expect(resolveCalendarSyncOAuthClientId("  settings-id  ", "env-id")).toBe("settings-id");
    expect(resolveCalendarSyncOAuthClientId("", "env-id")).toBe("env-id");
    expect(resolveCalendarSyncOAuthClientId("", undefined)).toBe("");
  });
});
