import { describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { createEmailTriageAdapter } from "./runtime";

vi.mock("../storage/factory", () => ({
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("./vault", () => ({
  loadVaultSecret: vi.fn(async () => null),
  storeVaultSecret: vi.fn(async () => undefined),
  deleteVaultSecret: vi.fn(async () => undefined),
}));

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
  it("returns null for gmail without vault credentials in tauri runtime", async () => {
    const adapter = await createEmailTriageAdapter(gmailAccount, {
      ...defaultEmailTriageGlobalSettings(),
      gmailOAuthClientId: "client-id",
    });
    expect(adapter).toBeNull();
  });
});
