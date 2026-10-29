// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { describeRepositoryContract } from "./repository.contract";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

describeRepositoryContract("TauriSqliteRepository (node:sqlite in-memory adapter)", async () => {
  const repository = new TauriSqliteRepository("sqlite::memory:", async () =>
    createNodeSqliteDatabase(),
  );
  await repository.initialize();
  return repository;
});

describe("TauriSqliteRepository mid-week decisions row mapping", () => {
  it("reads a corrupt snapshot JSON as laggingSnapshot null", async () => {
    let database: Awaited<ReturnType<typeof createNodeSqliteDatabase>> | null = null;
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => {
      database = await createNodeSqliteDatabase();
      return database;
    });
    await repository.initialize();
    await database!.execute(
      `INSERT INTO mid_week_decisions
         (week_start_date, decisions, decided_on_date, lagging_snapshot_json, updated_at)
       VALUES ('2026-08-02', 'X', '2026-08-05', '{not json', '2026-08-05T10:00:00.000Z')`,
    );

    await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toMatchObject({
      decisions: "X",
      laggingSnapshot: null,
    });
  });
});

describe("TauriSqliteRepository sync identity and status", () => {
  const DEVICE = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
  const OTHER = "dev:7f3c1a2e-9d4b-4c5e-8a1f-2b3c4d5e6f70";

  const open = async () => {
    const database = createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();
    return { database, repository };
  };

  it("creates the single identity row once and is idempotent", async () => {
    const { database, repository } = await open();
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "  Portable perso  " }),
    ).resolves.toEqual({
      deviceId: DEVICE,
      deviceName: "Portable perso",
      created: true,
      repaired: false,
    });
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Portable perso" }),
    ).resolves.toEqual({
      deviceId: DEVICE,
      deviceName: "Portable perso",
      created: false,
      repaired: false,
    });
    expect(
      await database.select(
        "SELECT id, device_id, device_name, physical_ms, counter, change_counter, last_publish_counter, applying FROM sync_identity",
      ),
    ).toEqual([
      {
        id: 1,
        device_id: DEVICE,
        device_name: "Portable perso",
        physical_ms: 0,
        counter: 0,
        change_counter: 0,
        last_publish_counter: 0,
        applying: 0,
      },
    ]);
  });

  it("repairs a cloned identity from the device-id file and keeps the clock state", async () => {
    const { database, repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: OTHER, deviceName: "Laptop A" });
    await database.execute(
      "UPDATE sync_identity SET physical_ms = 1800000000000, counter = 5, change_counter = 9, last_publish_counter = 4, applying = 0",
    );

    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop A" }),
    ).resolves.toEqual({
      deviceId: DEVICE,
      deviceName: "Laptop A",
      created: false,
      repaired: true,
    });

    expect(
      await database.select(
        "SELECT device_id, device_name, physical_ms, counter, change_counter, last_publish_counter FROM sync_identity",
      ),
    ).toEqual([
      {
        device_id: DEVICE,
        device_name: "Laptop A",
        physical_ms: 1800000000000,
        counter: 5,
        change_counter: 9,
        last_publish_counter: 4,
      },
    ]);
    // A second call with the same id is no longer a repair.
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop A" }),
    ).resolves.toMatchObject({ repaired: false });
  });

  it("updates the device name only when it is non-empty and different", async () => {
    const { repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" });
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "   " }),
    ).resolves.toMatchObject({ deviceName: "Laptop", repaired: false });
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Renamed" }),
    ).resolves.toMatchObject({ deviceName: "Renamed", repaired: false, created: false });
    await expect(repository.getSyncStatus()).resolves.toMatchObject({
      identity: { deviceId: DEVICE, deviceName: "Renamed" },
    });
  });

  it("rejects a garbage device id or name without writing anything", async () => {
    const { database, repository } = await open();
    for (const deviceId of [
      "",
      "not-an-id",
      "DEV:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a",
      "dev:0b9c7c1e-6a3f-1b8e-9d2a-1f2e3d4c5b6a",
      "dev:0B9C7C1E-6A3F-4B8E-9D2A-1F2E3D4C5B6A",
      `${DEVICE}\n`,
      ` ${DEVICE}`,
      "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6",
    ]) {
      await expect(
        repository.ensureSyncIdentity({ deviceId, deviceName: "Laptop" }),
      ).rejects.toThrow(/Invalid device id/);
    }
    await expect(
      repository.ensureSyncIdentity({ deviceId: undefined as unknown as string, deviceName: "x" }),
    ).rejects.toThrow(/Invalid device id/);
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "x".repeat(101) }),
    ).rejects.toThrow(/Invalid device name/);
    await expect(
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "" }),
    ).rejects.toThrow(/Invalid device name/);
    expect(await database.select("SELECT * FROM sync_identity")).toEqual([]);
  });

  it("serializes through the writer queue (concurrent calls create one row)", async () => {
    const { database, repository } = await open();
    const results = await Promise.all([
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" }),
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" }),
      repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await database.select("SELECT id FROM sync_identity")).toHaveLength(1);
  });

  it("reports counters, pending changes and defensively parsed peers", async () => {
    const { database, repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" });
    await database.execute(
      "UPDATE sync_identity SET change_counter = 12, last_publish_counter = 7 WHERE id = 1",
    );
    await database.execute(
      `INSERT INTO sync_peers (peer_id, peer_name, last_manifest_json, last_synced_at, last_applied_sha_by_domain) VALUES
        ('dev:b', 'Bureau', '{"schemaVersion":42,"appVersion":"1.2.3"}', '2026-10-18T10:00:00.000Z', '{"gtd":"abc","personal":7,"finance":null}'),
        ('dev:a', 'Atelier', '{not json', NULL, '[1,2]'),
        ('dev:c', 'Atelier', '[1]', NULL, 'oops')`,
    );

    const status = await repository.getSyncStatus();
    expect(status).toEqual({
      supported: true,
      identity: { deviceId: DEVICE, deviceName: "Laptop" },
      changeCounter: 12,
      lastPublishCounter: 7,
      pendingChanges: 5,
      captureEnabled: false,
      backfillComplete: false,
      backfillProgress: null,
      peers: [
        {
          peerId: "dev:a",
          peerName: "Atelier",
          lastManifest: null,
          lastSyncedAt: null,
          lastAppliedShaByDomain: {},
        },
        {
          peerId: "dev:c",
          peerName: "Atelier",
          lastManifest: null,
          lastSyncedAt: null,
          lastAppliedShaByDomain: {},
        },
        {
          peerId: "dev:b",
          peerName: "Bureau",
          lastManifest: { schemaVersion: 42, appVersion: "1.2.3" },
          lastSyncedAt: "2026-10-18T10:00:00.000Z",
          lastAppliedShaByDomain: { gtd: "abc" },
        },
      ],
    });
  });

  it("never reports negative pending changes", async () => {
    const { database, repository } = await open();
    await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Laptop" });
    await database.execute(
      "UPDATE sync_identity SET change_counter = 2, last_publish_counter = 9 WHERE id = 1",
    );
    await expect(repository.getSyncStatus()).resolves.toMatchObject({ pendingChanges: 0 });
  });
});
