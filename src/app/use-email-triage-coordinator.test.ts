import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../domain/daily-entry";
import { defaultEmailTriageGlobalSettings } from "../domain/email-triage";
import {
  getEmailTriageCoordinator,
  setEmailTriageCoordinator,
} from "../lib/email-triage/gmail-session";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { useEmailTriageCoordinator } from "./use-email-triage-coordinator";
import { checkVaultAvailability } from "../lib/email-triage/vault";

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
    await repository.saveEmailTriageGlobalSettings({
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
});
