import { describe, expect, it } from "vitest";
import { MemoryRepository } from "./memory-repository";
import { describeRepositoryContract } from "./repository.contract";

describeRepositoryContract("MemoryRepository", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  return repository;
});

describe("MemoryRepository sync (browser preview)", () => {
  it("reports sync as unsupported, exactly", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await expect(repository.getSyncStatus()).resolves.toStrictEqual({ supported: false });
  });

  it("rejects identity creation with a clear browser-preview error, even for valid input", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await expect(
      repository.ensureSyncIdentity({
        deviceId: "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
        deviceName: "Laptop",
      }),
    ).rejects.toThrow("Multi-device sync is unavailable in browser preview");
    await expect(repository.getSyncStatus()).resolves.toStrictEqual({ supported: false });
  });
});
