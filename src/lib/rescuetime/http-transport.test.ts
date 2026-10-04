import { invoke } from "@tauri-apps/api/core";
import { fetchRescueTimeJson, RESCUETIME_REQUEST_TIMEOUT_MS } from "./http-transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../storage/factory", () => ({ isTauriRuntime: () => true }));

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  invokeMock.mockReset();
});

describe("RescueTime desktop HTTP transport", () => {
  it("uses the allowlisted provider command with bearer auth and timeout", async () => {
    invokeMock.mockResolvedValue({ status: 200, body: '{"rows":[]}' });

    await expect(
      fetchRescueTimeJson("https://www.rescuetime.com/anapi/data", "test-key"),
    ).resolves.toEqual({ rows: [] });
    expect(invokeMock).toHaveBeenCalledWith("provider_http_request", {
      request: {
        method: "GET",
        url: "https://www.rescuetime.com/anapi/data",
        headers: { Authorization: "Bearer test-key" },
        timeoutMs: RESCUETIME_REQUEST_TIMEOUT_MS,
      },
    });
  });

  it("keeps RescueTime status and timeout messages", async () => {
    invokeMock.mockResolvedValueOnce({ status: 401, body: "Unauthorized" });
    await expect(
      fetchRescueTimeJson("https://www.rescuetime.com/api/resource/goals", "bad-key"),
    ).rejects.toThrow("RescueTime API 401: Unauthorized");

    invokeMock.mockRejectedValueOnce("HTTP request failed: operation timed out");
    await expect(
      fetchRescueTimeJson("https://www.rescuetime.com/api/resource/goals", "test-key"),
    ).rejects.toThrow("RescueTime request timed out.");
  });
});
