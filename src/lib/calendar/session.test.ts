import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAccessToken } from "../email-triage/token-cache";
import { CALENDAR_SYNC_TOKEN_CACHE_KEY } from "./session";

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
});
