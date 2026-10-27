// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SyncChangeSet } from "../change-set";
import { createMemoryFolders, ROLE_DOMAINS } from "./memory-transport";
import { harnessDeviceId, createSyncHarness } from "./two-device-harness";
import { SyncTransportError, type PublishMeta } from "../transport";

/** The in-memory folders are the engine's only transport in tests: pin their protocol behavior. */

const meta = (writtenAtMs = Date.UTC(2026, 9, 1)): PublishMeta => ({
  deviceName: "Test",
  appVersion: "0.0.0",
  profile: "personal",
  calendarSyncEnabled: false,
  writtenAtMs,
});

const setup = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  const [a, b] = [sim.device("A"), sim.device("B")];
  await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
  const changeSet = (await a.repo.listSyncChanges("gtd")) as SyncChangeSet;
  const folders = createMemoryFolders();
  return {
    a,
    b,
    changeSet,
    folders,
    ta: folders.attach(a.deviceId, "gtd"),
    tb: folders.attach(b.deviceId, "gtd"),
  };
};

describe("memory folders", () => {
  it("declare the domains of their role", async () => {
    const { ta, folders, a } = await setup();
    expect(ta.domains).toEqual(ROLE_DOMAINS.gtd);
    expect(folders.attach(a.deviceId, "personal").domains).toEqual(["personal", "finance"]);
  });

  it("publish bundle first and manifest last; a reader sees a bundle only through the manifest", async () => {
    const { ta, tb, folders, a, changeSet } = await setup();
    folders.crashNextPublishes("gtd");
    await expect(ta.publish("gtd", changeSet, meta())).rejects.toBeInstanceOf(SyncTransportError);
    // The file is there, but nobody can learn of it.
    expect(folders.filesOf("gtd").map((file) => file.path)).toEqual([
      `sync/${a.deviceId}/gtd-1.bundle`,
    ]);
    expect(await tb.listPeers()).toEqual([]);
    expect(await ta.ownGeneration("gtd")).toBeNull();

    expect(await ta.publish("gtd", changeSet, meta())).toEqual({ generation: 1 });
    const [peer] = await tb.listPeers();
    expect(peer).toMatchObject({
      deviceId: a.deviceId,
      deviceName: "Test",
      profile: "personal",
      schemaVersion: changeSet.schemaVersion,
      hlcHigh: changeSet.hlcHigh,
      formatVersion: 1,
      domains: { gtd: { generation: 1, file: "gtd-1.bundle" } },
    });
    expect(await ta.ownGeneration("gtd")).toBe(1);
  });

  it("excludes the caller and ignores conflict copies and strays", async () => {
    const { ta, tb, folders, a, changeSet } = await setup();
    await ta.publish("gtd", changeSet, meta());
    await tb.publish("gtd", changeSet, meta());
    folders.plantConflictCopy("gtd", a.deviceId);
    expect((await ta.listPeers()).map((peer) => peer.deviceId)).toEqual([harnessDeviceId(1)]);
    expect((await tb.listPeers()).map((peer) => peer.deviceId)).toEqual([a.deviceId]);
    expect((await tb.listPeers())[0]?.schemaVersion).not.toBe(9999);
  });

  it("verifies bytes and hash: partial and unverified downloads are 'not yet'", async () => {
    const { ta, tb, folders, a, changeSet } = await setup();
    await ta.publish("gtd", changeSet, meta());
    const [peer] = await tb.listPeers();
    if (!peer) throw new Error("no peer");
    expect(await tb.readBundle(peer, "gtd")).toEqual({ changeSet });
    const original = folders.bundleText("gtd", a.deviceId, "gtd");
    for (const kind of ["partial", "unverified"] as const) {
      folders.damageBundle("gtd", a.deviceId, "gtd", kind);
      expect(await tb.readBundle(peer, "gtd")).toEqual({ notReady: true });
      folders.restoreBundle("gtd", a.deviceId, "gtd", original);
    }
    expect(await tb.readBundle(peer, "gtd")).toEqual({ changeSet });

    // Verified bytes that do not parse are delivered as text for the engine to reject.
    folders.damageBundle("gtd", a.deviceId, "gtd", "not-json");
    const [damaged] = await tb.listPeers();
    expect(await tb.readBundle(damaged as never, "gtd")).toEqual({
      changeSet: "{this is not json",
    });
    // A bundle that is missing is not ready either.
    expect(await tb.readBundle({ ...peer, domains: {} }, "gtd")).toEqual({ notReady: true });
  });

  it("keeps the previous generation and deletes older ones", async () => {
    const { ta, folders, a, changeSet } = await setup();
    for (let n = 0; n < 4; n += 1) await ta.publish("gtd", changeSet, meta());
    expect(
      folders
        .filesOf("gtd")
        .map((file) => file.path)
        .sort(),
    ).toEqual([
      `sync/${a.deviceId}/gtd-3.bundle`,
      `sync/${a.deviceId}/gtd-4.bundle`,
      `sync/${a.deviceId}/manifest.json`,
    ]);
    expect(await ta.ownGeneration("gtd")).toBe(4);
  });

  it("a device sees only the folders it is attached to", async () => {
    const { a, b, changeSet, folders } = await setup();
    const personalA = folders.attach(a.deviceId, "personal");
    const gtdB = folders.attach(b.deviceId, "gtd");
    const gtdA = folders.attach(a.deviceId, "gtd");
    await personalA.publish("personal", { ...changeSet, domain: "personal" }, meta());
    await gtdA.publish("gtd", changeSet, meta());

    expect(folders.rolesOf(b.deviceId)).toEqual(["gtd"]);
    expect(folders.visibleFiles(b.deviceId).every((file) => file.role === "gtd")).toBe(true);
    expect(folders.visibleFiles(a.deviceId).map((file) => file.role)).toContain("personal");
    expect(await gtdB.listPeers()).toHaveLength(1);
    // The gtd folder's manifest lists the gtd domain only.
    expect(Object.keys(folders.manifestFor("gtd", a.deviceId)?.domains ?? {})).toEqual(["gtd"]);
  });

  it("injects unreachable, timeout and hanging folders, and counts calls", async () => {
    const { ta, tb, folders, a, b, changeSet } = await setup();
    await ta.publish("gtd", changeSet, meta());
    folders.setMode("gtd", "unreachable");
    await expect(tb.listPeers()).rejects.toMatchObject({ code: "unreachable" });
    folders.setMode("gtd", "timeout");
    await expect(tb.listPeers()).rejects.toMatchObject({ code: "timeout" });
    folders.setMode("gtd", "hang");
    const outcome = await Promise.race([
      tb.listPeers().then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20)),
    ]);
    expect(outcome).toBe("still waiting");
    folders.setMode("gtd", "up");
    expect(await tb.listPeers()).toHaveLength(1);
    expect(folders.calls(b.deviceId, "gtd").listPeers).toBe(4);
    expect(folders.calls(a.deviceId, "gtd")).toMatchObject({ publish: 1, listPeers: 0 });
    folders.resetCalls();
    expect(folders.calls(b.deviceId, "gtd").listPeers).toBe(0);
  });

  it("runs operation hooks and refuses to publish a domain the folder does not carry", async () => {
    const { ta, folders, changeSet } = await setup();
    const seen: string[] = [];
    folders.onOperation("gtd", "publish", ({ deviceId }) => {
      seen.push(deviceId);
    });
    await ta.publish("gtd", changeSet, meta());
    expect(seen).toHaveLength(1);
    await expect(
      ta.publish("personal", { ...changeSet, domain: "personal" }, meta()),
    ).rejects.toThrow(/does not carry/);
  });
});
