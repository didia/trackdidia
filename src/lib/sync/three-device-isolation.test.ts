// @vitest-environment node
// Independent in-memory SQLite databases and the real folder transport over a fake native host.
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { buildDailySnapshot } from "../ai/context/daily-snapshot";
import { validateChangeSet } from "./change-set";
import { decodeBundle, encodeBundle } from "./bundle";
import { splitChangeSet } from "./split-change-set";
import { createSyncEngine } from "./sync-engine";
import { createFakeFolderHost } from "./test-support/fake-folder-host";
import { financeAccount } from "./test-support/finance-fixtures";
import { createSyncHarness } from "./test-support/two-device-harness";
import { createFolderTransport } from "./transport-folder";

const GTD = "/test/shared-gtd";
const PERSONAL = "/test/personal";
const PRIVATE = "private-isolation-sentinel";

it("isolates a work laptop while personal peers exchange all three domains through folder bundles", async () => {
  const sim = await createSyncHarness(["A", "B", "W"]);
  const [a, b, w] = sim.devices;
  await w.repo.updateSettings((settings) => ({ ...settings, syncProfile: "work" }));
  const host = createFakeFolderHost();
  host.mount(GTD);
  host.mount(PERSONAL);
  await host.api.prepareSyncFolder(
    { folderDir: GTD, role: "gtd", environment: "production" },
    PERSONAL,
  );
  await host.api.prepareSyncFolder(
    { folderDir: PERSONAL, role: "personal", environment: "production" },
    GTD,
  );
  const engines = sim.devices.map((device) => {
    const work = device === w;
    const roles = work ? (["gtd"] as const) : (["gtd", "personal"] as const);
    return createSyncEngine({
      repo: device.repo,
      profile: work ? "work" : "personal",
      now: device.clock.read,
      beforeFirstMerge: async () => ({ path: "memory://backup" }),
      transports: roles.map((role) =>
        createFolderTransport({
          role,
          folderDir: role === "gtd" ? GTD : PERSONAL,
          environment: "production",
          deviceId: device.deviceId,
          api: host.api,
        }),
      ),
    });
  });
  const daily = createEmptyDailyEntry("2026-10-01");
  daily.morningIntention = `${PRIVATE}-journal`;
  await a.repo.saveDailyEntry(daily);
  await a.repo.saveFinanceAccount(
    financeAccount({ id: "private-account", name: `${PRIVATE}-finance` }),
  );
  await a.repo.updateSettings((settings) => ({
    ...settings,
    aiModel: `${PRIVATE}-model`,
    aiApiKey: `${PRIVATE}-key`,
    relationshipDrawsEnabled: true,
    relationshipDrawChildrenActivities: ["Read together"],
    relationshipDrawSpouseActivities: ["Walk together"],
  }));
  await a.repo.generateDailyRelationshipTasks("2026-10-03");
  await a.repo.createTask({ id: "personal-task", title: "Personal task", bucket: "inbox" });
  await w.repo.createTask({ id: "work-task", title: "Work task", bucket: "inbox" });
  const workTimer = await w.repo.startPomodoro({ kind: "focus", taskId: "work-task" });
  const workDay = workTimer.activeSession?.date as string;
  await w.repo.stopPomodoroSession(workTimer.activeSession?.id as string, "completed");
  // Model time spent focusing without waiting in real time; the harness stamps this raw test edit.
  await w.db.execute("UPDATE pomodoro_segments SET started_at = $1 WHERE session_id = $2", [
    new Date(Date.now() - 60_000).toISOString(),
    workTimer.activeSession?.id as string,
  ]);
  await w.stamp();
  const running = await a.repo.startPomodoro({ kind: "focus", taskId: "personal-task" });
  const sessionId = running.activeSession?.id as string;
  await a.db.execute(
    `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
    VALUES ('gtd-conflict', 'gtd_tasks', 'personal-task', 'overwritten_edit', '"left"', '"right"', '2026-10-01'),
    ('private-conflict', 'daily_entries', '2026-10-01', 'overwritten_edit', $1, '"other"', '2026-10-01'),
    ('timer-conflict', 'pomodoro_sessions', $2, 'overwritten_edit', '"running"', '"other"', '2026-10-01')`,
    [JSON.stringify(`${PRIVATE}-conflict`), sessionId],
  );
  for (let round = 0; round < 3; round++) {
    for (const engine of engines) await engine.syncNow();
  }
  expect((await b.repo.getDailyEntry("2026-10-01"))?.morningIntention).toBe(`${PRIVATE}-journal`);
  expect(
    (await b.repo.listFinanceAccounts()).some((account) => account.name === `${PRIVATE}-finance`),
  ).toBe(true);
  expect((await a.repo.listTasks({})).map((task) => task.id)).toContain("work-task");
  expect((await w.repo.listTasks({})).map((task) => task.id)).toContain("personal-task");
  expect(
    (await w.repo.listTasks({})).filter((task) =>
      task.sourceExternalId?.startsWith("relationship-draw:"),
    ),
  ).toHaveLength(2);
  expect((await w.repo.getSettings()).relationshipDrawChildrenActivities).not.toEqual([
    "Read together",
  ]);
  const summaries = await a.repo.listPomodoroTaskSummaries(workDay);
  const entry = createEmptyDailyEntry(workDay);
  const coach = buildDailySnapshot(
    {
      date: workDay,
      entry,
      historyEntries: [entry],
      tasks: await a.repo.listTasks({}),
      projects: await a.repo.listProjects(),
      pomodoroTaskSummaries: summaries,
      completedFocusSessionCount: 1,
      productivityPulseWeekToDate: null,
      rescuetimeConfigured: false,
      now: new Date().toISOString(),
    },
    "full",
  );
  expect(JSON.stringify(coach)).toContain("Work task");
  await a.repo.saveDailyEntry(entry);
  expect((await a.repo.getDailyEntry(workDay))?.suggestedMetrics?.pomodoris).toBe(1);
  expect(await w.db.select("SELECT id FROM sync_conflicts WHERE id = 'gtd-conflict'")).toEqual([
    { id: "gtd-conflict" },
  ]);
  expect(await b.db.select("SELECT id FROM sync_conflicts WHERE id = 'private-conflict'")).toEqual([
    { id: "private-conflict" },
  ]);
  const tables = await w.db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const { name } of tables) {
    expect(JSON.stringify(await w.db.select(`SELECT * FROM "${name}"`)), name).not.toContain(
      PRIVATE,
    );
  }
  const text = async (folder: string) =>
    (
      await Promise.all(
        host.filesOf(folder).map(async (file) => {
          const content = host.read(folder, file);
          if (file.endsWith(".bundle") && content instanceof Uint8Array) {
            return JSON.stringify(await decodeBundle(content));
          }
          return typeof content === "string" ? content : new TextDecoder().decode(content);
        }),
      )
    ).join("\n");
  expect(await text(GTD)).not.toContain(PRIVATE);
  expect(await text(GTD)).not.toContain("timer-conflict");
  expect(await text(GTD)).toContain("gtd-conflict");
  expect(await text(GTD)).not.toContain(sessionId);
  expect(await text(PERSONAL)).toContain(`${PRIVATE}-conflict`);
  expect(await text(PERSONAL)).not.toContain(`${PRIVATE}-key`);
  host.calls.length = 0;
  host.unmount(PERSONAL);
  await engines[2].syncNow({ force: true });
  expect(host.calls.every((call) => call.folderDir === GTD)).toBe(true);
}, 60_000);

describe("conflict wire validation", () => {
  it("rejects private conflict rows disguised as GTD and clockless resolutions", async () => {
    const sim = await createSyncHarness(["A"]);
    const set = await sim.device("A").repo.listSyncChanges("gtd");
    const conflict = {
      id: "c",
      entity_type: "daily_entries",
      entity_id: "2026-10-01",
      kind: "overwritten_edit",
      local_json: '"private"',
      remote_json: '"other"',
      detected_at: "2026-10-01",
      resolved_at: null,
      resolution: null,
      resolution_hlc: null,
    };
    expect(() => validateChangeSet({ ...set, conflicts: [conflict] })).toThrow();
    expect(() =>
      validateChangeSet({
        ...set,
        conflicts: [
          {
            ...conflict,
            entity_type: "gtd_tasks",
            entity_id: "t",
            resolved_at: "now",
            resolution: '"value"',
          },
        ],
      }),
    ).toThrow();
  });
});

it("round trips and splits conflict records after entity rows", async () => {
  const sim = await createSyncHarness(["A"]);
  const a = sim.device("A");
  await a.repo.createTask({ id: "one", title: "One", bucket: "inbox" });
  await a.repo.createTask({ id: "two", title: "Two", bucket: "inbox" });
  const set = await a.repo.listSyncChanges("gtd");
  const conflict = {
    id: "conflict-one",
    entity_type: "gtd_tasks",
    entity_id: "one",
    kind: "overwritten_edit",
    local_json: '"left"',
    remote_json: '"right"',
    detected_at: "2026-10-01",
    resolved_at: null,
    resolution: null,
    resolution_hlc: null,
  };
  const withConflict = { ...set, conflicts: [conflict] };
  const encoded = await encodeBundle(withConflict);
  expect(validateChangeSet(await decodeBundle(encoded.bytes))).toEqual(withConflict);
  const chunks = splitChangeSet(withConflict, { maxEntities: 1 });
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flatMap((chunk) => chunk.conflicts ?? [])).toEqual([conflict]);
  expect(chunks.findIndex((chunk) => (chunk.conflicts ?? []).length > 0)).toBeGreaterThanOrEqual(
    chunks.findIndex((chunk) => chunk.entities.some((entity) => entity.entityId === "one")),
  );
  for (const chunk of chunks) validateChangeSet(chunk);
});

it("does not publish historical filtered conflict values even after a timer becomes terminal", async () => {
  const sim = await createSyncHarness(["A"]);
  const a = sim.device("A");
  const session = await a.repo.startPomodoro({ kind: "focus" });
  const id = session.activeSession?.id as string;
  await a.repo.stopPomodoroSession(id, "completed");
  await a.db.execute(
    `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
    VALUES ('old-running', 'pomodoro_sessions', $1, 'overwritten_edit', $2, $3, '2026-10-01'),
    ('both-terminal', 'pomodoro_sessions', $1, 'overwritten_edit', $3, $3, '2026-10-01')`,
    [
      id,
      JSON.stringify({ row: { id, status: "running" } }),
      JSON.stringify({ row: { id, status: "completed" } }),
    ],
  );
  const changes = await a.repo.listSyncChanges("gtd");
  expect(changes.conflicts?.map((row) => row.id)).toEqual(["both-terminal"]);
});

it("rejects an incoming historical running-timer conflict even when its owner is terminal", async () => {
  const sim = await createSyncHarness(["A", "W"]);
  const a = sim.device("A");
  const w = sim.device("W");
  await w.repo.updateSettings((settings) => ({ ...settings, syncProfile: "work" }));
  const started = await a.repo.startPomodoro({ kind: "focus" });
  const id = started.activeSession?.id as string;
  await a.repo.stopPomodoroSession(id, "completed");
  const set = await a.repo.listSyncChanges("gtd");
  const bad = {
    id: "historical-private",
    entity_type: "pomodoro_sessions",
    entity_id: id,
    kind: "overwritten_edit",
    local_json: JSON.stringify({ row: { id, status: "running" } }),
    remote_json: JSON.stringify({ row: { id, status: "completed" } }),
    detected_at: "2026-10-01",
    resolved_at: null,
    resolution: null,
    resolution_hlc: null,
  };
  await expect(w.repo.applySyncBundle("gtd", { ...set, conflicts: [bad] })).rejects.toMatchObject({
    code: "row_filter_violation",
  });
  expect(await w.db.select("SELECT * FROM sync_conflicts WHERE id = 'historical-private'")).toEqual(
    [],
  );
  expect(await w.db.select("SELECT * FROM pomodoro_sessions WHERE id = $1", [id])).toEqual([]);
});
