// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { confirmJoin, inspectJoin, joinCompleted } from "./join-service";
import { pullReport } from "../../test/sync-fixtures";
import { createFakeFolderHost } from "./test-support/fake-folder-host";
import {
  enableFakeLaptop,
  GTD_FOLDER,
  openFakeLaptop,
  PERSONAL_FOLDER,
  publishFromFakeLaptop,
} from "./test-support/fake-laptop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "resolve_storage_paths")
      return { databasePath: "/x", connectionString: "sqlite:x", environment: "production" };
    if (command === "ensure_backup_dir") return "/backup/backups";
    if (command === "prune_backups") return { deletedPaths: [], failed: [], keptCount: 1 };
    throw new Error(command);
  });
});
const setup = async () => {
  const host = createFakeFolderHost();
  host.mount(PERSONAL_FOLDER);
  host.mount(GTD_FOLDER);
  const peer = await openFakeLaptop(host, 0);
  const joiner = await openFakeLaptop(host, 1);
  await peer.repository.createTask({ id: "remote", title: "Remote", bucket: "inbox" });
  await enableFakeLaptop(peer);
  await publishFromFakeLaptop(peer);
  let settings = await joiner.settings();
  const getSettings = () => settings;
  const updateSettings = async (
    updater: typeof joiner.repository.updateSettings extends (u: infer U) => unknown ? U : never,
  ) => {
    settings = await joiner.repository.updateSettings(updater);
    return settings;
  };
  return { host, peer, joiner, getSettings, updateSettings };
};
describe("guided join", () => {
  it("joins a fresh work database without a backup and imports only GTD", async () => {
    const x = await setup();
    const deps = { ...x.joiner.deps, workProfileSelectable: true };
    const settings = { ...x.getSettings(), backupDestinationDir: "" };
    const preview = await inspectJoin({
      repository: x.joiner.repository,
      settings,
      profile: "work",
      deps,
    });
    expect(preview.refused).toBe(false);
    expect(preview.requiresBackup).toBe(false);
    const report = await confirmJoin({
      repository: x.joiner.repository,
      settings,
      profile: "work",
      peerId: preview.peers[0]!.id,
      deps,
      getSettings: x.getSettings,
      updateSettings: x.updateSettings,
    });
    expect(report.safetyBackup.status).toBe("skipped_empty_joiner");
    expect(report.totals.bundlesApplied).toBeGreaterThan(0);
    expect(x.joiner.backups()).toBe(0);
    expect(
      (await x.joiner.repository.listTasks({ includeCompleted: true })).map((task) => task.id),
    ).toContain("remote");
    expect(x.getSettings().multiDeviceSyncEnabled).toBe(true);
  });
  it("backs up a nonempty join before merging", async () => {
    const x = await setup();
    await x.joiner.repository.createTask({ id: "local", title: "Local", bucket: "inbox" });
    const settings = x.getSettings();
    const preview = await inspectJoin({
      repository: x.joiner.repository,
      settings,
      profile: "personal",
      deps: x.joiner.deps,
    });
    expect(preview.requiresBackup).toBe(true);
    const report = await confirmJoin({
      repository: x.joiner.repository,
      settings,
      profile: "personal",
      peerId: preview.peers[0]!.id,
      deps: x.joiner.deps,
      getSettings: x.getSettings,
      updateSettings: x.updateSettings,
    });
    expect(x.joiner.backups()).toBe(1);
    expect(report.totals.bundlesApplied).toBeGreaterThan(0);
  });
  it("refuses work when personal data exists without changing settings", async () => {
    const x = await setup();
    const entry = createEmptyDailyEntry("2026-10-03");
    entry.morningIntention = "private";
    await x.joiner.repository.saveDailyEntry(entry);
    const deps = { ...x.joiner.deps, workProfileSelectable: true };
    const preview = await inspectJoin({
      repository: x.joiner.repository,
      settings: x.getSettings(),
      profile: "work",
      deps,
    });
    expect(preview.refused).toBe(true);
    expect(preview.local.personal).toBeGreaterThan(0);
    await expect(
      confirmJoin({
        repository: x.joiner.repository,
        settings: x.getSettings(),
        profile: "work",
        peerId: "missing",
        deps,
        getSettings: x.getSettings,
        updateSettings: x.updateSettings,
      }),
    ).rejects.toMatchObject({ code: "work_profile_data_present" });
    expect(x.getSettings().syncProfile).toBe("personal");
  });

  it("does not persist a failed folder choice or enable sync", async () => {
    const x = await setup();
    const before = x.getSettings();
    const settings = { ...before, syncGtdFolderDir: "/missing" };
    await expect(
      confirmJoin({
        repository: x.joiner.repository,
        settings,
        profile: "personal",
        peerId: "missing",
        deps: x.joiner.deps,
        getSettings: x.getSettings,
        updateSettings: x.updateSettings,
      }),
    ).rejects.toMatchObject({ code: "folder_unavailable" });
    expect(x.getSettings()).toEqual(before);
  });

  it("does not activate when a selected peer is stale or uses a newer schema", () => {
    for (const status of ["stale", "update_required"] as const) {
      expect(
        joinCompleted(
          pullReport({
            peers: [{ peerId: "x", peerName: "x", transport: "gtd", status, domains: [] }],
          }),
          "personal",
          "x",
        ),
      ).toBe(false);
    }
  });

  it.each(["missing personal manifest", "missing finance entry"] as const)(
    "keeps %s pending without activating",
    async (missing) => {
      const x = await setup();
      const list = x.joiner.deps.api.listSyncPeers;
      const deps = {
        ...x.joiner.deps,
        api: {
          ...x.joiner.deps.api,
          listSyncPeers: async (target: Parameters<typeof list>[0]) => {
            const result = await list(target);
            if (target.role !== "personal") return result;
            if (missing === "missing personal manifest") return { ...result, peers: [] };
            return {
              ...result,
              peers: result.peers.map((peer) => {
                const domains = { ...(peer.domains as Record<string, unknown>) };
                delete domains.finance;
                return { ...peer, domains };
              }),
            };
          },
        },
      };
      const settings = x.getSettings();
      const preview = await inspectJoin({
        repository: x.joiner.repository,
        settings,
        profile: "personal",
        deps,
      });
      expect(preview.peers[0]?.counts.finance).toBeNull();
      await expect(
        confirmJoin({
          repository: x.joiner.repository,
          settings,
          profile: "personal",
          peerId: preview.peers[0]!.id,
          deps,
          getSettings: x.getSettings,
          updateSettings: x.updateSettings,
        }),
      ).rejects.toMatchObject({ code: "peer_incomplete" });
      expect(x.getSettings().multiDeviceSyncEnabled).toBe(false);
      expect(x.joiner.backups()).toBe(0);
    },
  );

  it("does not activate when a required domain disappears during pull", () => {
    const report = pullReport({
      peers: [
        {
          peerId: "x",
          peerName: "x",
          transport: "gtd",
          status: "ok",
          domains: [{ domain: "gtd", outcome: "applied" }],
        },
      ],
    });
    expect(joinCompleted(report, "personal", "x")).toBe(false);
    expect(joinCompleted(report, "work", "x")).toBe(true);
  });
});
