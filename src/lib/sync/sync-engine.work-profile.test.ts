// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { bootstrapApplication } from "../../app/bootstrap";
import { STALE_PEER_MS } from "./engine-gates";
import { PROFILE_RECHECK_MS } from "./engine-profile";
import type { PullReport, SyncIssue } from "./engine-types";
import { createSyncEngine } from "./sync-engine";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
} from "./test-support/engine-harness";
import { financeAccount } from "./test-support/finance-fixtures";
import { annualGoal } from "./test-support/personal-fixtures";

// SAFETY: in-memory SQLite and in-memory folders only (see the engine harness).

/**
 * The work-profile guards seen from the engine, through the TEST SEAMS (`profile` of the engine and
 * the persisted setting, neither of which the release UI can choose): the startup re-check, the
 * three-layer isolation scenarios that exist at the data layer, and the schema and stale-peer gates
 * on the work path.
 */

const DAY = 24 * 60 * 60_000;

const world = (): Promise<EngineWorld> =>
  createEngineWorld([{ name: "A" }, { name: "W", profile: "work", roles: ["gtd"] }]);

const issuesOf = (report: { issues: SyncIssue[] }, code: SyncIssue["code"]): SyncIssue[] =>
  report.issues.filter((issue) => issue.code === code);

const applies = (device: EngineDevice) =>
  device.calls.filter((call) => call.method === "applySyncBundle");

const hasTask = async (device: EngineDevice, id: string): Promise<boolean> =>
  (await device.repo.listTasks({ includeCompleted: true })).some((task) => task.id === id);

const spyInspect = (device: EngineDevice) => vi.spyOn(device.repo, "inspectSyncProfileData");

describe("the work-profile startup re-check", () => {
  it("lets a clean work database sync, and looks once per engine, cheaply", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    const inspect = spyInspect(w);
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();

    const first = await w.engine.syncNow();
    expect(issuesOf(first.pull, "work_profile_data_present")).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(true);
    await w.engine.syncNow();
    await w.engine.pull();

    // One look (the cheap one) for three runs, and it only asked about the two foreign domains.
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({ domains: ["personal", "finance"], exact: false });

    // A healthy device is looked at again after the recheck interval, not before.
    w.clock.advance(PROFILE_RECHECK_MS - 1);
    await w.engine.pull();
    expect(inspect).toHaveBeenCalledTimes(1);
    w.clock.advance(1);
    await w.engine.pull();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("does not pause a fresh work database that went through a first start (seeds and markers)", async () => {
    const w3 = await world();
    const w = w3.device("W");
    await bootstrapApplication(w.repo);
    await w.stamp();
    const report = await w.engine.syncNow();
    expect(report.pull.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect((await w.engine.getStatus()).profileViolation).toBeNull();
  });

  it("PAUSES when personal rows exist: nothing is read from a folder, applied or published", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    // A hand-copied database: a daily entry and a finance account on the work laptop.
    await w.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await w.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));
    await w.repo.createTask({ id: "work-task", title: "Work", bucket: "inbox" });
    w.calls.length = 0;
    const gtdBefore = w3.folders.calls(w.deviceId, "gtd");

    const { pull, publish } = await w.engine.syncNow();

    const stop = issuesOf(pull, "work_profile_data_present");
    expect(stop).toHaveLength(1);
    expect(stop[0]).toMatchObject({ severity: "error" });
    expect(stop[0]?.detail).toMatch(/^personal=\d+,finance=\d+$/);
    expect(stop[0]?.message).toContain("Sync is paused");
    expect(pull.complete).toBe(false);
    expect(pull.transports).toEqual([]);
    expect(pull.peers).toEqual([]);
    expect(pull.totals.bundlesApplied).toBe(0);
    expect(issuesOf(publish, "work_profile_data_present")).toHaveLength(1);
    expect(publish.domains).toEqual([]);
    expect(publish.counterAdvanced).toBe(false);
    // The repository was never asked to read, apply or mark anything, and no folder was touched.
    expect(w.calls).toEqual([]);
    expect(w3.folders.calls(w.deviceId, "gtd")).toEqual(gtdBefore);
    expect(await hasTask(w, "from-a")).toBe(false);
    // And nothing of W's reached the folder either: A, pulling, sees no W bundle.
    await a.engine.pull();
    expect(await hasTask(a, "work-task")).toBe(false);
  });

  it("says so in the status, before any run, with the counts", async () => {
    const w3 = await world();
    const w = w3.device("W");
    await w.repo.saveAnnualGoal(annualGoal({ id: "goal-1" }));
    const status = await w.engine.getStatus();
    expect(status.profile).toBe("work");
    expect(status.profileViolation).toMatchObject({ exact: true });
    expect(status.profileViolation?.personal).toBeGreaterThan(0);
    expect(status.profileViolation?.finance).toBe(0);
    expect(status.issues.map((issue) => issue.code)).toEqual(["work_profile_data_present"]);
    // Asking twice does not repeat the issue once a run has reported it.
    await w.engine.pull();
    expect(
      (await w.engine.getStatus()).issues.filter(
        (issue) => issue.code === "work_profile_data_present",
      ),
    ).toHaveLength(1);
  });

  it("a seeded finance category that was modified pauses a work device; the pristine taxonomy does not", async () => {
    for (const rename of [false, true]) {
      const w3 = await world();
      const [a, w] = [w3.device("A"), w3.device("W")];
      await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
      await a.engine.publish();
      await w.repo.seedFinanceDefaultCategories();
      if (rename) {
        const pharmacy = (await w.repo.listFinanceCategories(true)).find(
          (category) => category.id === "fincat:sante.pharmacie",
        );
        await w.repo.saveFinanceCategory({
          ...(pharmacy as NonNullable<typeof pharmacy>),
          name: "Médicaments privés",
        });
      }
      await w.stamp();
      const report = await w.engine.pull();
      if (rename) {
        expect(issuesOf(report, "work_profile_data_present")).toHaveLength(1);
        expect(applies(w)).toEqual([]);
        expect(await hasTask(w, "from-a")).toBe(false);
        expect((await w.engine.getStatus()).profileViolation?.finance).toBeGreaterThan(0);
      } else {
        expect(issuesOf(report, "work_profile_data_present")).toEqual([]);
        expect(await hasTask(w, "from-a")).toBe(true);
      }
    }
  });

  it("finds personal data that only survives as a sidecar row, or as a changed personal setting", async () => {
    for (const plant of [
      (w: EngineDevice) =>
        w.db.execute(
          `INSERT INTO sync_entity_meta (entity_type, entity_id, field_clocks_json, row_hlc, deleted_at)
           VALUES ('weekly_reviews', '2026-10-04', '{}', '0000000000001-0000-x', '0000000000001-0000-x')`,
        ),
      (w: EngineDevice) =>
        w.db.execute(
          `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
           VALUES ('c1', 'ai_memories', 'm1', 'overwritten_edit', '{}', '{}', 'x')`,
        ),
      (w: EngineDevice) => w.repo.updateSettings((current) => ({ ...current, aiEnabled: true })),
    ]) {
      const w3 = await world();
      const w = w3.device("W");
      await plant(w);
      const report = await w.engine.pull();
      expect(issuesOf(report, "work_profile_data_present")).toHaveLength(1);
    }
  });

  it("keeps looking while it is paused, and resumes as soon as the database is clean", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    await w.repo.saveAnnualGoal(annualGoal({ id: "goal-1" }));
    expect(issuesOf(await w.engine.pull(), "work_profile_data_present")).toHaveLength(1);
    expect(issuesOf(await w.engine.pull(), "work_profile_data_present")).toHaveLength(1);
    expect(await hasTask(w, "from-a")).toBe(false);

    // The database is replaced by a clean one (here: the rows are removed by hand).
    await w.db.execute("DELETE FROM annual_goals");
    await w.db.execute("DELETE FROM sync_entity_meta WHERE entity_type = 'annual_goals'");
    await w.db.execute("DELETE FROM sync_entity_snapshot WHERE entity_type = 'annual_goals'");
    await w.db.execute("DELETE FROM sync_dirty WHERE entity_type = 'annual_goals'");
    const resumed = await w.engine.pull();
    expect(issuesOf(resumed, "work_profile_data_present")).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(true);
  });

  it("waits for the engine's write gate before it takes the writer (a startup pull past its wait)", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const kinds: string[] = [];
    const w3 = await createEngineWorld([
      {
        name: "W",
        profile: "work",
        roles: ["gtd"],
        engine: {
          beforeWrite: async (kind) => {
            kinds.push(kind);
            await gate;
          },
        },
      },
    ]);
    const w = w3.device("W");
    const inspect = spyInspect(w);
    const pulled = w.engine.pull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kinds).toEqual(["apply"]);
    expect(inspect).not.toHaveBeenCalled();
    open();
    await pulled;
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("never calls the inspection for a personal device, whatever it holds", async () => {
    const w3 = await world();
    const a = w3.device("A");
    const inspect = spyInspect(a);
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await a.engine.syncNow();
    await a.engine.getStatus();
    expect(inspect).not.toHaveBeenCalled();
    expect((await a.engine.getStatus()).profileViolation).toBeNull();
  });

  it("fails closed: a look that cannot be made pauses the run, and is retried by the next one", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    const inspect = spyInspect(w);
    inspect.mockRejectedValueOnce(new Error("database is locked"));
    const failed = await w.engine.pull();
    const issue = issuesOf(failed, "profile_check_failed");
    expect(issue).toHaveLength(1);
    expect(issue[0]).toMatchObject({ severity: "error", detail: "database is locked" });
    expect(applies(w)).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(false);
    // Not remembered as a clean look.
    const retried = await w.engine.pull();
    expect(issuesOf(retried, "profile_check_failed")).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(true);
  });

  it("fails closed when the repository cannot inspect at all", async () => {
    const w3 = await world();
    const w = w3.device("W");
    const bare = createSyncEngine({
      repo: {
        getSyncStatus: () => w.repo.getSyncStatus(),
      } as never,
      transports: w.transports,
      profile: "work",
      now: w.clock.read,
    });
    const report = await bare.pull();
    expect(issuesOf(report, "profile_check_failed")).toHaveLength(1);
    expect((await bare.publish()).domains).toEqual([]);
  });
});

describe("layer 3 behind the engine: the repository applies the persisted profile", () => {
  it("a personal-profile engine on a database persisted as work cannot apply a personal bundle", async () => {
    const w3 = await createEngineWorld([
      { name: "A" },
      { name: "P", profile: "personal", storedProfile: "work" },
    ]);
    const [a, p] = [w3.device("A"), w3.device("P")];
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();

    const report = await p.engine.pull();
    // The engine let both bundles through (its own profile is personal); the repository refused one.
    const rejected = issuesOf(report, "bundle_rejected");
    expect(rejected.map((issue) => [issue.domain, issue.detail])).toEqual([
      ["personal", "domain_not_allowed"],
      ["finance", "domain_not_allowed"],
    ]);
    expect(await p.repo.getDailyEntry("2026-10-01")).toBeNull();
    expect(await hasTask(p, "from-a")).toBe(true);
    expect((await p.repo.inspectSyncProfileData()).counts.personal).toBe(0);
  });
});

describe("a work device and a personal peer's folders", () => {
  it("never applies a personal or finance bundle planted in the shared GTD folder, and reports it", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    const personal = w3.folders.bundleText("personal", a.deviceId, "personal");
    const finance = w3.folders.bundleText("personal", a.deviceId, "finance");
    // Behind the manifest keys the work device may not read, and behind the `gtd` key itself.
    w3.folders.plantBundle("gtd", a.deviceId, "personal", personal);
    w3.folders.plantBundle("gtd", a.deviceId, "finance", finance);

    const refusedKeys = await w.engine.pull();
    expect(
      issuesOf(refusedKeys, "domain_not_allowed")
        .map((issue) => issue.domain)
        .sort(),
    ).toEqual(["finance", "personal"]);
    expect(await hasTask(w, "from-a")).toBe(true);

    w3.folders.plantBundle("gtd", a.deviceId, "gtd", personal);
    const wrongContent = await w.engine.pull();
    expect(issuesOf(wrongContent, "wrong_domain_bundle")).toHaveLength(1);
    w3.folders.plantBundle("gtd", a.deviceId, "gtd", finance);
    expect(issuesOf(await w.engine.pull(), "wrong_domain_bundle")).toHaveLength(1);

    expect(
      applies(w)
        .map((call) => call.domain)
        .filter((domain) => domain !== "gtd"),
    ).toEqual([]);
    expect(await w.repo.getDailyEntry("2026-10-01")).toBeNull();
    expect((await w.repo.inspectSyncProfileData()).counts).toMatchObject({
      personal: 0,
      finance: 0,
    });
    // The work laptop did not become a violator by being offered the data.
    expect((await w.engine.getStatus()).profileViolation).toBeNull();
  });
});

describe("the schema and stale-peer gates on the work path", () => {
  it("skips a peer whose schema is newer than this work laptop's, reads nothing of it, and keeps publishing", async () => {
    const w3 = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: ["gtd"] },
    ]);
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    w3.folders.patchManifest("gtd", a.deviceId, { schemaVersion: 999 });
    await w.repo.createTask({ id: "from-w", title: "From W", bucket: "inbox" });

    const report = await w.engine.syncNow();
    const update = issuesOf(report.pull, "update_required");
    expect(update).toHaveLength(1);
    expect(report.pull.peers.find((peer) => peer.peerId === a.deviceId)?.status).toBe(
      "update_required",
    );
    expect(applies(w)).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(false);
    expect(w3.folders.calls(w.deviceId, "gtd").readBundle).toBe(0);
    expect(report.publish.domains.map((domain) => [domain.domain, domain.outcome])).toEqual([
      ["gtd", "published"],
    ]);
    expect(
      (await w.engine.getStatus()).peers.find((peer) => peer.peerId === a.deviceId),
    ).toMatchObject({
      state: "update_required",
    });
  });

  it("the repository refuses a bundle from a newer schema too, even when the engine lets it through", async () => {
    const w3 = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: ["gtd"], engine: { localSchemaVersion: 999 } },
    ]);
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    // W's engine believes it is on schema 999, so it does not see the skew; the DB knows better.
    await w.db.execute(
      "DELETE FROM schema_migrations WHERE id = (SELECT MAX(id) FROM schema_migrations)",
    );
    const report = await w.engine.pull();
    expect(issuesOf(report, "bundle_rejected").map((issue) => issue.detail)).toEqual([
      "schema_newer_than_local",
    ]);
    expect(await hasTask(w, "from-a")).toBe(false);
  });

  it("merges a peer whose schema is older, taking the schema-skew safety backup", async () => {
    const w3 = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: ["gtd"], engine: { localSchemaVersion: 50 } },
    ]);
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    const report = await w.engine.pull();
    expect(issuesOf(report, "update_required")).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(true);
    expect(report.safetyBackup.reasons).toContain("schema_skew");
  });

  it("refuses a stale peer without merging anything, until the person approves it", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "from-a", title: "From A", bucket: "inbox" });
    await a.engine.publish();
    w3.folders.patchManifest("gtd", a.deviceId, {
      writtenAt: new Date(w.clock.now - STALE_PEER_MS - 1).toISOString(),
    });
    const refused = await w.engine.pull();
    expect(issuesOf(refused, "stale_peer").map((issue) => issue.detail)).toEqual([
      "peer_written_long_ago",
    ]);
    expect(applies(w)).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(false);
    expect((await w.engine.getStatus()).peers[0]).toMatchObject({ state: "stale" });

    const approved = await w.engine.pull({ approveStalePeers: [a.deviceId] });
    expect(issuesOf(approved, "stale_peer")).toEqual([]);
    expect(await hasTask(w, "from-a")).toBe(true);
  });

  it("refuses to merge a peer this work laptop has not pulled from for 90 days", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await a.repo.createTask({ id: "early", title: "early", bucket: "inbox" });
    await a.engine.publish();
    await w.engine.pull();
    a.clock.advance(100 * DAY);
    w.clock.advance(100 * DAY);
    await a.repo.createTask({ id: "late", title: "late", bucket: "inbox" });
    await a.engine.publish();
    w.calls.length = 0;
    const refused: PullReport = await w.engine.pull();
    expect(issuesOf(refused, "stale_peer").map((issue) => issue.detail)).toEqual([
      "not_pulled_recently",
    ]);
    expect(applies(w)).toEqual([]);
    expect(await hasTask(w, "late")).toBe(false);
  });
});

describe("the bundle writer's row filter covers sidecar metadata, on both profiles", () => {
  const filesText = (w3: EngineWorld, device: EngineDevice): string =>
    w3.folders
      .filesOf("gtd")
      .concat(w3.folders.filesOf("personal"))
      .filter((file) => file.path.includes(device.deviceId))
      .map((file) => file.content)
      .join("\n");

  for (const profile of ["personal", "work"] as const) {
    it(`a ${profile} device's running timer leaves no trace in what it publishes`, async () => {
      const w3 = await createEngineWorld([
        { name: "D", profile, roles: profile === "work" ? ["gtd"] : ["gtd", "personal"] },
      ]);
      const d = w3.device("D");
      await d.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
      const started = await d.repo.startPomodoro({ kind: "focus", taskId: "t1" });
      const sessionId = started.activeSession?.id as string;
      const segmentId = started.activeSession?.segments[0]?.id as string;
      // Sidecar rows about the running timer exist on this laptop ...
      const meta = await d.db.select<{ entity_type: string; entity_id: string }[]>(
        "SELECT entity_type, entity_id FROM sync_entity_meta WHERE entity_type LIKE 'pomodoro_%'",
      );
      expect(meta.map((row) => row.entity_id).sort()).toEqual([sessionId, segmentId].sort());
      // ... and so does a conflict about it, and a stale tombstone of a (filtered) segment.
      await d.db.execute(
        `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
         VALUES ('c-pomo', 'pomodoro_sessions', $1, 'terminal_divergence', '{"running":true}', '{}', 'x')`,
        [sessionId],
      );
      await d.db.execute(
        `INSERT INTO sync_entity_meta (entity_type, entity_id, field_clocks_json, row_hlc, deleted_at)
         VALUES ('pomodoro_segments', 'gone-segment', '{}', '0000000000001-0000-x', '0000000000001-0000-x')`,
      );

      const published = await d.engine.publish({ force: true });
      expect(published.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
      const written = filesText(w3, d);
      expect(written).toContain("Plan"); // the folder really holds this laptop's bundle
      expect(written).not.toContain(sessionId);
      expect(written).not.toContain(segmentId);
      expect(written).not.toContain("gone-segment");
      expect(written).not.toContain("terminal_divergence");
      expect(written).not.toContain("pomodoro_sessions");
    });
  }

  it("an alias row about a filtered table is not loaded, so it can never travel", async () => {
    const w3 = await createEngineWorld([{ name: "D" }]);
    const d = w3.device("D");
    await d.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await d.db.execute(
      `INSERT INTO sync_id_aliases (entity_type, alias_id, canonical_id, recorded_hlc)
       VALUES ('pomodoro_sessions', 'zzz', 'aaa', '0000000000001-0000-x')`,
    );
    expect((await d.repo.listSyncChanges("gtd")).aliases).toEqual([]);
    await d.engine.publish({ force: true });
    expect(
      w3.folders
        .filesOf("gtd")
        .map((file) => file.content)
        .join(""),
    ).not.toContain("zzz");
  });
});
