import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EmailTriageAccount } from "../../domain/email-triage";
import { MemoryRepository } from "../storage/memory-repository";
import { isTauriRuntime } from "../storage/factory";
import { connectGmailAccount, connectMicrosoftAccount } from "./runtime";
import { gmailOAuthProvider, microsoftOAuthProvider } from "./oauth/providers";
import { createOAuthAccessTokenGetter, setEmailTriageCoordinator } from "./provider-session";
import { clearAllCachedAccessTokens, __tokenCacheForTests } from "./token-cache";
import { loadVaultSecret, storeVaultSecret } from "./vault";

const io = vi.hoisted(() => ({
  state: "",
  callback: {} as Record<string, string>,
  profileFails: false,
  refreshToken: "refresh",
  beforeCallback: null as (() => Promise<void>) | null,
}));
vi.mock("../storage/factory", () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("./vault", () => ({
  loadVaultSecret: vi.fn(async () => null as string | null),
  storeVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "oauth_loopback_start") {
      io.state = args.expectedState as string;
      return { port: 8765, redirectUri: "http://127.0.0.1:8765/oauth/callback" };
    }
    if (command === "oauth_loopback_wait") {
      await io.beforeCallback?.();
      return { code: "code", state: io.state, ...io.callback };
    }
    if (command === "provider_http_request") {
      const request = args.request as { url: string };
      if (request.url.includes("/token"))
        return {
          status: 200,
          body: JSON.stringify({
            access_token: "access",
            refresh_token: io.refreshToken || undefined,
            expires_in: 3600,
          }),
        };
      if (io.profileFails) throw new Error("profile failed");
      return {
        status: 200,
        body: JSON.stringify(
          request.url.includes("gmail.googleapis.com")
            ? { emailAddress: "Me@Example.com", historyId: "100" }
            : { id: "ms-id", userPrincipalName: "me@example.com" },
        ),
      };
    }
    throw new Error("Unexpected native command");
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(loadVaultSecret).mockResolvedValue(null);
  Object.assign(io, {
    state: "",
    callback: {},
    profileFails: false,
    refreshToken: "refresh",
    beforeCallback: null,
  });
  clearAllCachedAccessTokens();
  setEmailTriageCoordinator(null);
});

const cases = [
  {
    name: "gmail",
    connect: connectGmailAccount,
    descriptor: gmailOAuthProvider,
    providerAccountId: "me@example.com",
  },
  {
    name: "microsoft",
    connect: connectMicrosoftAccount,
    descriptor: microsoftOAuthProvider,
    providerAccountId: "ms-id",
  },
];
const accountFor = (test: (typeof cases)[number]): EmailTriageAccount => ({
  id: "account",
  provider: test.descriptor.provider,
  providerAccountId: test.providerAccountId,
  label: "old label",
  maskedAddress: "m***@example.com",
  generation: 3,
  enabled: true,
  mutationEnabled: true,
  paused: true,
  state: "reconnect_required",
  recoveryState: "none",
  lastSuccessAt: "last-success",
  lastError: "old-error",
  pollIntervalMinutes: 7,
  syncState: { trackedMessageIds: ["tracked"], cursor: "preserved" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

for (const test of cases) {
  describe(`${test.name} shared connect`, () => {
    it("uses PKCE, persists provider-specific bootstrap state and stores credentials only in the vault", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const result = await test.connect(repository, { clientId: "client-id" });
      expect(result.ok).toBe(true);
      const account = await repository.emailTriage.getAccount(result.accountId!);
      expect(account).toMatchObject({
        provider: test.descriptor.provider,
        providerAccountId: test.providerAccountId,
        state: test.descriptor.initialAccountState,
      });
      expect(account?.syncState).toMatchObject(
        test.name === "gmail"
          ? { baselineHistoryId: "100", cursorHistoryId: "100" }
          : { snapshotComplete: false, deltaLink: null },
      );
      const auth = new URL(vi.mocked(openUrl).mock.calls[0][0]);
      expect(auth.searchParams.get("state")).toBe(io.state);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("code_challenge")).toBeTruthy();
      expect(storeVaultSecret).toHaveBeenCalledWith(
        "provider_credentials",
        expect.stringContaining('"refreshToken":"refresh"'),
        result.accountId,
      );
      expect(JSON.stringify(account)).not.toContain('"refreshToken"');
      expect(__tokenCacheForTests.has("oauth-bootstrap")).toBe(false);
    });

    it("rejects state mismatch before HTTP or vault writes", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      io.callback = { state: "mismatch" };
      expect(await test.connect(repository, { clientId: "client-id" })).toEqual({
        ok: false,
        error: "oauth_state_mismatch",
      });
      expect(storeVaultSecret).not.toHaveBeenCalled();
      expect(
        vi.mocked(invoke).mock.calls.some(([command]) => command === "provider_http_request"),
      ).toBe(false);
    });

    it("requires a refresh token before loading a profile or saving an account", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      io.refreshToken = "";
      expect(await test.connect(repository, { clientId: "client-id" })).toEqual({
        ok: false,
        error: "missing_refresh_token",
      });
      expect(await repository.emailTriage.listAccounts()).toEqual([]);
      expect(storeVaultSecret).not.toHaveBeenCalled();
    });

    it("preserves reconnect fields while activating the same account", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const before = accountFor(test);
      await repository.emailTriage.saveAccount(before);
      expect(
        await test.connect(repository, { clientId: "client-id", reconnectAccountId: before.id }),
      ).toEqual({ ok: true, accountId: before.id });
      expect(await repository.emailTriage.getAccount(before.id)).toMatchObject({
        mutationEnabled: true,
        paused: true,
        generation: 3,
        pollIntervalMinutes: 7,
        lastSuccessAt: "last-success",
        syncState: before.syncState,
        state: "active",
        lastError: null,
      });
    });

    it("rejects a different authenticated identity without writing credentials", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const before = { ...accountFor(test), providerAccountId: "different" };
      await repository.emailTriage.saveAccount(before);
      expect(
        await test.connect(repository, { clientId: "client-id", reconnectAccountId: before.id }),
      ).toMatchObject({ ok: false, error: "reconnect_account_mismatch", reconnectMismatch: true });
      expect(storeVaultSecret).not.toHaveBeenCalled();
      expect(await repository.emailTriage.getAccount(before.id)).toEqual(before);
    });

    it("rejects late OAuth completion after the reconnect generation changes", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const before = accountFor(test);
      await repository.emailTriage.saveAccount(before);
      io.beforeCallback = async () => {
        await repository.emailTriage.saveAccount({ ...before, generation: 4 });
      };
      expect(
        (await test.connect(repository, { clientId: "client-id", reconnectAccountId: before.id }))
          .ok,
      ).toBe(false);
      expect(storeVaultSecret).not.toHaveBeenCalled();
    });

    it("keeps the provider's existing-account connection policy", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      const before = accountFor(test);
      await repository.emailTriage.saveAccount(before);
      expect(await test.connect(repository, { clientId: "client-id" })).toEqual({
        ok: true,
        accountId: before.id,
      });
      const after = await repository.emailTriage.getAccount(before.id);
      expect(after).toMatchObject({
        generation: 3,
        syncState: before.syncState,
        createdAt: before.createdAt,
        state: "active",
      });
      expect(after?.mutationEnabled).toBe(test.name === "microsoft");
      expect(after?.paused).toBe(test.name === "microsoft");
      expect(after?.pollIntervalMinutes).toBe(test.name === "microsoft" ? 7 : 5);
    });

    it("preserves provider-specific authorization callback error mapping", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      io.callback = { error: "access_denied", errorDescription: "AADSTS65001: consent required" };
      expect(await test.connect(repository, { clientId: "client-id" })).toEqual({
        ok: false,
        error: test.name === "microsoft" ? "admin_consent_required" : "access_denied",
      });
      expect(storeVaultSecret).not.toHaveBeenCalled();
    });

    it("clears bootstrap access tokens on profile failure", async () => {
      const repository = new MemoryRepository();
      await repository.initialize();
      io.profileFails = true;
      const work = test.connect(repository, { clientId: "client-id" });
      if (test.name === "gmail") await expect(work).rejects.toThrow("profile failed");
      else expect(await work).toEqual({ ok: false, error: "connect_failed" });
      expect(__tokenCacheForTests.has("oauth-bootstrap")).toBe(false);
      expect(storeVaultSecret).not.toHaveBeenCalled();
    });

    it("rotates refresh credentials only for Microsoft and caches the access token", async () => {
      vi.mocked(loadVaultSecret).mockResolvedValue(
        JSON.stringify({ refreshToken: "old", tokenType: "Bearer", scope: "existing-scope" }),
      );
      io.refreshToken = "rotated";
      const getter = createOAuthAccessTokenGetter(accountFor(test), "client-id", test.descriptor);
      expect(await getter()).toBe("access");
      expect(await getter()).toBe("access");
      expect(loadVaultSecret).toHaveBeenCalledOnce();
      if (test.name === "gmail") expect(storeVaultSecret).not.toHaveBeenCalled();
      else
        expect(storeVaultSecret).toHaveBeenCalledWith(
          "provider_credentials",
          JSON.stringify({ refreshToken: "rotated", tokenType: "Bearer", scope: "existing-scope" }),
          "account",
        );
    });
  });
}

it("keeps browser preview from invoking OAuth or writing credentials", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  vi.mocked(isTauriRuntime).mockReturnValue(false);
  for (const test of cases)
    expect(await test.connect(repository, { clientId: "client-id" })).toEqual({
      ok: false,
      error: "browser_preview",
    });
  expect(invoke).not.toHaveBeenCalled();
  expect(storeVaultSecret).not.toHaveBeenCalled();
});
