import { describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import type { EmailTriageAccount, EmailTriageTransientMessage } from "../../domain/email-triage";
import { EmailTriageCoordinator } from "./coordinator";
import type { EmailTriageRepositoryPort } from "./sync-engine";
import { loadVaultSecret } from "./vault";

vi.mock("./vault", () => ({
  checkVaultAvailability: vi.fn(async () => ({ available: true, reason: null })),
  loadVaultSecret: vi.fn(async () => null),
}));

const unusedPort = {
  getAccount: async () => null,
  updateAccountSyncState: async () => {
    throw new Error("not used");
  },
  upsertConversation: async () => {
    throw new Error("not used");
  },
  getConversationByKey: async () => null,
  persistMessageBatch: async () => ({ conversations: [] }),
  getMessageByProviderId: async () => null,
  getConversation: async () => null,
  dismissPendingReviews: async () => undefined,
  listPendingEffects: async () => [],
  listPendingEffectsForAccount: async () => [],
  saveDesiredEffect: async () => undefined,
  getTaskByExternalId: async () => null,
  applyEmailTriageGtdUpdate: async () => null,
  createReview: async () => undefined,
} satisfies Omit<EmailTriageRepositoryPort, "getGlobalSettings">;

const baseCoordinatorAccount = (): EmailTriageAccount => ({
  id: "acct-1",
  provider: "gmail",
  providerAccountId: "user-1",
  label: "Test",
  maskedAddress: "t***@example.com",
  generation: 1,
  enabled: true,
  mutationEnabled: false,
  paused: false,
  state: "active",
  recoveryState: "none",
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const inboxTransient = (id: string): EmailTriageTransientMessage => ({
  providerMessageId: id,
  conversationKey: `thread-${id}`,
  messageIdHeader: null,
  references: [],
  inReplyTo: null,
  subject: `Subject ${id}`,
  sender: "a@b.com",
  recipients: ["me@example.com"],
  receivedAt: "2026-01-01T00:00:00.000Z",
  bodyText: "Body",
  sourceUrl: null,
  inInbox: true,
});

describe("EmailTriageCoordinator", () => {
  it("does not start polling when the feature is disabled", async () => {
    let listedAccounts = false;
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => defaultEmailTriageGlobalSettings(),
        listAccounts: async () => {
          listedAccounts = true;
          return [];
        },
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => null,
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    expect(listedAccounts).toBe(false);
  });

  it("does not reschedule after stop", async () => {
    vi.useFakeTimers();
    const runSpy = vi.fn();
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => ({
          id: "acct-1",
          provider: "gmail",
          providerAccountId: "user-1",
          label: "Test",
          maskedAddress: "t***@example.com",
          generation: 1,
          enabled: true,
          mutationEnabled: false,
          paused: false,
          state: "active",
          recoveryState: "none",
          lastSuccessAt: null,
          lastError: null,
          pollIntervalMinutes: 5,
          syncState: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        listAccounts: async () => [
          {
            id: "acct-1",
            provider: "gmail",
            providerAccountId: "user-1",
            label: "Test",
            maskedAddress: "t***@example.com",
            generation: 1,
            enabled: true,
            mutationEnabled: false,
            paused: false,
            state: "active",
            recoveryState: "none",
            lastSuccessAt: null,
            lastError: null,
            pollIntervalMinutes: 5,
            syncState: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => {
        runSpy();
        return null;
      },
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("starts polling after reconfigure when the feature is enabled", async () => {
    let enabled = false;
    let listedAccounts = false;
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled,
        }),
        listAccounts: async () => {
          listedAccounts = true;
          return [];
        },
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => null,
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    expect(listedAccounts).toBe(false);
    enabled = true;
    await coordinator.reconfigure();
    expect(listedAccounts).toBe(true);
  });

  it("advances the saved cursor between pages in one run", async () => {
    const seenStates: Array<Record<string, unknown>> = [];
    const account = {
      id: "acct-1",
      provider: "gmail" as const,
      providerAccountId: "user-1",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active" as const,
      recoveryState: "none" as const,
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {} as Record<string, unknown>,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => account,
        updateAccountSyncState: async (_accountId, syncState) => {
          account.syncState = { ...syncState };
          return { ...account, syncState: { ...syncState } };
        },
        listAccounts: async () => [account],
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => ({
        provider: "gmail",
        fetchPage: async (syncState) => {
          seenStates.push({ ...syncState });
          if (!syncState.page) {
            return {
              messages: [],
              cursorUpdate: { page: 1 },
              hasMore: true,
              gapDetected: false,
            };
          }
          return {
            messages: [],
            cursorUpdate: { page: 2 },
            hasMore: false,
            gapDetected: false,
          };
        },
      }),
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    await coordinator.runAccountSync("acct-1");
    expect(seenStates).toEqual([{}, { page: 1 }]);
  });

  it("marks reconnect_required without retrying on invalid grant", async () => {
    vi.useFakeTimers();
    const account = {
      id: "acct-1",
      provider: "gmail" as const,
      providerAccountId: "user-1",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active" as const,
      recoveryState: "none" as const,
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {} as Record<string, unknown>,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let fetchAttempts = 0;
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => account,
        updateAccountSyncState: async (_accountId, syncState, patch) => {
          Object.assign(account, patch ?? {});
          account.syncState = { ...syncState };
          return { ...account };
        },
        listAccounts: async () => [account],
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => ({
        provider: "gmail",
        fetchPage: async () => {
          fetchAttempts += 1;
          throw new Error("reconnect_required");
        },
      }),
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    const result = await coordinator.runAccountSync("acct-1");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(fetchAttempts).toBe(1);
    expect(account.state).toBe("reconnect_required");
    expect(account.lastError).toBe("reconnect_required");
    vi.useRealTimers();
  });

  it("marks reconnect_required when gmail adapter creation fails", async () => {
    const account = {
      id: "acct-1",
      provider: "gmail" as const,
      providerAccountId: "user-1",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active" as const,
      recoveryState: "none" as const,
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {} as Record<string, unknown>,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => account,
        updateAccountSyncState: async (_accountId, syncState, patch) => {
          Object.assign(account, patch ?? {});
          account.syncState = { ...syncState };
          return { ...account };
        },
        listAccounts: async () => [account],
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => null,
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    const result = await coordinator.runAccountSync("acct-1");
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(account.state).toBe("reconnect_required");
  });

  it("records adapter construction failures and reschedules polling", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const account = baseCoordinatorAccount();
    const createAdapter = vi.fn(async () => {
      throw new Error("vault failed");
    });
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => account,
        updateAccountSyncState: async (_accountId, syncState, patch) => {
          Object.assign(account, patch ?? {});
          account.syncState = { ...syncState };
          return { ...account };
        },
        listAccounts: async () => [account],
        recoverStaleEffects: async () => 0,
      },
      createAdapter,
      classifierProvider: { completeStructured: async () => "" },
      browserPreview: false,
    });
    await coordinator.start();
    const result = await coordinator.runAccountSync("acct-1");
    expect(result).toEqual({ ok: false, reason: "sync_failed" });
    expect(account.state).toBe("error");
    expect(account.lastError).toBe("vault failed");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(createAdapter).toHaveBeenCalledTimes(2);
    vi.mocked(Math.random).mockRestore();
    vi.useRealTimers();
  });

  it("stops later classifier requests when an in-flight page is cancelled", async () => {
    vi.mocked(loadVaultSecret).mockResolvedValueOnce("test-key");
    const account = baseCoordinatorAccount();
    let classifyCount = 0;
    let resolveFirstClassify: (value: string) => void = () => {
      throw new Error("classifier was not waiting");
    };
    const firstClassify = new Promise<string>((resolve) => {
      resolveFirstClassify = resolve;
    });
    const persistCalls: string[] = [];
    const coordinator = new EmailTriageCoordinator({
      repository: {
        ...unusedPort,
        getGlobalSettings: async () => ({
          ...defaultEmailTriageGlobalSettings(),
          enabled: true,
        }),
        getAccount: async () => account,
        updateAccountSyncState: async (_accountId, syncState, patch) => {
          Object.assign(account, patch ?? {});
          account.syncState = { ...syncState };
          return { ...account };
        },
        getConversationByKey: async () => null,
        upsertConversation: async (accountId, conversationKey, patch) => ({
          id: `conv-${conversationKey}`,
          accountId,
          conversationKey,
          decisionVersion: patch.decisionVersion ?? 0,
          routingState: patch.routingState ?? "pending",
          taskId: null,
          lastGeneratedTitle: null,
          managedNotesRevision: 0,
          managedNotesHash: null,
          sourceUrl: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        persistMessageBatch: async (input) => {
          persistCalls.push(
            ...input.messages.map((message) => message.transient.providerMessageId),
          );
          return { conversations: [] };
        },
        listAccounts: async () => [account],
        recoverStaleEffects: async () => 0,
      },
      createAdapter: () => ({
        provider: "gmail",
        fetchPage: async () => ({
          messages: [inboxTransient("m1"), inboxTransient("m2")],
          cursorUpdate: { cursorHistoryId: "2" },
          hasMore: false,
          gapDetected: false,
        }),
      }),
      classifierProvider: {
        completeStructured: async () => {
          classifyCount += 1;
          if (classifyCount === 1) {
            return firstClassify;
          }
          return JSON.stringify({
            decision: "review",
            relevance: null,
            ignoreReason: null,
            confidence: 0.5,
            summary: "s",
            rationale: "r",
            suggestedTaskTitle: "t",
          });
        },
      },
      browserPreview: false,
    });
    await coordinator.start();
    const syncPromise = coordinator.runAccountSync("acct-1");
    await vi.waitFor(() => {
      expect(classifyCount).toBe(1);
    });
    coordinator.stop();
    resolveFirstClassify(
      JSON.stringify({
        decision: "review",
        relevance: null,
        ignoreReason: null,
        confidence: 0.5,
        summary: "s",
        rationale: "r",
        suggestedTaskTitle: "t",
      }),
    );
    await expect(syncPromise).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(classifyCount).toBe(1);
    expect(persistCalls).toEqual([]);
    expect(account.syncState.cursorHistoryId).toBeUndefined();
  });
});
