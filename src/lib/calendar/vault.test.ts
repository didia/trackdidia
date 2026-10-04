import { beforeEach, expect, it, vi } from "vitest";
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../storage/factory", () => ({ isTauriRuntime: () => true }));
import { loadCalendarVaultSecret } from "./vault";

beforeEach(() => invokeMock.mockReset());

it("distinguishes missing credentials from vault read failure during connection recovery", async () => {
  invokeMock.mockResolvedValueOnce(null);
  expect(await loadCalendarVaultSecret("calendar_credentials", { throwOnError: true })).toBeNull();
  invokeMock.mockRejectedValueOnce(new Error("vault unavailable"));
  await expect(
    loadCalendarVaultSecret("calendar_credentials", { throwOnError: true }),
  ).rejects.toThrow("vault unavailable");
  invokeMock.mockRejectedValueOnce(new Error("vault unavailable"));
  expect(await loadCalendarVaultSecret("calendar_credentials")).toBeNull();
});
