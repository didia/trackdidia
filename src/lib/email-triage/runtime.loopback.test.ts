import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultEmailTriageGlobalSettings,
  type EmailTriageGlobalSettings,
} from "../../domain/email-triage";
import { __oauthLoopbackGuardForTests, acquireOAuthLoopbackLease } from "../oauth-loopback-guard";

const isTauriRuntimeMock = vi.fn(() => true);
const invokeMock = vi.fn();
const openUrlMock = vi.fn();
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
vi.mock("./provider-http", async () => {
  const actual = await vi.importActual<typeof import("./provider-http")>("./provider-http");
  return {
    ...actual,
    createTauriHttpClient: () => ({ request: httpRequestMock }),
  };
});
vi.mock("./vault", () => ({
  loadVaultSecret: vi.fn(async () => null),
  storeVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

import { connectGmailAccount } from "./runtime";

class FakeEmailTriageRepository {
  settings: EmailTriageGlobalSettings = defaultEmailTriageGlobalSettings();

  emailTriage = {
    getGlobalSettings: async (): Promise<EmailTriageGlobalSettings> => ({ ...this.settings }),
    saveGlobalSettings: async (
      settings: EmailTriageGlobalSettings,
    ): Promise<EmailTriageGlobalSettings> => {
      this.settings = { ...settings };
      return { ...this.settings };
    },
    listAccounts: async () => [],
    getAccount: async () => null,
  };
}

describe("connectGmailAccount loopback guard", () => {
  beforeEach(() => {
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockReset();
    openUrlMock.mockReset().mockResolvedValue(undefined);
    httpRequestMock.mockReset();
    __oauthLoopbackGuardForTests.reset();
  });

  it("returns oauth_loopback_busy while calendar sync holds the lease", async () => {
    const lease = acquireOAuthLoopbackLease("calendar_sync");
    expect(lease.ok).toBe(true);
    try {
      const repo = new FakeEmailTriageRepository();
      repo.settings = { ...repo.settings, gmailOAuthClientId: "client-id" };
      const result = await connectGmailAccount(repo as never, {});
      expect(result).toEqual({ ok: false, error: "oauth_loopback_busy" });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      if (lease.ok) {
        lease.lease.release();
      }
    }
  });

  it("releases the lease when the authorization-code exchange fails, freeing it for calendar sync", async () => {
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
    httpRequestMock.mockResolvedValue({ status: 500, body: "boom" });

    const repo = new FakeEmailTriageRepository();
    repo.settings = { ...repo.settings, gmailOAuthClientId: "client-id" };
    await expect(connectGmailAccount(repo as never, {})).rejects.toThrow();

    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
    const calendarLease = acquireOAuthLoopbackLease("calendar_sync");
    expect(calendarLease.ok).toBe(true);
    if (calendarLease.ok) {
      calendarLease.lease.release();
    }
  });
});
