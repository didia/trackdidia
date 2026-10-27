// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { Project } from "../../domain/types";
import { settingsKeysInScope, tablesInDomain } from "./registry";
import { createSyncEngine } from "./sync-engine";
import type { SyncTransport } from "./transport";
import type { SyncDevice } from "./test-support/two-device-harness";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
  settleWorld,
} from "./test-support/engine-harness";
import {
  financeAccount,
  financeRule,
  importRequest,
  importRow,
} from "./test-support/finance-fixtures";
import type { VisibleFile } from "./test-support/memory-transport";
import {
  aiMemory,
  aiMessage,
  annualGoal,
  monthlyReview,
  weeklyObjective,
  weeklyReview,
} from "./test-support/personal-fixtures";

/**
 * The three-device isolation test (spec: "Profile isolation"): personal A, personal B and work W,
 * with W attached to the shared GTD folder ONLY. After a long mixed sequence of edits on all three,
 * W holds no personal or finance data, nothing W can read contains any, A and B agree on everything,
 * and W agrees with both on every gtd table.
 *
 * The personal and finance rows carry SENTINEL strings; the scans below look for them in every row
 * of every table of W's database and in every file W can read.
 */

const SENTINEL = "SENTINEL";
const DAY_ISO = "2026-10-02T16:00:00.000Z"; // noon in Toronto, the suite's pinned time zone

const project = (id: string, title: string): Project => ({
  id,
  title,
  status: "active",
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const everyTable = async (device: SyncDevice): Promise<string[]> =>
  (
    await device.db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).map((row) => row.name);

/** Every row of every table, as text. Sentinels cannot hide in a sidecar, snapshot or conflict. */
const wholeDatabaseText = async (device: SyncDevice): Promise<string> => {
  const parts: string[] = [];
  for (const table of await everyTable(device)) {
    parts.push(JSON.stringify(await device.db.select(`SELECT * FROM "${table}"`)));
  }
  return parts.join("\n");
};

const filesText = (files: VisibleFile[]): string => files.map((file) => file.content).join("\n");

/** The data of the domains W must not hold, written by A and B with sentinels everywhere. */
const writePersonalAndFinance = async (device: EngineDevice, tag: string, week: string) => {
  device.clock.advance(60_000);
  const entry = createEmptyDailyEntry(`2026-10-0${tag === "A" ? 1 : 2}`);
  entry.morningIntention = `${SENTINEL}_daily_${tag}`;
  entry.nightReflection = `${SENTINEL}_night_${tag}`;
  await device.repo.saveDailyEntry(entry);
  await device.repo.saveWeeklyReview(weeklyReview(week, `${SENTINEL}_weekly_${tag}`));
  await device.repo.saveMonthlyReview(monthlyReview("2026-10", `${SENTINEL}_monthly_${tag}`));
  await device.repo.saveMidWeekDecisions({
    weekStartDate: week,
    decisions: `${SENTINEL}_midweek_${tag}`,
    decidedOnDate: "2026-10-07",
    updatedAt: "2026-10-07T12:00:00.000Z",
  });
  await device.repo.saveAnnualGoal(
    annualGoal({ id: `goal-${tag}`, title: `${SENTINEL}_goal_${tag}`, description: "private" }),
  );
  await device.repo.saveWeeklyObjective(weeklyObjective(`obj-${tag}`, `${SENTINEL}_obj_${tag}`));
  await device.repo.saveWeeklyObjectiveResult({
    weekStartDate: week,
    objectiveId: `obj-${tag}`,
    achieved: true,
    updatedAt: "",
  });
  await device.repo.saveAiMessage(aiMessage(`msg-${tag}`, `${SENTINEL}_coach_${tag}`));
  await device.repo.saveAiMemory(aiMemory(`mem-${tag}`, `${SENTINEL}_memory_${tag}`));
  await device.repo.updateSettings((current) => ({
    ...current,
    aiModel: `${SENTINEL}/model-${tag}`,
    relationshipDrawsEnabled: true,
    relationshipDrawChildrenActivities: ["jouer", "lire"],
    relationshipDrawSpouseActivities: ["diner", "marcher"],
    financeEnabled: true,
  }));

  await device.repo.seedFinanceDefaultCategories();
  await device.repo.saveFinanceAccount(
    financeAccount({ id: `account-${tag}`, name: `${SENTINEL}_account_${tag}` }),
  );
  await device.repo.saveFinancePerson({
    id: `person-${tag}`,
    displayName: `${SENTINEL}_person_${tag}`,
    color: null,
    archived: false,
    createdAt: "",
    updatedAt: "",
  });
  await device.repo.importFinanceTransactions(
    importRequest(
      [
        importRow({
          accountId: `account-${tag}`,
          descriptionRaw: `${SENTINEL}_txn_${tag}`,
          merchantKey: `${SENTINEL}_MERCHANT_${tag}`,
          amountMinor: tag === "A" ? -1111 : -2222,
        }),
      ],
      { accountId: `account-${tag}`, fileHash: `file-${tag}` },
    ),
  );
  await device.repo.saveFinanceRule(
    financeRule(`rule-${tag}`, {
      name: `${SENTINEL}_rule_${tag}`,
      matcher: { descriptionContains: "X" },
    }),
  );
  await device.repo.setFinanceBudgetAssignment("2026-10", "fincat:logement", 12345);
};

const writeGtd = async (device: EngineDevice, tag: string) => {
  device.clock.advance(60_000);
  await device.repo.saveProject(project(`proj-${tag}`, `Project ${tag}`));
  await device.repo.createTask({
    id: `task-${tag}-1`,
    title: `Task ${tag} 1`,
    bucket: "next_action",
    projectId: `proj-${tag}`,
  });
  await device.repo.createTask({ id: `task-${tag}-2`, title: `Task ${tag} 2`, bucket: "inbox" });
};

const world = async (): Promise<EngineWorld> =>
  createEngineWorld([{ name: "A" }, { name: "B" }, { name: "W", profile: "work", roles: ["gtd"] }]);

/** What W's database holds of the domains it must not have, and what a fresh database holds. */
const forbiddenRowsOn = async (device: SyncDevice): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const domain of ["personal", "finance"] as const) {
    for (const table of tablesInDomain(domain)) {
      const rows = await device.db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM "${table}"`);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
  }
  return counts;
};

describe("a work laptop that only sees the shared GTD folder", () => {
  it("holds no personal or finance data after a long mixed sequence, while everything converges", async () => {
    const w3 = await world();
    const [a, b, w] = [w3.device("A"), w3.device("B"), w3.device("W")];
    const pristine = await createEngineWorld([{ name: "Fresh", profile: "work", roles: ["gtd"] }]);
    const seeded = await forbiddenRowsOn(pristine.device("Fresh"));
    const seededMeta = await pristine
      .device("Fresh")
      .db.select<{ entity_type: string; entity_id: string }[]>(
        "SELECT entity_type, entity_id FROM sync_entity_meta ORDER BY 1, 2",
      );

    // What exists on a database that never synced: the three finance system categories the
    // migrations seed, and the clock of the one personal setting every database stamps itself.
    expect(seededMeta.map((meta) => `${meta.entity_type}:${meta.entity_id}`)).toEqual([
      "finance_categories:fincat:non-categorise",
      "finance_categories:fincat:split",
      "finance_categories:fincat:transfert",
      "setting:dimancheNotesRelocatedAt",
    ]);

    // Round 1: every laptop works, A and B on everything, W on its list.
    await writePersonalAndFinance(a, "A", "2026-10-04");
    await writeGtd(a, "A");
    await writePersonalAndFinance(b, "B", "2026-10-11");
    await writeGtd(b, "B");
    await writeGtd(w, "W");
    w.clock.advance(1_000);
    await w.repo.completeTask("task-W-1", DAY_ISO);
    const started = await w.repo.startPomodoro({ kind: "focus", taskId: "task-W-2" });
    w.clock.advance(1_500_000);
    await w.repo.stopPomodoroSession(started.activeSession?.id as string, "completed");
    await a.repo.generateDailyRelationshipTasks("2026-10-05");
    await settleWorld(w3);

    // Round 2: more edits to the same rows from every side, deletes included, then sync again.
    a.clock.advance(60_000);
    await a.repo.deleteAnnualGoal("goal-A");
    const entryA = createEmptyDailyEntry("2026-10-01");
    entryA.morningIntention = `${SENTINEL}_daily_A_edited`;
    await a.repo.saveDailyEntry(entryA);
    b.clock.advance(120_000);
    await b.repo.saveWeeklyObjective(weeklyObjective("obj-B", `${SENTINEL}_obj_B_edited`));
    await b.repo.completeTask("task-A-2", DAY_ISO);
    w.clock.advance(180_000);
    await w.repo.createTask({ id: "task-W-3", title: "Task W 3", bucket: "inbox" });
    await w.repo.cancelTask("task-W-3");
    await settleWorld(w3);

    // 1. W's database: no personal or finance row beyond what any fresh database holds.
    expect(await forbiddenRowsOn(w)).toEqual(seeded);
    // 2. No sidecar of those domains either: its metadata, snapshots, aliases, conflicts, marks.
    const leakedSidecars: unknown[] = [];
    for (const domain of ["personal", "finance"] as const) {
      const types = [...tablesInDomain(domain)];
      for (const table of [
        "sync_entity_meta",
        "sync_entity_snapshot",
        "sync_id_aliases",
        "sync_conflicts",
        "sync_dirty",
      ]) {
        const rows = await w.db.select<Record<string, unknown>[]>(`SELECT * FROM ${table}`);
        leakedSidecars.push(
          ...rows.filter(
            (row) =>
              types.includes(String(row.entity_type)) &&
              !seededMeta.some(
                (seed) => seed.entity_type === row.entity_type && seed.entity_id === row.entity_id,
              ),
          ),
        );
        const settingKeys: string[] = settingsKeysInScope(domain);
        leakedSidecars.push(
          ...rows.filter(
            (row) =>
              row.entity_type === "setting" &&
              settingKeys.includes(String(row.entity_id)) &&
              !seededMeta.some(
                (seed) => seed.entity_type === "setting" && seed.entity_id === row.entity_id,
              ),
          ),
        );
      }
    }
    expect(leakedSidecars).toEqual([]);
    // 3. Not a sentinel anywhere in W's database or in anything W can read.
    expect(await wholeDatabaseText(w)).not.toContain(SENTINEL);
    const readable = w3.folders.visibleFiles(w.deviceId);
    expect(readable.length).toBeGreaterThan(0);
    expect(readable.every((file) => file.role === "gtd")).toBe(true);
    expect(filesText(readable)).not.toContain(SENTINEL);
    // The sentinels did reach the personal folder, so the scan above would have caught a leak.
    expect(filesText(w3.folders.filesOf("personal"))).toContain(SENTINEL);
    expect(w3.folders.rolesOf(w.deviceId)).toEqual(["gtd"]);
    for (const operation of Object.values(w3.folders.calls(w.deviceId, "personal"))) {
      expect(operation).toBe(0);
    }
    // 4. Personal and finance settings on W are the defaults (nothing arrived, so nothing to draw from).
    const pristineSettings = (await pristine
      .device("Fresh")
      .repo.getSettings()) as unknown as Record<string, unknown>;
    const wSettings = (await w.repo.getSettings()) as unknown as Record<string, unknown>;
    for (const domain of ["personal", "finance"] as const) {
      for (const key of settingsKeysInScope(domain)) {
        // The one personal marker every database stamps with its own migration time.
        if (key === "dimancheNotesRelocatedAt") continue;
        expect(wSettings[key], key).toEqual(pristineSettings[key]);
      }
    }
    // 5. The engine only ever listed and applied the gtd domain on W.
    expect(
      w.calls.filter((call) => call.method === "listSyncChanges").map((c) => c.domain),
    ).not.toContainEqual(expect.stringMatching(/personal|finance/));
    expect(
      new Set(
        w.calls
          .filter((call) => call.method === "listSyncChanges" || call.method === "applySyncBundle")
          .map((call) => call.domain),
      ),
    ).toEqual(new Set(["gtd"]));
    expect(await w.engine.getStatus()).toMatchObject({ profile: "work", pendingChanges: 0 });

    // 6. Convergence: A and B on everything, W with both on every gtd table.
    await w3.sim.expectConverged("gtd", { snapshots: true });
    for (const domain of ["personal", "finance"] as const) {
      const dumpA = await w3.sim.dump(a, domain, { snapshots: true });
      const dumpB = await w3.sim.dump(b, domain, { snapshots: true });
      // Derived finance snapshots stay on their laptop; everything published matches.
      expect(dumpB.tables, domain).toEqual(dumpA.tables);
      expect(dumpB.settings, domain).toEqual(dumpA.settings);
    }

    // 7. W's work reaches the personal laptops' suggested metrics; A's draws reach W.
    const stats = await a.repo.computeDailyTaskStats("2026-10-02");
    expect(stats.tasksCompleted).toBeGreaterThanOrEqual(2); // W's task-W-1 and B's task-A-2
    const sessions = await a.db.select<{ id: string; date: string }[]>(
      "SELECT id, date FROM pomodoro_sessions WHERE status = 'completed'",
    );
    expect(sessions).toHaveLength(1);
    const day = createEmptyDailyEntry(sessions[0]?.date as string);
    await a.repo.saveDailyEntry(day);
    expect((await a.repo.getDailyEntry(day.date))?.suggestedMetrics?.pomodoris).toBe(1);
    const draws = (await w.repo.listTasks({ includeCompleted: true })).filter((task) =>
      task.sourceExternalId?.startsWith("relationship-draw:"),
    );
    expect(draws).toHaveLength(2);
    expect(
      (await a.repo.listTasks({ includeCompleted: true })).map((task) => task.id).sort(),
    ).toEqual((await w.repo.listTasks({ includeCompleted: true })).map((task) => task.id).sort());
  }, 60_000);

  it("a work engine publishes only the gtd domain and never reads the other tables for it", async () => {
    const w3 = await world();
    const [a, w] = [w3.device("A"), w3.device("W")];
    await writePersonalAndFinance(a, "A", "2026-10-04");
    await writeGtd(w, "W");
    // Make W's own database look personal-heavy too: only the engine's profile may keep it out.
    const report = await w.engine.syncNow({ force: true });
    expect(report.publish.domains.map((d) => [d.domain, d.outcome])).toEqual([
      ["gtd", "published"],
    ]);
    expect(w.calls.filter((call) => call.method === "listSyncChanges")).toEqual([
      { method: "listSyncChanges", domain: "gtd" },
    ]);
    expect(w3.folders.manifestFor("gtd", w.deviceId)?.profile).toBe("work");
    expect(Object.keys(w3.folders.manifestFor("gtd", w.deviceId)?.domains ?? {})).toEqual(["gtd"]);
  });

  it("even if W is wrongly given the personal folder, the engine never reads or applies from it", async () => {
    const leaky = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: ["gtd", "personal"] },
    ]);
    const [a, w] = [leaky.device("A"), leaky.device("W")];
    await writePersonalAndFinance(a, "A", "2026-10-04");
    await writeGtd(a, "A");
    await a.engine.syncNow();

    const report = await w.engine.syncNow();
    // The misconfiguration is visible, but nothing from the personal folder was touched.
    expect(report.pull.issues.filter((issue) => issue.code === "transport_ignored")).toMatchObject([
      { severity: "error", transport: "folder:personal" },
    ]);
    // ... and the status page would show it.
    expect((await w.engine.getStatus()).issues).toContainEqual(
      expect.objectContaining({ code: "transport_ignored", severity: "error" }),
    );
    expect(leaky.folders.calls(w.deviceId, "personal")).toEqual({
      listPeers: 0,
      readBundle: 0,
      publish: 0,
      ownGeneration: 0,
    });
    const fresh = await createEngineWorld([{ name: "Fresh" }]);
    expect(await forbiddenRowsOn(w)).toEqual(await forbiddenRowsOn(fresh.device("Fresh")));
    expect(await wholeDatabaseText(w)).not.toContain(SENTINEL);
    expect(w.calls.some((call) => call.domain === "personal" || call.domain === "finance")).toBe(
      false,
    );
    // ... while the file scan WOULD have caught the exposure: this is what the folder-level check is for.
    expect(filesText(leaky.folders.visibleFiles(w.deviceId))).toContain(SENTINEL);
  }, 60_000);

  it("a work device refuses personal data offered through ONE transport that carries both, without reading it", async () => {
    const mixed = await createEngineWorld([
      { name: "A" },
      { name: "W", profile: "work", roles: [] },
    ]);
    const [a, w] = [mixed.device("A"), mixed.device("W")];
    await writePersonalAndFinance(a, "A", "2026-10-04");
    await writeGtd(a, "A");
    await a.engine.syncNow();

    // A misconfigured transport: both folders behind one object.
    const gtd = mixed.folders.attach(w.deviceId, "gtd");
    const personal = mixed.folders.attach(w.deviceId, "personal");
    const read: string[] = [];
    const combined: SyncTransport = {
      id: "combined",
      domains: ["gtd", "personal", "finance"],
      listPeers: async () => {
        const [fromGtd, fromPersonal] = await Promise.all([gtd.listPeers(), personal.listPeers()]);
        return fromGtd.map((manifest) => ({
          ...manifest,
          domains: {
            ...manifest.domains,
            ...fromPersonal.find((other) => other.deviceId === manifest.deviceId)?.domains,
          },
        }));
      },
      readBundle: (peer, domain) => {
        read.push(domain);
        return (domain === "gtd" ? gtd : personal).readBundle(peer, domain);
      },
      publish: (domain, changeSet, meta) =>
        (domain === "gtd" ? gtd : personal).publish(domain, changeSet, meta),
      ownGeneration: (domain) => (domain === "gtd" ? gtd : personal).ownGeneration(domain),
    };
    const engine = createSyncEngine({
      repo: w.repo,
      transports: [combined],
      profile: "work",
      now: w.clock.read,
    });
    const report = await engine.pull({ verifiedEmptyJoiner: true });
    expect(read).toEqual(["gtd"]);
    expect(report.issues.filter((issue) => issue.code === "domain_not_allowed")).toHaveLength(2);
    expect(await forbiddenRowsOn(w)).toEqual(
      await forbiddenRowsOn((await createEngineWorld([{ name: "Fresh" }])).device("Fresh")),
    );
    expect(await wholeDatabaseText(w)).not.toContain(SENTINEL);
    expect((await w.repo.listTasks({})).length).toBeGreaterThan(0);

    // Nothing about the refused domains is remembered either: not a hash, a size or a row count.
    const status = await w.repo.getSyncStatus();
    const peer = status.supported ? status.peers.find((p) => p.peerId === a.deviceId) : undefined;
    const manifest = peer?.lastManifest as { domains: Record<string, unknown> } | null;
    expect(Object.keys(manifest?.domains ?? {})).toEqual(["gtd"]);
    expect(Object.keys(peer?.lastAppliedShaByDomain ?? {})).toEqual(["gtd"]);
    const personalEntry = mixed.folders.manifestFor("personal", a.deviceId)?.domains.personal;
    expect(personalEntry).toBeDefined();
    const stored = JSON.stringify(await w.db.select("SELECT * FROM sync_peers"));
    expect(stored).not.toContain(personalEntry?.sha256 as string);
    expect(stored).not.toContain("personal-");
    expect(stored).not.toContain("finance-");
  });
});
