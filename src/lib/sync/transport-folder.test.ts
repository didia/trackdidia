// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../domain/types";
import * as bundle from "./bundle";
import { SYNC_FORMAT_VERSION, type SyncChangeSet } from "./change-set";
import { SyncFolderError, type SyncFolderErrorCode } from "./folder-api";
import { encodeHlc } from "./hlc";
import { createSyncEngine } from "./sync-engine";
import { createFakeFolderHost, type FakeFolderHost } from "./test-support/fake-folder-host";
import { createSyncHarness } from "./test-support/two-device-harness";
import {
  createFolderTransport,
  type FolderApi,
  type FolderTransport,
  mapFolderError,
} from "./transport-folder";
import {
  type PeerManifest,
  type PublishMeta,
  SyncTransportError,
  SyncTransportFailure,
} from "./transport";

vi.mock("./bundle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundle")>();
  return { ...actual, encodeBundle: vi.fn(actual.encodeBundle) };
});

const A = "dev:00000000-0000-4000-8000-000000000001";
const B = "dev:00000000-0000-4000-8000-000000000002";
const GTD_DIR = "/Drive/Shared/GTD";
const PERSONAL_DIR = "/Drive/Perso";
const hlc = (ms: number) => encodeHlc(ms, 0, A);

const changeSet = (
  domain: "gtd" | "personal" | "finance" = "gtd",
  overrides: Partial<SyncChangeSet> = {},
): SyncChangeSet => ({
  formatVersion: SYNC_FORMAT_VERSION,
  deviceId: A,
  domain,
  schemaVersion: 43,
  hlcHigh: hlc(2000),
  entities: [],
  unionRows: {},
  settings: [],
  recurrence: { occurrences: [], clears: [] },
  aliases: [],
  ...overrides,
});

const meta = (overrides: Partial<PublishMeta> = {}): PublishMeta => ({
  deviceName: "Portable perso",
  appVersion: "0.2.0",
  profile: "personal",
  calendarSyncEnabled: false,
  writtenAtMs: Date.UTC(2026, 9, 14, 13, 2, 11, 482),
  ...overrides,
});

const setup = (deviceId = A) => {
  const host = createFakeFolderHost();
  host.mount(GTD_DIR);
  host.mount(PERSONAL_DIR);
  const make = (role: "gtd" | "personal", api: FolderApi = host.api, id = deviceId) =>
    createFolderTransport({
      role,
      folderDir: role === "gtd" ? GTD_DIR : PERSONAL_DIR,
      environment: "production",
      deviceId: id,
      api,
    });
  return { host, make };
};

const prepare = async (host: FakeFolderHost) => {
  await host.api.prepareSyncFolder(
    { folderDir: GTD_DIR, role: "gtd", environment: "production" },
    PERSONAL_DIR,
  );
  await host.api.prepareSyncFolder(
    { folderDir: PERSONAL_DIR, role: "personal", environment: "production" },
    GTD_DIR,
  );
};

const manifestOf = (host: FakeFolderHost, dir: string, deviceId: string) =>
  JSON.parse(String(host.read(dir, `sync/dev-${deviceId.slice(4)}/manifest.json`))) as Record<
    string,
    unknown
  >;

afterEach(() => {
  vi.mocked(bundle.encodeBundle).mockClear();
});

describe("role to domain routing", () => {
  it("declares the domains of each folder role", () => {
    const { make } = setup();
    expect(make("gtd").domains).toEqual(["gtd"]);
    expect(make("personal").domains).toEqual(["personal", "finance"]);
    expect(make("gtd").id).toBe("folder:gtd");
    expect(make("personal").id).toBe("folder:personal");
  });

  it("never encodes or sends a domain its folder does not carry", async () => {
    const { host, make } = setup();
    await prepare(host);
    host.calls.length = 0;
    const gtd = make("gtd");
    const personal = make("personal");

    for (const domain of ["personal", "finance"] as const) {
      await expect(gtd.publish(domain, changeSet(domain), meta())).rejects.toMatchObject({
        name: "SyncTransportFailure",
        kind: "internal",
        reason: "domain_not_allowed",
      });
      await expect(gtd.ownGeneration(domain)).rejects.toBeInstanceOf(SyncTransportFailure);
    }
    await expect(personal.publish("gtd", changeSet("gtd"), meta())).rejects.toBeInstanceOf(
      SyncTransportFailure,
    );
    // The domain argument and the change set must agree, too.
    await expect(gtd.publish("gtd", changeSet("personal"), meta())).rejects.toBeInstanceOf(
      SyncTransportFailure,
    );
    await expect(
      gtd.readBundle(
        { deviceId: B, deviceName: "B", domains: {} } as unknown as PeerManifest,
        "finance",
      ),
    ).rejects.toBeInstanceOf(SyncTransportFailure);

    expect(host.calls).toEqual([]);
    expect(bundle.encodeBundle).not.toHaveBeenCalled();
  });

  it("sends its own role, folder and environment with every command", async () => {
    const { host, make } = setup();
    await prepare(host);
    host.calls.length = 0;
    const personal = make("personal");
    await personal.publish("finance", changeSet("finance"), meta());
    await personal.listPeers();
    await personal.ownGeneration("personal");
    expect(host.calls.map(({ command, folderDir, role }) => [command, folderDir, role])).toEqual([
      ["publish", PERSONAL_DIR, "personal"],
      ["list", PERSONAL_DIR, "personal"],
      ["list", PERSONAL_DIR, "personal"],
    ]);
  });
});

describe("publish", () => {
  it("writes the bundle with the manifest fields the engine and the page need", async () => {
    const { host, make } = setup();
    await prepare(host);
    const personal = make("personal");
    await expect(personal.publish("finance", changeSet("finance"), meta())).resolves.toEqual({
      generation: 1,
    });
    await expect(
      personal.publish("personal", changeSet("personal", { hlcHigh: hlc(1500) }), meta()),
    ).resolves.toEqual({ generation: 1 });
    await expect(personal.publish("finance", changeSet("finance"), meta())).resolves.toEqual({
      generation: 2,
    });
    const manifest = manifestOf(host, PERSONAL_DIR, A);
    expect(manifest).toMatchObject({
      formatVersion: 1,
      deviceId: A,
      deviceName: "Portable perso",
      appVersion: "0.2.0",
      schemaVersion: 43,
      writtenAt: "2026-10-14T13:02:11.482Z",
      // The manifest claims the highest clock published to this folder, not the last domain's.
      hlcHigh: hlc(2000),
      profile: "personal",
      calendarSyncEnabled: false,
    });
    expect(Object.keys(manifest.domains as object).sort()).toEqual(["finance", "personal"]);
    expect(manifest.domains).toMatchObject({
      finance: { generation: 2, file: "finance-2.bundle" },
      personal: { generation: 1, file: "personal-1.bundle" },
    });
    expect(await personal.ownGeneration("finance")).toBe(2);
    expect(await personal.ownGeneration("personal")).toBe(1);
    expect(await make("gtd").ownGeneration("gtd")).toBeNull();
  });

  it("counts every record of the bundle as the manifest's rows", async () => {
    const { host, make } = setup();
    await prepare(host);
    const set = changeSet("gtd", {
      settings: [{ key: "language", value: "fr", rowHlc: hlc(1000) }],
      aliases: [
        { entity_type: "gtd_tasks", alias_id: "b", canonical_id: "a", recorded_hlc: hlc(1000) },
      ],
    });
    await make("gtd").publish("gtd", set, meta());
    const manifest = manifestOf(host, GTD_DIR, A);
    expect((manifest.domains as Record<string, { rows: number }>).gtd?.rows).toBe(2);
  });

  it("serializes the publishes of one device", async () => {
    const { host, make } = setup();
    await prepare(host);
    let active = 0;
    let overlapped = false;
    const slow: FolderApi = {
      ...host.api,
      publishSyncBundle: async (input) => {
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        try {
          return await host.api.publishSyncBundle(input);
        } finally {
          active -= 1;
        }
      },
    };
    const gtd = make("gtd", slow);
    const results = await Promise.all([
      gtd.publish("gtd", changeSet(), meta()),
      gtd.publish("gtd", changeSet(), meta()),
      gtd.publish("gtd", changeSet(), meta()),
    ]);
    expect(results.map((result) => result.generation)).toEqual([1, 2, 3]);
    expect(overlapped).toBe(false);
  });

  it("a failed publish does not stop the next one", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    host.failNext("publish", "io");
    await expect(gtd.publish("gtd", changeSet(), meta())).rejects.toBeInstanceOf(
      SyncTransportError,
    );
    await expect(gtd.publish("gtd", changeSet(), meta())).resolves.toEqual({ generation: 1 });
  });
});

describe("a publish that times out", () => {
  it("is reported as success when the host had committed it (no second generation)", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    host.timeoutNextPublish("after");
    host.calls.length = 0;
    await expect(gtd.publish("gtd", changeSet(), meta())).resolves.toEqual({ generation: 1 });
    expect(host.calls.map((call) => call.command)).toEqual(["publish", "list"]);
    expect(await gtd.ownGeneration("gtd")).toBe(1);
  });

  it("is a retryable timeout when nothing was committed", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    host.timeoutNextPublish("before");
    const error = await gtd.publish("gtd", changeSet(), meta()).catch((caught) => caught);
    expect(error).toBeInstanceOf(SyncTransportError);
    expect((error as SyncTransportError).code).toBe("timeout");
    expect(await gtd.ownGeneration("gtd")).toBeNull();
  });

  it("is a timeout when the committed bundle is an older publish of other data", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    await gtd.publish("gtd", changeSet("gtd", { hlcHigh: hlc(1000) }), meta());
    host.timeoutNextPublish("before");
    await expect(
      gtd.publish("gtd", changeSet("gtd", { hlcHigh: hlc(3000) }), meta()),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("is a timeout when the check itself cannot reach the folder", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    host.timeoutNextPublish("after");
    host.failNext("list", "folder_not_found");
    await expect(gtd.publish("gtd", changeSet(), meta())).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

describe("sizes", () => {
  it("refuses to send a bundle over the host cap, as a persistent failure", async () => {
    const { host, make } = setup();
    await prepare(host);
    vi.mocked(bundle.encodeBundle).mockResolvedValueOnce({
      bytes: new Uint8Array(64 * 1024 * 1024 + 1),
      compression: "gzip",
      records: 1,
      uncompressedBytes: 1,
    });
    host.calls.length = 0;
    const error = await make("gtd")
      .publish("gtd", changeSet(), meta())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SyncTransportFailure);
    expect(error.kind).toBe("too_large");
    expect(host.calls).toEqual([]);
  });

  it("a single record over the line cap is a persistent too_large failure, with no IPC", async () => {
    const { host, make } = setup();
    await prepare(host);
    host.calls.length = 0;
    const entity = {
      table: "gtd_contexts",
      entityId: "context:big",
      row: { id: "context:big", name: "x".repeat(16 * 1024 * 1024) },
      fieldClocks: {},
      rowHlc: hlc(1000),
      deletedAt: null,
    };
    const error = await make("gtd")
      .publish("gtd", changeSet("gtd", { entities: [entity] }), meta())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SyncTransportFailure);
    expect(error.kind).toBe("too_large");
    expect(error.reason).toBe("line_too_long");
    expect(host.calls).toEqual([]);
  });

  it("maps the host's own too_large to the same persistent failure", async () => {
    const { host, make } = setup();
    await prepare(host);
    host.failNext("publish", "too_large");
    await expect(make("gtd").publish("gtd", changeSet(), meta())).rejects.toMatchObject({
      kind: "too_large",
    });
  });
});

describe("listing peers", () => {
  it("returns the other devices' manifests defensively and reports what it ignored", async () => {
    const { host, make } = setup();
    await prepare(host);
    await make("gtd", host.api, B).publish("gtd", changeSet("gtd", { deviceId: B }), meta());
    host.write(GTD_DIR, `sync/dev-${B.slice(4)}/manifest (1).json`, "{}");
    host.write(GTD_DIR, "sync/stray.txt", "x");
    const mine = make("gtd");
    const peers = await mine.listPeers();
    expect(peers.map((peer) => peer.deviceId)).toEqual([B]);
    expect(
      mine
        .lastListing()
        ?.ignored.map((entry) => entry.reason)
        .sort(),
    ).toEqual(["conflict_copy", "not_a_directory"]);
  });

  it("drops anything that is not an object and survives a host that returns garbage", async () => {
    const { host, make } = setup();
    const garbage: FolderApi = {
      ...host.api,
      listSyncPeers: async () =>
        ({ peers: [null, 7, "x", [], { deviceId: B }], own: "nope", ignored: "nope" }) as never,
    };
    const transport = make("gtd", garbage);
    expect(await transport.listPeers()).toEqual([{ deviceId: B }]);
    expect(transport.lastListing()?.ignored).toEqual([]);
    expect(await transport.ownGeneration("gtd")).toBeNull();
  });
});

describe("reading a bundle", () => {
  const publishedByB = async (domain: "gtd" | "finance" = "gtd") => {
    const { host, make } = setup(A);
    await prepare(host);
    const theirs = make(domain === "gtd" ? "gtd" : "personal", host.api, B);
    await theirs.publish(domain, changeSet(domain, { deviceId: B }), meta({ deviceName: "B" }));
    const mine = make(domain === "gtd" ? "gtd" : "personal");
    const [peer] = await mine.listPeers();
    return { host, mine, peer: peer as PeerManifest };
  };

  it("decodes the verified bytes into the change set", async () => {
    const { mine, peer } = await publishedByB();
    const read = await mine.readBundle(peer, "gtd");
    expect(read).toEqual({ changeSet: expect.objectContaining({ domain: "gtd", deviceId: B }) });
  });

  it("is not ready when the host says so, or when the manifest moved since the listing", async () => {
    const { host, mine, peer } = await publishedByB();
    const entry = (peer.domains as Record<string, { file: string }>).gtd as { file: string };
    host.write(GTD_DIR, `sync/dev-${B.slice(4)}/${entry.file}`, new Uint8Array([1, 2, 3]));
    expect(await mine.readBundle(peer, "gtd")).toEqual({ notReady: true });

    const fresh = await publishedByB();
    const moved = {
      ...fresh.peer,
      domains: { gtd: { ...(fresh.peer.domains.gtd as object), sha256: "0".repeat(64) } },
    } as unknown as PeerManifest;
    expect(await fresh.mine.readBundle(moved, "gtd")).toEqual({ notReady: true });
  });

  it("hands verified bytes that are not a bundle to the engine as text it will refuse", async () => {
    const { host, mine, peer } = await publishedByB();
    const entry = (peer.domains as Record<string, { file: string }>).gtd as { file: string };
    const garbage = new TextEncoder().encode("this is not a bundle\n");
    host.write(GTD_DIR, `sync/dev-${B.slice(4)}/${entry.file}`, garbage);
    const { createHash } = await import("node:crypto");
    const manifestPath = `sync/dev-${B.slice(4)}/manifest.json`;
    const manifest = JSON.parse(String(host.read(GTD_DIR, manifestPath)));
    manifest.domains.gtd.sha256 = createHash("sha256").update(garbage).digest("hex");
    manifest.domains.gtd.bytes = garbage.length;
    host.write(GTD_DIR, manifestPath, JSON.stringify(manifest));
    const [fresh] = await mine.listPeers();
    const read = await mine.readBundle(fresh as PeerManifest, "gtd");
    expect(read).toEqual({
      changeSet: expect.stringContaining("undecodable bundle (bad_preamble)"),
    });
  });

  it("never logs bundle contents when it cannot decode one", async () => {
    const { host, mine, peer } = await publishedByB();
    const entry = (peer.domains as Record<string, { file: string }>).gtd as { file: string };
    const secret = new TextEncoder().encode("SECRET-TASK-TITLE-DO-NOT-LOG\n");
    host.write(GTD_DIR, `sync/dev-${B.slice(4)}/${entry.file}`, secret);
    const { createHash } = await import("node:crypto");
    const manifestPath = `sync/dev-${B.slice(4)}/manifest.json`;
    const manifest = JSON.parse(String(host.read(GTD_DIR, manifestPath)));
    manifest.domains.gtd.sha256 = createHash("sha256").update(secret).digest("hex");
    manifest.domains.gtd.bytes = secret.length;
    host.write(GTD_DIR, manifestPath, JSON.stringify(manifest));
    const [fresh] = await mine.listPeers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await mine.readBundle(fresh as PeerManifest, "gtd");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-TASK-TITLE");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a gzip bundle this runtime cannot read is an unsupported failure, not a corrupt peer", async () => {
    const { mine, peer } = await publishedByB();
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      await expect(mine.readBundle(peer, "gtd")).rejects.toMatchObject({
        name: "SyncTransportFailure",
        kind: "unsupported",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("error mapping", () => {
  const folderError = (code: SyncFolderErrorCode) => new SyncFolderError(code, `${code} happened`);

  it("maps an absent or unprepared folder and io to a retryable unreachable", () => {
    for (const code of ["folder_not_found", "folder_not_prepared", "io"] as const) {
      const mapped = mapFolderError(folderError(code), "Listing");
      expect(mapped).toBeInstanceOf(SyncTransportError);
      expect((mapped as SyncTransportError).code).toBe("unreachable");
      // The host's reason travels, so the page can tell "never prepared" from "not mounted".
      expect((mapped as SyncTransportError).reason).toBe(code);
    }
  });

  it("maps a host timeout to timeout", () => {
    const mapped = mapFolderError(folderError("timeout"), "Reading");
    expect(mapped).toBeInstanceOf(SyncTransportError);
    expect((mapped as SyncTransportError).code).toBe("timeout");
  });

  it("maps a wrongly configured folder to a configuration failure that names the fix", () => {
    for (const code of ["role_mismatch", "nested_folder"] as const) {
      const mapped = mapFolderError(folderError(code), "Listing");
      expect(mapped).toBeInstanceOf(SyncTransportFailure);
      expect((mapped as SyncTransportFailure).kind).toBe("configuration");
      expect((mapped as SyncTransportFailure).reason).toBe(code);
      expect(mapped.message).toContain("Choose another folder");
    }
  });

  it("maps too_large to a persistent failure", () => {
    expect((mapFolderError(folderError("too_large"), "x") as SyncTransportFailure).kind).toBe(
      "too_large",
    );
  });

  it("treats a host contract violation or an unknown error as an internal failure, not a retry", () => {
    for (const code of [
      "domain_not_allowed",
      "device_id_invalid",
      "invalid_argument",
      "unknown",
    ] as const) {
      const mapped = mapFolderError(folderError(code), "x");
      expect(mapped).toBeInstanceOf(SyncTransportFailure);
      expect((mapped as SyncTransportFailure).kind).toBe("internal");
    }
    expect((mapFolderError(new Error("boom"), "x") as SyncTransportFailure).kind).toBe("internal");
    expect((mapFolderError("boom", "x") as SyncTransportFailure).kind).toBe("internal");
  });

  it("leaves transport errors as they are", () => {
    const timeout = new SyncTransportError("timeout", "t");
    expect(mapFolderError(timeout, "x")).toBe(timeout);
  });

  it("surfaces every mapped error through the real methods", async () => {
    const { host, make } = setup();
    await prepare(host);
    const gtd = make("gtd");
    host.failNext("list", "role_mismatch");
    await expect(gtd.listPeers()).rejects.toMatchObject({ kind: "configuration" });
    host.failNext("read", "folder_not_found");
    await expect(
      gtd.readBundle(
        { deviceId: B, deviceName: "B", domains: {} } as unknown as PeerManifest,
        "gtd",
      ),
    ).rejects.toMatchObject({ code: "unreachable" });
    host.unmount(GTD_DIR);
    await expect(gtd.listPeers()).rejects.toMatchObject({ code: "unreachable" });
    await expect(gtd.publish("gtd", changeSet(), meta())).rejects.toMatchObject({
      code: "unreachable",
    });
  });
});

describe("the engine over the folder transport", () => {
  const makeDevices = async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const host = createFakeFolderHost();
    host.mount(GTD_DIR);
    host.mount(PERSONAL_DIR);
    await prepare(host);
    const engines = sim.devices.map((device) => {
      const transports: FolderTransport[] = (["gtd", "personal"] as const).map((role) =>
        createFolderTransport({
          role,
          folderDir: role === "gtd" ? GTD_DIR : PERSONAL_DIR,
          environment: "production",
          deviceId: device.deviceId,
          api: host.api,
        }),
      );
      const engine = createSyncEngine({
        repo: device.repo,
        transports,
        profile: "personal",
        now: device.clock.read,
        beforeFirstMerge: async () => ({ path: "memory://backup" }),
      });
      return { device, engine, transports };
    });
    return { sim, host, engines };
  };

  const settle = async (engines: Awaited<ReturnType<typeof makeDevices>>["engines"]) => {
    for (let round = 0; round < 3; round += 1) {
      for (const { engine, device } of engines) {
        device.clock.advance(1000);
        await engine.syncNow();
      }
    }
  };

  const task = (id: string, title: string): Partial<Task> & { id: string; title: string } => ({
    id,
    title,
    bucket: "inbox",
  });

  it("converges two laptops through real bundles, each domain in its own folder", async () => {
    const { sim, host, engines } = await makeDevices();
    const [a, b] = engines as [(typeof engines)[number], (typeof engines)[number]];
    await a.device.repo.createTask(task("t1", "Tâche écrite sur A — éàü"));
    await b.device.repo.createTask(task("t2", "From B"));
    await a.device.repo.updateSettings((current) => ({ ...current, aiModel: "vendor/model-a" }));
    await settle(engines);

    for (const device of [a.device, b.device]) {
      const ids = (await device.repo.listTasks({ includeCompleted: true })).map((t) => t.id).sort();
      expect(ids).toEqual(["t1", "t2"]);
      expect((await device.repo.getSettings()).aiModel).toBe("vendor/model-a");
    }
    await sim.expectConverged("gtd");
    await sim.expectConverged("personal");

    // The physical layout: gtd only in the shared folder, personal/finance only in the personal one.
    const names = (dir: string) => host.filesOf(dir).filter((path) => path.endsWith(".bundle"));
    expect(names(GTD_DIR).every((path) => path.includes("/gtd-"))).toBe(true);
    expect(names(GTD_DIR).length).toBeGreaterThanOrEqual(2);
    expect(names(PERSONAL_DIR).some((path) => path.includes("/personal-"))).toBe(true);
    expect(names(PERSONAL_DIR).some((path) => path.includes("/finance-"))).toBe(true);
    expect(names(PERSONAL_DIR).some((path) => path.includes("/gtd-"))).toBe(false);
    for (const file of host.filesOf(GTD_DIR)) {
      expect(file.includes("personal") || file.includes("finance")).toBe(false);
    }
  });

  it("a corrupt but verified bundle is rejected as that peer's, and the other folder still syncs", async () => {
    const { host, engines } = await makeDevices();
    const [a, b] = engines as [(typeof engines)[number], (typeof engines)[number]];
    await a.device.repo.createTask(task("t1", "From A"));
    await a.engine.syncNow();
    const dir = `sync/dev-${a.device.deviceId.slice(4)}`;
    const manifestPath = `${dir}/manifest.json`;
    const manifest = JSON.parse(String(host.read(GTD_DIR, manifestPath)));
    const { createHash } = await import("node:crypto");
    const garbage = new TextEncoder().encode("garbage that verifies");
    host.write(GTD_DIR, `${dir}/${manifest.domains.gtd.file}`, garbage);
    manifest.domains.gtd.sha256 = createHash("sha256").update(garbage).digest("hex");
    manifest.domains.gtd.bytes = garbage.length;
    host.write(GTD_DIR, manifestPath, JSON.stringify(manifest));

    const report = await b.engine.pull();
    const issue = report.issues.find((item) => item.code === "bundle_invalid");
    expect(issue?.peerName).toBe("A");
    expect(issue?.peerId).toBe(a.device.deviceId);
    expect(await b.device.repo.listTasks({ includeCompleted: true })).toEqual([]);
  });

  it("surfaces a configuration error as an error issue, not a quiet warning", async () => {
    const { host, engines } = await makeDevices();
    const [a] = engines as [(typeof engines)[number]];
    host.failNext("list", "role_mismatch", "the folder is the personal folder");
    const report = await a.engine.pull();
    const issue = report.issues.find((item) => item.transport === "folder:gtd");
    expect(issue).toMatchObject({
      severity: "error",
      code: "transport_failed",
      detail: "configuration",
    });
    expect(issue?.message).toContain("Choose another folder");
    // The personal folder was still looked at.
    expect(report.transports.map((transport) => transport.id)).toEqual([
      "folder:gtd",
      "folder:personal",
    ]);
  });

  it("surfaces too_large as an error issue on publish and does not mark the data published", async () => {
    const { engines } = await makeDevices();
    const [a] = engines as [(typeof engines)[number]];
    await a.device.repo.createTask(task("t1", "x"));
    vi.mocked(bundle.encodeBundle).mockResolvedValueOnce({
      bytes: new Uint8Array(64 * 1024 * 1024 + 1),
      compression: "gzip",
      records: 1,
      uncompressedBytes: 1,
    });
    const report = await a.engine.publish();
    expect(report.counterAdvanced).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "publish_failed", detail: "too_large" }),
    );
    const status = await a.device.repo.getSyncStatus();
    expect(status.supported && status.pendingChanges).toBeGreaterThan(0);
  });
});
