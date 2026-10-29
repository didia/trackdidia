import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  listSyncPeers,
  prepareSyncFolder,
  publishSyncBundle,
  readSyncBundle,
  SyncFolderError,
  toSyncFolderError,
} from "./folder-api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const DEVICE_A = "dev:3f1c0b9c-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const DEVICE_B = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const target = {
  folderDir: "/Drive/GTD",
  role: "gtd" as const,
  environment: "production" as const,
};

describe("folder-api base64", () => {
  it("round-trips arbitrary bytes, including every byte value and large inputs", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);

    const large = new Uint8Array(0x8000 * 3 + 17).map((_, index) => (index * 31) % 251);
    expect(base64ToBytes(bytesToBase64(large))).toEqual(large);
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("matches the standard alphabet the host uses", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello bundle"))).toBe("aGVsbG8gYnVuZGxl");
    expect(bytesToBase64(Uint8Array.from([251, 255]))).toBe("+/8=");
  });
});

describe("folder-api commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("prepares a folder, passing the other folder only for the nesting check", async () => {
    vi.mocked(invoke).mockResolvedValue({ syncDir: "/Drive/GTD/sync", role: "gtd" });

    await expect(prepareSyncFolder(target, "/Drive/Personal")).resolves.toEqual({
      syncDir: "/Drive/GTD/sync",
      role: "gtd",
    });
    expect(invoke).toHaveBeenCalledWith("sync_prepare_folder", {
      folderDir: "/Drive/GTD",
      role: "gtd",
      environment: "production",
      otherFolderDir: "/Drive/Personal",
    });

    await prepareSyncFolder(target);
    expect(invoke).toHaveBeenLastCalledWith("sync_prepare_folder", {
      folderDir: "/Drive/GTD",
      role: "gtd",
      environment: "production",
      otherFolderDir: null,
    });
  });

  it("publishes bundle bytes as base64 with the manifest as JSON and returns the host's generation", async () => {
    vi.mocked(invoke).mockResolvedValue({
      generation: 4,
      file: "gtd-4.bundle",
      sha256: "ab".repeat(32),
      bytes: 3,
      warnings: [],
    });

    const result = await publishSyncBundle({
      ...target,
      deviceId: DEVICE_A,
      domain: "gtd",
      bundle: Uint8Array.from([1, 2, 3]),
      rows: 9,
      manifest: { formatVersion: 1, deviceId: DEVICE_A },
    });

    expect(result.generation).toBe(4);
    expect(invoke).toHaveBeenCalledWith("sync_publish", {
      folderDir: "/Drive/GTD",
      role: "gtd",
      environment: "production",
      deviceId: DEVICE_A,
      domain: "gtd",
      bundleBase64: "AQID",
      rows: 9,
      manifestJson: JSON.stringify({ formatVersion: 1, deviceId: DEVICE_A }),
    });
  });

  it("lists peers and passes only the own device id besides the folder target", async () => {
    vi.mocked(invoke).mockResolvedValue({
      peers: [{ deviceId: DEVICE_B, domains: {} }],
      own: null,
      ignored: [{ path: "x", reason: "conflict_copy" }],
    });

    const listed = await listSyncPeers({ ...target, ownDeviceId: DEVICE_A });
    expect(listed.peers).toHaveLength(1);
    expect(listed.ignored[0]?.reason).toBe("conflict_copy");
    expect(invoke).toHaveBeenCalledWith("sync_list_peers", {
      folderDir: "/Drive/GTD",
      role: "gtd",
      environment: "production",
      ownDeviceId: DEVICE_A,
    });
  });

  it("decodes a verified bundle and passes a not-ready result through", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      status: "ok",
      bytesBase64: "AQID",
      generation: 2,
      sha256: "cd".repeat(32),
      bytes: 3,
      rows: 7,
    });
    const read = await readSyncBundle({
      ...target,
      ownDeviceId: DEVICE_A,
      peerDeviceId: DEVICE_B,
      domain: "gtd",
    });
    expect(read).toEqual({
      status: "ok",
      bytes: Uint8Array.from([1, 2, 3]),
      generation: 2,
      sha256: "cd".repeat(32),
      rows: 7,
    });
    expect(invoke).toHaveBeenCalledWith("sync_read_bundle", {
      folderDir: "/Drive/GTD",
      role: "gtd",
      environment: "production",
      ownDeviceId: DEVICE_A,
      peerDeviceId: DEVICE_B,
      domain: "gtd",
    });

    vi.mocked(invoke).mockResolvedValueOnce({ status: "notReady", reason: "hash_mismatch" });
    await expect(
      readSyncBundle({ ...target, ownDeviceId: DEVICE_A, peerDeviceId: DEVICE_B, domain: "gtd" }),
    ).resolves.toEqual({ status: "notReady", reason: "hash_mismatch" });
  });
});

describe("folder-api errors", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it.each([
    "folder_not_found",
    "folder_not_prepared",
    "role_mismatch",
    "nested_folder",
    "domain_not_allowed",
    "device_id_invalid",
    "too_large",
    "timeout",
    "io",
    "invalid_argument",
  ])("maps the host code %s to a typed error", async (code) => {
    vi.mocked(invoke).mockRejectedValue({ code, message: `host said ${code}` });

    const error = await prepareSyncFolder(target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SyncFolderError);
    expect((error as SyncFolderError).code).toBe(code);
    expect((error as SyncFolderError).message).toBe(`host said ${code}`);
  });

  it("applies to every command", async () => {
    vi.mocked(invoke).mockRejectedValue({ code: "timeout", message: "slow drive" });
    const calls = [
      publishSyncBundle({
        ...target,
        deviceId: DEVICE_A,
        domain: "gtd",
        bundle: new Uint8Array(),
        rows: 0,
        manifest: {},
      }),
      listSyncPeers({ ...target, ownDeviceId: DEVICE_A }),
      readSyncBundle({
        ...target,
        ownDeviceId: DEVICE_A,
        peerDeviceId: DEVICE_B,
        domain: "gtd",
      }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ name: "SyncFolderError", code: "timeout" });
    }
  });

  it("falls back to unknown for anything that is not a coded host error", () => {
    expect(toSyncFolderError("boom")).toMatchObject({ code: "unknown", message: "boom" });
    expect(toSyncFolderError(new Error("bad"))).toMatchObject({ code: "unknown", message: "bad" });
    expect(toSyncFolderError({ code: "made_up", message: "x" })).toMatchObject({
      code: "unknown",
    });
    expect(toSyncFolderError(undefined)).toMatchObject({ code: "unknown" });
    const typed = new SyncFolderError("io", "x");
    expect(toSyncFolderError(typed)).toBe(typed);
  });
});
