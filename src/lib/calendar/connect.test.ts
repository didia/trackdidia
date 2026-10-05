import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCalendarSyncSettings, type CalendarSyncSettings } from "../../domain/calendar-sync";
import type { AppRepository } from "../storage/repository";
import { __oauthLoopbackGuardForTests, acquireOAuthLoopbackLease } from "../oauth-loopback-guard";

const isTauriRuntimeMock = vi.fn(() => true);
const invokeMock = vi.fn();
const openUrlMock = vi.fn();
const loadCalendarVaultSecretMock = vi.fn();
const storeCalendarVaultSecretMock = vi.fn();
const deleteCalendarVaultSecretMock = vi.fn();
const httpRequestMock = vi.fn();

vi.mock("../storage/factory", () => ({
  isTauriRuntime: () => isTauriRuntimeMock(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));
vi.mock("./vault", () => ({
  loadCalendarVaultSecret: (...args: unknown[]) => loadCalendarVaultSecretMock(...args),
  storeCalendarVaultSecret: (...args: unknown[]) => storeCalendarVaultSecretMock(...args),
  deleteCalendarVaultSecret: (...args: unknown[]) => deleteCalendarVaultSecretMock(...args),
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

import { saveCalendarSyncPreferences } from "./mutations";
import { getCachedAccessToken, setCachedAccessToken } from "../email-triage/token-cache";
import { CALENDAR_SYNC_TOKEN_CACHE_KEY, clearCalendarSyncAccessTokenCache } from "./session";
import { connectCalendarSyncAccount, disconnectCalendarSyncAccount } from "./connect";

class FakeCalendarRepository {
  settings: CalendarSyncSettings = defaultCalendarSyncSettings("2026-01-01T00:00:00.000Z");

  async getCalendarSyncSettings(): Promise<CalendarSyncSettings> {
    return { ...this.settings };
  }

  async saveCalendarSyncSettings(settings: CalendarSyncSettings): Promise<CalendarSyncSettings> {
    this.settings = { ...settings };
    return { ...this.settings };
  }
}

const asRepository = (repo: FakeCalendarRepository) => repo as unknown as AppRepository;

const prepareOAuth = () => {
  let state = "";
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "oauth_loopback_start") {
      state = String(args?.expectedState);
      return { port: 5555, redirectUri: "http://127.0.0.1:5555/oauth/callback" };
    }
    return { code: "code", state };
  });
  httpRequestMock.mockImplementation(async ({ method, url }: { method: string; url: string }) => {
    if (url.includes("/token"))
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      };
    if (url.includes("userinfo"))
      return { status: 200, body: JSON.stringify({ email: "person@example.com" }) };
    if (method === "POST") return { status: 200, body: JSON.stringify({ id: "new-calendar" }) };
    if (method === "DELETE") return { status: 204, body: "" };
    throw new Error("Unexpected request");
  });
};

describe("connectCalendarSyncAccount", () => {
  beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockReset();
    openUrlMock.mockReset().mockResolvedValue(undefined);
    loadCalendarVaultSecretMock.mockReset().mockResolvedValue(null);
    clearCalendarSyncAccessTokenCache();
    storeCalendarVaultSecretMock.mockReset().mockResolvedValue(undefined);
    deleteCalendarVaultSecretMock.mockReset().mockResolvedValue(undefined);
    httpRequestMock.mockReset();
    __oauthLoopbackGuardForTests.reset();
  });

  it("fails fast in browser preview", async () => {
    isTauriRuntimeMock.mockReturnValue(false);
    const result = await connectCalendarSyncAccount(asRepository(new FakeCalendarRepository()));
    expect(result).toEqual({ ok: false, error: "browser_preview" });
  });

  it("fails without an OAuth client id", async () => {
    const result = await connectCalendarSyncAccount(asRepository(new FakeCalendarRepository()));
    expect(result).toEqual({ ok: false, error: "missing_client_id" });
  });

  it("refuses to start when the shared OAuth loopback is already busy", async () => {
    const lease = acquireOAuthLoopbackLease("email_triage");
    expect(lease.ok).toBe(true);
    try {
      const repo = new FakeCalendarRepository();
      const result = await connectCalendarSyncAccount(asRepository(repo), {
        clientId: "client-id",
      });
      expect(result).toEqual({ ok: false, error: "oauth_loopback_busy" });
    } finally {
      if (lease.ok) {
        lease.lease.release();
      }
    }
  });

  it("connects end to end: ensures the calendar, stores credentials, activates settings", async () => {
    let capturedState = "";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "oauth_loopback_start") {
        capturedState = String(args?.expectedState ?? "");
        return { port: 5555, redirectUri: "http://127.0.0.1:5555/oauth/callback" };
      }
      if (command === "oauth_loopback_wait") {
        return { code: "auth-code", state: capturedState };
      }
      throw new Error(`unexpected invoke ${command}`);
    });
    httpRequestMock.mockImplementation(async ({ method, url }: { method: string; url: string }) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/calendar.app.created email",
          }),
        };
      }
      if (url.includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "Person@Example.com" }) };
      }
      if (method === "POST" && url.endsWith("/calendars")) {
        return { status: 200, body: JSON.stringify({ id: "calendar-id-1" }) };
      }
      throw new Error(`unexpected http request ${method} ${url}`);
    });

    const repo = new FakeCalendarRepository();
    const result = await connectCalendarSyncAccount(asRepository(repo), { clientId: "client-id" });

    expect(result).toEqual({ ok: true });
    expect(storeCalendarVaultSecretMock).toHaveBeenCalledWith(
      "calendar_credentials",
      expect.stringContaining("refresh-token"),
    );
    expect(repo.settings.enabled).toBe(true);
    expect(repo.settings.state).toBe("active");
    expect(repo.settings.connectedAccountId).toBe("person@example.com");
    expect(repo.settings.calendarId).toBe("calendar-id-1");
  });

  it("does not create a second calendar when the same account reconnects", async () => {
    let capturedState = "";
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "oauth_loopback_start") {
        capturedState = String(args?.expectedState ?? "");
        return { port: 5555, redirectUri: "http://127.0.0.1:5555/oauth/callback" };
      }
      if (command === "oauth_loopback_wait") {
        return { code: "auth-code", state: capturedState };
      }
      throw new Error(`unexpected invoke ${command}`);
    });
    httpRequestMock.mockImplementation(async ({ method, url }: { method: string; url: string }) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/calendar.app.created email",
          }),
        };
      }
      if (url.includes("userinfo")) {
        return { status: 200, body: JSON.stringify({ email: "person@example.com" }) };
      }
      throw new Error(`unexpected calendar creation on reconnect: ${method} ${url}`);
    });

    const repo = new FakeCalendarRepository();
    repo.settings = {
      ...repo.settings,
      oauthClientId: "client-id",
      connectedAccountId: "person@example.com",
      calendarId: "existing-calendar-id",
      state: "reconnect_required",
      generation: 3,
    };
    const result = await connectCalendarSyncAccount(asRepository(repo));

    expect(result).toEqual({ ok: true });
    expect(repo.settings.calendarId).toBe("existing-calendar-id");
    expect(repo.settings.generation).toBe(3);
  });
  it("restores previous credentials and removes only the newly created calendar on save failure", async () => {
    prepareOAuth();
    loadCalendarVaultSecretMock.mockResolvedValue("previous-secret");
    const repo = new FakeCalendarRepository();
    vi.spyOn(repo, "saveCalendarSyncSettings").mockRejectedValue(new Error("write failed"));
    await expect(
      connectCalendarSyncAccount(asRepository(repo), { clientId: "client" }),
    ).rejects.toThrow("write failed");
    expect(storeCalendarVaultSecretMock).toHaveBeenLastCalledWith(
      "calendar_credentials",
      "previous-secret",
    );
    expect(deleteCalendarVaultSecretMock).not.toHaveBeenCalled();
    expect(httpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/calendars/new-calendar"),
      }),
    );
    expect(repo.settings.calendarId).toBeNull();
    expect(getCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY)).toBeNull();
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
  });

  it("cleans up a first connection when the vault write fails", async () => {
    prepareOAuth();
    storeCalendarVaultSecretMock.mockRejectedValue(new Error("vault failed"));
    setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, "old-access", 3600);
    const repo = new FakeCalendarRepository();
    await expect(
      connectCalendarSyncAccount(asRepository(repo), { clientId: "client" }),
    ).rejects.toThrow("vault failed");
    expect(deleteCalendarVaultSecretMock).toHaveBeenCalledWith("calendar_credentials");
    expect(httpRequestMock).toHaveBeenCalledWith(expect.objectContaining({ method: "DELETE" }));
    expect(repo.settings.state).toBe("disconnected");
    expect(getCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY)).toBeNull();
  });

  it("still deletes the new calendar when restoring previous credentials fails", async () => {
    prepareOAuth();
    loadCalendarVaultSecretMock.mockResolvedValue("old-secret");
    storeCalendarVaultSecretMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("restore failed"));
    const repo = new FakeCalendarRepository();
    vi.spyOn(repo, "saveCalendarSyncSettings").mockRejectedValue(new Error("write failed"));
    await expect(
      connectCalendarSyncAccount(asRepository(repo), { clientId: "client" }),
    ).rejects.toThrow("connect_failed");
    expect(httpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: expect.stringContaining("/calendars/new-calendar"),
      }),
    );
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
  });
  it("never deletes the existing calendar on failed same-account reconnect", async () => {
    prepareOAuth();
    loadCalendarVaultSecretMock.mockResolvedValue("old-secret");
    const repo = new FakeCalendarRepository();
    repo.settings = {
      ...repo.settings,
      oauthClientId: "client",
      connectedAccountId: "person@example.com",
      calendarId: "existing",
      state: "active",
    };
    vi.spyOn(repo, "saveCalendarSyncSettings").mockRejectedValue(new Error("write failed"));
    await expect(connectCalendarSyncAccount(asRepository(repo))).rejects.toThrow("write failed");
    expect(storeCalendarVaultSecretMock).toHaveBeenLastCalledWith(
      "calendar_credentials",
      "old-secret",
    );
    expect(httpRequestMock.mock.calls.some(([request]) => request.method === "DELETE")).toBe(false);
    expect(repo.settings.state).toBe("active");
  });

  it("aborts before creating a calendar when the previous vault secret cannot be read", async () => {
    prepareOAuth();
    loadCalendarVaultSecretMock.mockRejectedValue(new Error("vault unavailable"));
    await expect(
      connectCalendarSyncAccount(asRepository(new FakeCalendarRepository()), {
        clientId: "client",
      }),
    ).rejects.toThrow("vault unavailable");
    expect(storeCalendarVaultSecretMock).not.toHaveBeenCalled();
    expect(httpRequestMock.mock.calls.some(([request]) => request.url.endsWith("/calendars"))).toBe(
      false,
    );
  });

  it("keeps the lease through commit and serializes saves and disconnects across mounts", async () => {
    prepareOAuth();
    const repo = new FakeCalendarRepository();
    let finishVault!: () => void;
    storeCalendarVaultSecretMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishVault = resolve;
        }),
    );
    const first = connectCalendarSyncAccount(asRepository(repo), { clientId: "client" });
    await vi.waitFor(() => expect(storeCalendarVaultSecretMock).toHaveBeenCalled());
    const second = await connectCalendarSyncAccount(asRepository(repo), { clientId: "client" });
    expect(second).toEqual({ ok: false, error: "oauth_loopback_busy" });
    const save = saveCalendarSyncPreferences(asRepository(repo), {
      enabled: false,
      oauthClientId: "client",
    });
    const disconnect = disconnectCalendarSyncAccount(asRepository(repo));
    expect(deleteCalendarVaultSecretMock).not.toHaveBeenCalled();
    finishVault();
    expect(await first).toEqual({ ok: true });
    expect(await save).toMatchObject({
      enabled: false,
      calendarId: "new-calendar",
      connectedAccountId: "person@example.com",
    });
    await disconnect;
    expect(repo.settings.state).toBe("disconnected");
    expect(repo.settings.calendarId).toBe("new-calendar");
    expect(deleteCalendarVaultSecretMock).toHaveBeenCalledOnce();
    expect(
      httpRequestMock.mock.calls.filter(
        ([request]) => request.method === "POST" && request.url.endsWith("/calendars"),
      ),
    ).toHaveLength(1);
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
  });

  it.each([
    "access_denied",
    "unexpected_provider_code",
  ])("maps callback error %s without leaking provider codes", async (error) => {
    prepareOAuth();
    invokeMock
      .mockResolvedValueOnce({ port: 5555, redirectUri: "http://127.0.0.1:5555/oauth/callback" })
      .mockResolvedValueOnce({ error });
    expect(
      await connectCalendarSyncAccount(asRepository(new FakeCalendarRepository()), {
        clientId: "client",
      }),
    ).toEqual({ ok: false, error: error === "access_denied" ? "access_denied" : "connect_failed" });
    expect(storeCalendarVaultSecretMock).not.toHaveBeenCalled();
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
  });
});

describe("disconnectCalendarSyncAccount", () => {
  beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(true);
    deleteCalendarVaultSecretMock.mockReset().mockResolvedValue(undefined);
  });

  it("disables sync, clears the vault secret, and keeps identity so reconnect resumes", async () => {
    const repo = new FakeCalendarRepository();
    repo.settings = {
      ...repo.settings,
      enabled: true,
      state: "active",
      connectedAccountId: "person@example.com",
      calendarId: "calendar-id-1",
      generation: 1,
    };
    await disconnectCalendarSyncAccount(asRepository(repo));
    expect(deleteCalendarVaultSecretMock).toHaveBeenCalledWith("calendar_credentials");
    expect(repo.settings.enabled).toBe(false);
    expect(repo.settings.state).toBe("disconnected");
    expect(repo.settings.connectedAccountId).toBe("person@example.com");
    expect(repo.settings.calendarId).toBe("calendar-id-1");
    expect(repo.settings.generation).toBe(1);
  });
  it("keeps credentials and active settings when the disconnect save fails", async () => {
    const repo = new FakeCalendarRepository();
    repo.settings = { ...repo.settings, enabled: true, state: "active" };
    vi.spyOn(repo, "saveCalendarSyncSettings").mockRejectedValue(new Error("write failed"));
    setCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY, "old-access", 3600);
    await expect(disconnectCalendarSyncAccount(asRepository(repo))).rejects.toThrow("write failed");
    expect(deleteCalendarVaultSecretMock).not.toHaveBeenCalled();
    expect(repo.settings.state).toBe("active");
    expect(getCachedAccessToken(CALENDAR_SYNC_TOKEN_CACHE_KEY)).toBe("old-access");
    clearCalendarSyncAccessTokenCache();
  });

  it("stays safely disconnected when vault deletion fails", async () => {
    const repo = new FakeCalendarRepository();
    repo.settings = { ...repo.settings, enabled: true, state: "active" };
    deleteCalendarVaultSecretMock.mockRejectedValue(new Error("vault failed"));
    await expect(disconnectCalendarSyncAccount(asRepository(repo))).rejects.toThrow("vault failed");
    expect(repo.settings.state).toBe("disconnected");
    expect(repo.settings.enabled).toBe(false);
  });
});
