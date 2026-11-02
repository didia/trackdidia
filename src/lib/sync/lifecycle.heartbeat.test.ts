// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_HEARTBEAT_MS } from "./engine-publish";
import { createSyncLifecycle, type SyncLifecycle } from "./lifecycle";
import { SYNC_HOURLY_PULL_MS } from "./lifecycle-policy";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
} from "./test-support/engine-harness";

/**
 * The manifest heartbeat through the REAL lifecycle gate and the REAL engine: a clean device (nothing
 * pending) must still refresh a manifest older than the heartbeat, and must write nothing while the
 * manifest is fresh. `engine-publish.ts` decides what to write; `shouldPublish` used to refuse every
 * automatic publish with nothing pending, so the engine's heartbeat was never reached.
 *
 * SAFETY: in-memory databases and in-memory folders only.
 */

const DAY = 24 * 60 * 60_000;
const ROLES = ["personal", "gtd"] as const;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const lifecycleOf = (device: EngineDevice): SyncLifecycle =>
  createSyncLifecycle({
    now: () => device.clock.read(),
    runner: async () => ({
      pull: () => device.engine.pull(),
      publish: () => device.engine.publish(),
    }),
    pendingChanges: async () => {
      const status = await device.repo.getSyncStatus();
      return status.supported ? status.pendingChanges : 0;
    },
    runExclusive: (work) => work(),
    manualBusy: () => false,
    onDataChanged: () => undefined,
    onChange: () => undefined,
  });

const writtenAt = (world: EngineWorld, device: EngineDevice) =>
  ROLES.map((role) => world.folders.manifestFor(role, device.deviceId)?.writtenAt ?? null);

const publishWrites = (world: EngineWorld, device: EngineDevice) =>
  ROLES.reduce((sum, role) => sum + world.folders.calls(device.deviceId, role).publish, 0);

const settled = async (lifecycle: SyncLifecycle) => {
  await vi.advanceTimersByTimeAsync(1);
  await lifecycle.whenIdle();
};

const cleanDevice = async () => {
  const world = await createEngineWorld([{ name: "A" }]);
  const a = world.device("A");
  await a.engine.publish();
  const status = await a.repo.getSyncStatus();
  expect(status.supported && status.pendingChanges).toBe(0);
  return { world, a };
};

describe("a clean device and the manifest heartbeat, through the lifecycle", () => {
  it("at startup, refreshes an ageing manifest although nothing is pending", async () => {
    const { world, a } = await cleanDevice();
    const before = writtenAt(world, a);
    expect(before.every((value) => value !== null)).toBe(true);
    a.clock.advance(PUBLISH_HEARTBEAT_MS + DAY);
    a.calls.length = 0;
    const writesBefore = publishWrites(world, a);

    const lifecycle = lifecycleOf(a);
    lifecycle.start({ publishNow: true });
    await settled(lifecycle);

    const after = writtenAt(world, a);
    for (const [index, value] of after.entries()) {
      expect(Date.parse(value ?? "")).toBeGreaterThan(Date.parse(before[index] ?? ""));
    }
    expect(publishWrites(world, a)).toBeGreaterThan(writesBefore);
    expect(lifecycle.snapshot().lastClass).toBe("ok");
    lifecycle.stop();
  });

  it("at startup, writes nothing while the manifest is fresh (idle stays write-free)", async () => {
    const { world, a } = await cleanDevice();
    a.clock.advance(DAY);
    const before = writtenAt(world, a);
    const writesBefore = publishWrites(world, a);
    a.calls.length = 0;

    const lifecycle = lifecycleOf(a);
    lifecycle.start({ publishNow: true });
    await settled(lifecycle);

    expect(writtenAt(world, a)).toEqual(before);
    expect(publishWrites(world, a)).toBe(writesBefore);
    expect(a.calls.filter((call) => call.method === "readSyncSnapshot")).toEqual([]);
    expect(lifecycle.snapshot().lastClass).toBe("ok");
    lifecycle.stop();
  });

  it("in a long session, the hourly tick refreshes a manifest that aged meanwhile, and only then", async () => {
    const { world, a } = await cleanDevice();
    const lifecycle = lifecycleOf(a);
    lifecycle.start({ publishNow: true });
    await settled(lifecycle);
    const writesAtStart = publishWrites(world, a);
    const first = writtenAt(world, a);

    // A week of hourly ticks on a fresh manifest: no write.
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      a.clock.advance(SYNC_HOURLY_PULL_MS);
      await vi.advanceTimersByTimeAsync(SYNC_HOURLY_PULL_MS);
    }
    await lifecycle.whenIdle();
    expect(publishWrites(world, a)).toBe(writesAtStart);
    expect(writtenAt(world, a)).toEqual(first);

    // The laptop sleeps past the heartbeat (clock jump), then an hourly tick fires.
    a.clock.advance(PUBLISH_HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(SYNC_HOURLY_PULL_MS);
    await lifecycle.whenIdle();
    expect(publishWrites(world, a)).toBeGreaterThan(writesAtStart);
    for (const [index, value] of writtenAt(world, a).entries()) {
      expect(Date.parse(value ?? "")).toBeGreaterThan(Date.parse(first[index] ?? ""));
    }
    lifecycle.stop();
  });

  it("blur and quit still publish nothing for a clean device", async () => {
    const { world, a } = await cleanDevice();
    a.clock.advance(PUBLISH_HEARTBEAT_MS + DAY);
    const lifecycle = lifecycleOf(a);
    lifecycle.start();
    const before = writtenAt(world, a);
    await lifecycle.hidden();
    await lifecycle.quit(3_000);
    expect(writtenAt(world, a)).toEqual(before);
    lifecycle.stop();
  });
});
