// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isValidDeviceId } from "../status";
import {
  createFakeClock,
  createSyncHarness,
  harnessDeviceId,
  HARNESS_START_MS,
} from "./two-device-harness";

describe("two-device harness", () => {
  it("builds independent laptops with valid, distinct device ids and their own clocks", async () => {
    const sim = await createSyncHarness(3);
    expect(sim.devices.map((device) => device.name)).toEqual(["A", "B", "C"]);
    const ids = sim.devices.map((device) => device.deviceId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(isValidDeviceId(id)).toBe(true);
    expect(harnessDeviceId(0)).toBe(ids[0]);
    for (const device of sim.devices) {
      expect(await device.repo.getSyncStatus()).toMatchObject({
        supported: true,
        captureEnabled: true,
        identity: { deviceId: device.deviceId },
      });
    }
    const [a, b] = sim.devices as [(typeof sim.devices)[number], (typeof sim.devices)[number]];
    a.clock.advance(1_000);
    expect(a.clock.now).toBe(HARNESS_START_MS + 1_000);
    expect(b.clock.now).toBe(HARNESS_START_MS);
    await a.repo.createTask({ id: "only-a", title: "A", bucket: "inbox" });
    expect(await b.repo.listTasks({})).toEqual([]);
  });

  it("issues sync clocks from the device's own fake clock", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.device("A");
    a.clock.set(HARNESS_START_MS + 123_456);
    await a.repo.createTask({ id: "t", title: "t", bucket: "inbox" });
    const [meta] = await a.db.select<{ row_hlc: string }[]>(
      "SELECT row_hlc FROM sync_entity_meta WHERE entity_type = 'gtd_tasks'",
    );
    expect(meta?.row_hlc.startsWith(String(HARNESS_START_MS + 123_456).padStart(15, "0"))).toBe(
      true,
    );
  });

  it("exchanges through a JSON round trip and syncAll reaches a fixed point", async () => {
    const sim = await createSyncHarness(3);
    const [a, b, c] = sim.devices as [
      (typeof sim.devices)[number],
      (typeof sim.devices)[number],
      (typeof sim.devices)[number],
    ];
    await a.repo.createTask({ id: "ta", title: "A", bucket: "inbox" });
    await b.repo.createTask({ id: "tb", title: "B", bucket: "inbox" });
    await c.repo.createTask({ id: "tc", title: "C", bucket: "inbox" });
    const results = await sim.syncAll("gtd");
    expect(results.at(-1)?.applied).toBe(0);
    for (const device of sim.devices) {
      expect((await device.repo.listTasks({})).map((task) => task.id).sort()).toEqual([
        "ta",
        "tb",
        "tc",
      ]);
    }
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("dumps ignore device-local tables, and expectConverged fails on real divergence", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [(typeof sim.devices)[number], (typeof sim.devices)[number]];
    await a.db.execute(
      "INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at) VALUES ('x','gtd_tasks','t','overwritten_edit','{}','{}','now')",
    );
    await a.db.execute("UPDATE sync_identity SET change_counter = 99");
    await sim.expectConverged("gtd", { snapshots: true });
    await a.repo.createTask({ id: "only-a", title: "A", bucket: "inbox" });
    await expect(sim.expectConverged("gtd")).rejects.toThrow();
    await sim.syncAll("gtd");
    await sim.expectConverged("gtd");
    expect(b).toBeDefined();
  });

  it("rejects an unknown device name", async () => {
    const sim = await createSyncHarness(["A"]);
    expect(() => sim.device("Z")).toThrow(/No simulated device/);
  });

  it("a fake clock can be set and advanced", () => {
    const clock = createFakeClock(5);
    clock.advance();
    expect(clock.now).toBe(60_005);
    clock.set(7);
    expect(clock.read()).toBe(7);
  });
});
