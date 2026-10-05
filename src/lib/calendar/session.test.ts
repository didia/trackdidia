import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAccessToken, setCachedAccessToken } from "../email-triage/token-cache";
import { CALENDAR_SYNC_TOKEN_CACHE_KEY, createCalendarSyncApiClient } from "./session";

const loadCalendarVaultSecretMock = vi.fn();
const httpRequestMock = vi.fn();

vi.mock("./vault", () => ({
  loadCalendarVaultSecret: (...args: unknown[]) => loadCalendarVaultSecretMock(...args),
}));
vi.mock("../email-triage/provider-http", async () => {
  const actual = await vi.importActual<typeof import("../email-triage/provider-http")>(
    "../email-triage/provider-http",
  );
  return {
    ...actual,
    createTauriHttpClient: () => ({ request: httpRequestMock }),
  };
});

describe("createCalendarSyncAccessTokenGetter", () => {
  beforeEach(() => {
    loadCalendarVaultSecretMock.mockReset();
    httpRequestMock.mockReset();
    clearCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY);
  });

  afterEach(() => {
    clearCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY);
  });

  it("throws reconnect_required when no credentials are stored", async () => {
    loadCalendarVaultSecretMock.mockResolvedValue(null);
    const { createCalendarSyncAccessTokenGetter } = await import("./session");
    const getAccessToken = createCalendarSyncAccessTokenGetter("client-id");
    await expect(getAccessToken()).rejects.toThrow("reconnect_required");
  });

  it("refreshes and caches an access token from the stored refresh token", async () => {
    loadCalendarVaultSecretMock.mockResolvedValue(
      JSON.stringify({ refreshToken: "refresh-1", tokenType: "Bearer", scope: "calendar" }),
    );
    httpRequestMock.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ access_token: "access-1", expires_in: 3600, token_type: "Bearer" }),
    });
    const { createCalendarSyncAccessTokenGetter } = await import("./session");
    const getAccessToken = createCalendarSyncAccessTokenGetter("client-id");
    const token = await getAccessToken();
    expect(token).toBe("access-1");
    expect(httpRequestMock).toHaveBeenCalledTimes(1);

    const cachedToken = await getAccessToken();
    expect(cachedToken).toBe("access-1");
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("maps an invalid_grant refresh failure to reconnect_required", async () => {
    loadCalendarVaultSecretMock.mockResolvedValue(
      JSON.stringify({ refreshToken: "revoked", tokenType: "Bearer", scope: "calendar" }),
    );
    httpRequestMock.mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    const { createCalendarSyncAccessTokenGetter } = await import("./session");
    const getAccessToken = createCalendarSyncAccessTokenGetter("client-id");
    await expect(getAccessToken()).rejects.toThrow("reconnect_required");
  });
  it("refreshes once after Google's normal 401 and retries the same lookup with the new token", async () => {
    setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, "rejected-access", 3600);
    loadCalendarVaultSecretMock.mockResolvedValue(
      JSON.stringify({ refreshToken: "valid-refresh" }),
    );
    httpRequestMock
      .mockResolvedValueOnce({
        status: 401,
        body: JSON.stringify({
          error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ access_token: "refreshed-access", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ items: [{ id: "existing-event" }] }),
      });
    const client = createCalendarSyncApiClient({ oauthClientId: "client" })!;
    expect(await client.lookupEventsByOccurrence("calendar", "task", "2026-10-04")).toEqual({
      ok: true,
      hits: [{ id: "existing-event" }],
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(3);
    const [initial, refresh, retry] = httpRequestMock.mock.calls.map(([request]) => request);
    expect(initial.headers.Authorization).toBe("Bearer rejected-access");
    expect(refresh.url).toContain("/token");
    expect(retry.url).toBe(initial.url);
    expect(retry.headers.Authorization).toBe("Bearer refreshed-access");
  });

  it("reports reconnect_required when the 401 retry's refresh grant is revoked", async () => {
    setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, "rejected-access", 3600);
    loadCalendarVaultSecretMock.mockResolvedValue(JSON.stringify({ refreshToken: "revoked" }));
    httpRequestMock
      .mockResolvedValueOnce({ status: 401, body: "Invalid Credentials" })
      .mockResolvedValueOnce({ status: 400, body: JSON.stringify({ error: "invalid_grant" }) });
    const client = createCalendarSyncApiClient({ oauthClientId: "client" })!;
    expect(await client.lookupEventsByOccurrence("calendar", "task", "2026-10-04")).toEqual({
      ok: false,
      reason: "reconnect_required",
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(2);
  });

  it("stops after one refresh when the replacement access token is also rejected", async () => {
    setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, "rejected-access", 3600);
    loadCalendarVaultSecretMock.mockResolvedValue(
      JSON.stringify({ refreshToken: "valid-refresh" }),
    );
    httpRequestMock
      .mockResolvedValueOnce({ status: 401, body: "Invalid Credentials" })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ access_token: "refreshed-access", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ status: 401, body: "Invalid Credentials" });
    const client = createCalendarSyncApiClient({ oauthClientId: "client" })!;
    expect(await client.lookupEventsByOccurrence("calendar", "task", "2026-10-04")).toEqual({
      ok: false,
      reason: "request_failed",
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(3);
  });

  it("keeps refresh server errors retryable", async () => {
    loadCalendarVaultSecretMock.mockResolvedValue(
      JSON.stringify({ refreshToken: "valid-refresh" }),
    );
    httpRequestMock.mockResolvedValue({ status: 503, body: "unavailable" });
    const client = createCalendarSyncApiClient({ oauthClientId: "client" })!;
    expect(await client.lookupEventsByOccurrence("calendar", "task", "2026-10-04")).toEqual({
      ok: false,
      reason: "request_failed",
    });
  });
});
