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

describe("connectCalendarSyncAccount", () => {
  beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockReset();
    openUrlMock.mockReset().mockResolvedValue(undefined);
    loadCalendarVaultSecretMock.mockReset();
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
});
