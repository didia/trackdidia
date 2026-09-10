import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { createEmailTriageAdapter, persistGmailAccountCredentials } from "./gmail-session";
import { serializeProviderCredentials } from "./oauth/gmail-oauth";
import { clearAllCachedAccessTokens, __tokenCacheForTests } from "./token-cache";
import { deleteVaultSecret, loadVaultSecret, storeVaultSecret } from "./vault";

vi.mock("../storage/factory", () => ({
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("./vault", () => ({
  loadVaultSecret: vi.fn(async () => null),
  storeVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

const tokenHttp = vi.fn();

vi.mock("./provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-http")>();
  return {
    ...actual,
    createTauriHttpClient: () => ({
      request: (...args: unknown[]) => tokenHttp(...args),
    }),
  };
});

const gmailAccount = {
  id: "acct-1",
  provider: "gmail" as const,
  providerAccountId: "me@example.com",
  label: "Gmail",
  maskedAddress: "m***@example.com",
  generation: 1,
  enabled: true,
  mutationEnabled: false,
  paused: false,
  state: "active" as const,
  recoveryState: "none" as const,
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {
    baselineHistoryId: "100",
    cursorHistoryId: "200",
    trackedMessageIds: ["m1"],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("createEmailTriageAdapter", () => {
  beforeEach(() => {
    vi.mocked(loadVaultSecret).mockReset();
    vi.mocked(loadVaultSecret).mockResolvedValue(null);
    tokenHttp.mockReset();
    clearAllCachedAccessTokens();
  });

  it("returns null for gmail without vault credentials in tauri runtime", async () => {
    const adapter = await createEmailTriageAdapter(gmailAccount, {
      ...defaultEmailTriageGlobalSettings(),
      gmailOAuthClientId: "client-id",
    });
    expect(adapter).toBeNull();
  });

  it("maps a revoked refresh token to reconnect_required", async () => {
    vi.mocked(loadVaultSecret).mockResolvedValue(
      serializeProviderCredentials({
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      }),
    );
    tokenHttp.mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    const adapter = await createEmailTriageAdapter(gmailAccount, {
      ...defaultEmailTriageGlobalSettings(),
      gmailOAuthClientId: "client-id",
    });
    expect(adapter).not.toBeNull();
    await expect(
      adapter?.fetchPage({
        baselineHistoryId: "100",
        cursorHistoryId: "200",
      }),
    ).rejects.toThrow("reconnect_required");
  });
});

describe("persistGmailAccountCredentials", () => {
  beforeEach(() => {
    vi.mocked(loadVaultSecret).mockReset();
    vi.mocked(storeVaultSecret).mockReset();
    vi.mocked(deleteVaultSecret).mockReset();
    vi.mocked(storeVaultSecret).mockResolvedValue(undefined);
    vi.mocked(deleteVaultSecret).mockResolvedValue(undefined);
    clearAllCachedAccessTokens();
  });

  it("deletes the vault secret if a new account row fails to save", async () => {
    vi.mocked(loadVaultSecret).mockResolvedValue(null);
    const repository = {
      saveEmailTriageAccount: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    await expect(
      persistGmailAccountCredentials({
        repository,
        account: gmailAccount,
        credentials: "new-creds",
        accessToken: "access",
        expiresIn: 3600,
      }),
    ).rejects.toThrow(/disk full/);
    expect(storeVaultSecret).toHaveBeenCalledWith(
      "provider_credentials",
      "new-creds",
      gmailAccount.id,
    );
    expect(deleteVaultSecret).toHaveBeenCalledWith("provider_credentials", gmailAccount.id);
    expect(__tokenCacheForTests.has(gmailAccount.id)).toBe(false);
  });

  it("restores the previous vault secret if reconnect persistence fails", async () => {
    vi.mocked(loadVaultSecret).mockResolvedValue("old-creds");
    const repository = {
      saveEmailTriageAccount: vi.fn(async () => {
        throw new Error("sqlite failed");
      }),
    };
    await expect(
      persistGmailAccountCredentials({
        repository,
        account: gmailAccount,
        credentials: "new-creds",
        accessToken: "access",
        expiresIn: 3600,
      }),
    ).rejects.toThrow(/sqlite failed/);
    expect(storeVaultSecret).toHaveBeenNthCalledWith(
      1,
      "provider_credentials",
      "new-creds",
      gmailAccount.id,
    );
    expect(storeVaultSecret).toHaveBeenNthCalledWith(
      2,
      "provider_credentials",
      "old-creds",
      gmailAccount.id,
    );
    expect(deleteVaultSecret).not.toHaveBeenCalled();
    expect(__tokenCacheForTests.has(gmailAccount.id)).toBe(false);
  });
});
