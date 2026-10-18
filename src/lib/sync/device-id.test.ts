import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDeviceId } from "./device-id";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("getDeviceId", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("returns the id reported by the native command", async () => {
    vi.mocked(invoke).mockResolvedValue("dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a");

    await expect(getDeviceId()).resolves.toBe("dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a");
    expect(invoke).toHaveBeenCalledWith("sync_device_id");
  });

  it("surfaces a string host error as an Error", async () => {
    vi.mocked(invoke).mockRejectedValue("device id file is corrupt");

    await expect(getDeviceId()).rejects.toThrow("device id file is corrupt");
  });
});
