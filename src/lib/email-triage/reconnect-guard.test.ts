import { describe, expect, it } from "vitest";
import type { EmailTriageAccount } from "../../domain/email-triage";
import { snapshotReconnectTarget, validateReconnectCanProceed } from "./reconnect-guard";

const baseAccount = (overrides: Partial<EmailTriageAccount> = {}): EmailTriageAccount => ({
  id: "acct-1",
  provider: "microsoft_graph",
  providerAccountId: "oid-1",
  label: "Outlook",
  maskedAddress: "o***@example.com",
  generation: 1,
  enabled: false,
  mutationEnabled: false,
  paused: false,
  state: "disconnected",
  recoveryState: "none",
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("validateReconnectCanProceed", () => {
  it("allows reconnect when generation and provider account id are unchanged", () => {
    const account = baseAccount();
    const snapshot = snapshotReconnectTarget(account);
    expect(
      validateReconnectCanProceed({
        snapshot,
        currentAccount: account,
        authenticatedProviderAccountId: "oid-1",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects reconnect when generation changed during OAuth", () => {
    const account = baseAccount();
    const snapshot = snapshotReconnectTarget(account);
    expect(
      validateReconnectCanProceed({
        snapshot,
        currentAccount: { ...account, generation: 2, state: "disconnected" },
        authenticatedProviderAccountId: "oid-1",
      }),
    ).toEqual({ ok: false, error: "reconnect_cancelled" });
  });

  it("rejects reconnect when the account row was deleted", () => {
    const snapshot = snapshotReconnectTarget(baseAccount());
    expect(
      validateReconnectCanProceed({
        snapshot,
        currentAccount: null,
        authenticatedProviderAccountId: "oid-1",
      }),
    ).toEqual({ ok: false, error: "account_not_found" });
  });

  it("rejects reconnect when OAuth profile does not match the saved account", () => {
    const account = baseAccount();
    const snapshot = snapshotReconnectTarget(account);
    expect(
      validateReconnectCanProceed({
        snapshot,
        currentAccount: account,
        authenticatedProviderAccountId: "oid-other",
      }),
    ).toEqual({ ok: false, error: "reconnect_account_mismatch" });
  });
});
