import { describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { EmailTriageCoordinator } from "./coordinator";
import type { EmailTriageRepositoryPort } from "./sync-engine";

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
});
