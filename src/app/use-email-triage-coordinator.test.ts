import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailTriageConversation } from "../domain/email-triage";
import { defaultAppSettings } from "../domain/daily-entry";
import { defaultEmailTriageGlobalSettings } from "../domain/email-triage";
import {
  getEmailTriageCoordinator,
  setEmailTriageCoordinator,
} from "../lib/email-triage/gmail-session";
import { planGtdOwnershipUpdate } from "../lib/email-triage/gtd-ownership";
import { MemoryRepository } from "../lib/storage/memory-repository";
import {
  buildEmailTriageRepositoryPort,
  useEmailTriageCoordinator,
} from "./use-email-triage-coordinator";
import { checkVaultAvailability } from "../lib/email-triage/vault";

const requestCalendarSyncMock = vi.fn();
vi.mock("./use-calendar-sync", () => ({
  requestCalendarSync: () => requestCalendarSyncMock(),
}));

vi.mock("../lib/email-triage/vault", () => ({
  checkVaultAvailability: vi.fn(),
  loadVaultSecret: vi.fn(async () => null),
}));

describe("useEmailTriageCoordinator", () => {
  beforeEach(() => {
    setEmailTriageCoordinator(null);
  });

  afterEach(() => {
    setEmailTriageCoordinator(null);
  });

  it("does not clear a replacement coordinator when an obsolete start finishes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.emailTriage.saveGlobalSettings({
      ...defaultEmailTriageGlobalSettings(),
      enabled: true,
    });

    const vaultResolvers: Array<(value: { available: boolean; reason: string | null }) => void> =
      [];
    vi.mocked(checkVaultAvailability).mockImplementation(
      () =>
        new Promise((resolve) => {
          vaultResolvers.push(resolve);
        }),
    );

    const { rerender } = renderHook(
      ({ aiBaseUrl }: { aiBaseUrl: string }) =>
        useEmailTriageCoordinator(repository, {
          browserPreview: false,
          allowStart: true,
          settings: { ...defaultAppSettings(), aiBaseUrl },
        }),
      { initialProps: { aiBaseUrl: "https://openrouter.ai/api/v1" } },
    );

    await waitFor(() => {
      expect(vaultResolvers.length).toBe(1);
    });

    rerender({ aiBaseUrl: "https://example.invalid/v1" });

    await waitFor(() => {
      expect(vaultResolvers.length).toBe(2);
    });
    const replacement = getEmailTriageCoordinator();
    expect(replacement).not.toBeNull();

    vaultResolvers[0]?.({ available: false, reason: "obsolete" });

    await waitFor(() => {
      expect(getEmailTriageCoordinator()).toBe(replacement);
    });
  });

  it("nudges the calendar-sync reconciler from the GTD-update adapter (backstop only)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository.emailTriage, "applyGtdUpdate").mockResolvedValue(null);

    const port = buildEmailTriageRepositoryPort(repository);
    requestCalendarSyncMock.mockClear();

    const conversation: EmailTriageConversation = {
      id: "conv-1",
      accountId: "account-1",
      conversationKey: "thread-1",
      decisionVersion: 1,
      routingState: "relevant",
      taskId: null,
      lastGeneratedTitle: null,
      managedNotesRevision: 1,
      managedNotesHash: null,
      sourceUrl: "https://example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const plan = planGtdOwnershipUpdate({
      conversation,
      existingTask: null,
      routedDecision: "relevant",
      suggestedTitle: "Task title",
      summary: "summary",
      rationale: "rationale",
      sourceUrl: "https://example.com",
    });

    await port.applyEmailTriageGtdUpdate({
      externalId: "msg-1",
      plan,
      conversation,
      accountId: "account-1",
    });

    expect(requestCalendarSyncMock).toHaveBeenCalled();
  });
});
