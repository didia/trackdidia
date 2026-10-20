// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { FinanceAccount, FinanceImportRow } from "../../domain/finance";
import type { AnnualGoal, RecurringTaskTemplate } from "../../domain/types";
import { createEmptyWeeklyReview } from "../../domain/weekly-review";
// SAFETY: every repository here is backed by an isolated `:memory:` SQLite database.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { capturedTables, CAPTURE_TRIGGER_PREFIX, readLiveSchema } from "../sync/capture-install";
import { capturedSettingKeys } from "../sync/capture-stamp";
import {
  clocksOf,
  type MetaRow,
  readIdentity,
  readMarks,
  readMeta,
  readMetaOf,
  syncState,
} from "../sync/capture-test-utils";
import { compareHlc } from "../sync/hlc";
import type { Database } from "./sqlite-db";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const DEVICE = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";

interface Recorded {
  database: Database;
  queries: string[];
}

/** An in-memory database that records every statement, from the first one. */
const recordingDatabase = (foreignKeys = false): Recorded => {
  const database = createNodeSqliteDatabase(":memory:", { foreignKeys });
  const queries: string[] = [];
  const execute = database.execute.bind(database);
  const select = database.select.bind(database);
  database.execute = ((query: string, values?: unknown[]) => {
    queries.push(query);
    return execute(query, values);
  }) as Database["execute"];
  database.select = ((query: string, values?: unknown[]) => {
    queries.push(query);
    return select(query, values);
  }) as Database["select"];
  return { database, queries };
};

const open = async (options: { enable?: boolean; foreignKeys?: boolean } = {}) => {
  const recorded = recordingDatabase(options.foreignKeys === true);
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => recorded.database);
  await repository.initialize();
  await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Portable" });
  if (options.enable !== false) {
    await repository.enableSyncCapture();
  }
  return { ...recorded, repository };
};

type Opened = Awaited<ReturnType<typeof open>>;

const triggerNames = async (database: Database) =>
  (
    await database.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
  ).map((row) => row.name);

const metaFor = (database: Database, type: string, id: string) => readMetaOf(database, type, id);

const changedFields = (before: MetaRow | undefined, after: MetaRow | undefined): string[] => {
  const a = clocksOf(before);
  const b = clocksOf(after);
  return Object.keys(b)
    .filter((key) => a[key] !== b[key])
    .sort();
};

const SYNC_QUERY = /sync_(dirty|entity_meta|entity_snapshot|capture_state|identity)|trg_sync_cap/;

const account = (overrides: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: "account-1",
  name: "Compte chèques",
  institution: null,
  type: "checking",
  currency: "CAD",
  ownerPersonId: null,
  ownership: "individual",
  onBudget: true,
  closed: false,
  openingBalanceMinor: 0,
  currentBalanceMinor: null,
  balanceAsOf: null,
  externalKey: null,
  notes: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const importRow = (overrides: Partial<FinanceImportRow> = {}): FinanceImportRow => ({
  accountId: "account-1",
  postedDate: "2026-04-01",
  amountMinor: -1234,
  currency: "CAD",
  descriptionRaw: "IGA MONTREAL",
  descriptionOriginal: null,
  merchantKey: "IGA MONTREAL",
  categoryHint: null,
  personId: null,
  notes: null,
  labelsJson: null,
  sourceRowJson: null,
  ...overrides,
});

const goal = (overrides: Partial<AnnualGoal> = {}): AnnualGoal => ({
  id: "goal-1",
  title: "Lire 24 livres",
  dimension: "intellectuelle",
  description: "",
  targetValue: 24,
  unit: "livres",
  sourceId: null,
  manualCurrentValue: null,
  evaluations: {},
  measurementType: "cumulative",
  status: "active",
  deadline: null,
  startingValue: null,
  direction: null,
  cadenceTarget: null,
  cadencePeriod: "week",
  principleKey: null,
  progressLog: { "2026-01": 2 },
  milestones: [
    { id: "milestone-1", title: "10 livres", completedAt: null, sortOrder: 0 },
    { id: "milestone-2", title: "24 livres", completedAt: null, sortOrder: 1 },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("enableSyncCapture", () => {
  it("requires a sync identity and installs nothing without one", async () => {
    const database = createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();
    await expect(repository.enableSyncCapture()).rejects.toThrow(
      /sync identity has not been created/,
    );
    expect(await triggerNames(database)).toEqual([]);
    expect(await database.select("SELECT * FROM sync_capture_state")).toEqual([]);
    expect(await repository.getSyncStatus()).toMatchObject({ captureEnabled: false });
  });

  it("installs the triggers, stamps existing data once and reports it", async () => {
    const { database, repository } = await open({ enable: false });
    await repository.saveContext({
      id: "context:a",
      name: "A",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    await repository.createTask({ id: "task-1", title: "Existing", bucket: "inbox" });
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"));
    expect(await readMeta(database)).toEqual([]);

    const first = await repository.enableSyncCapture();
    expect(first.installed).toBe(true);
    expect(first.backfilled).toBeGreaterThanOrEqual(3);
    for (const [type, id] of [
      ["gtd_contexts", "context:a"],
      ["gtd_tasks", "task-1"],
      ["daily_entries", "2026-04-01"],
    ] as const) {
      expect((await metaFor(database, type, id))?.deleted_at).toBeNull();
    }
    const status = await repository.getSyncStatus();
    expect(status).toMatchObject({
      supported: true,
      captureEnabled: true,
      changeCounter: first.backfilled,
      lastPublishCounter: 0,
      pendingChanges: first.backfilled,
    });

    const state = await syncState(database);
    const second = await repository.enableSyncCapture();
    expect(second).toEqual({ installed: false, backfilled: 0 });
    expect(await syncState(database)).toEqual(state);
  });

  it("pendingChanges tracks change_counter - last_publish_counter", async () => {
    const { database, repository } = await open();
    const base = await repository.getSyncStatus();
    await repository.createTask({ id: "task-1", title: "One", bucket: "inbox" });
    await database.execute("UPDATE sync_identity SET last_publish_counter = change_counter");
    await repository.createTask({ id: "task-2", title: "Two", bucket: "inbox" });
    const status = await repository.getSyncStatus();
    expect(status.supported && status.pendingChanges).toBe(1);
    expect(status.supported && status.changeCounter).toBeGreaterThan(
      base.supported ? base.changeCounter : 0,
    );
  });

  it("survives a restart: the flag is reloaded and a dropped trigger is repaired at initialize", async () => {
    const { database, repository } = await open();
    const names = await triggerNames(database);
    expect(names.length).toBeGreaterThan(50);
    await database.execute(`DROP TRIGGER "${CAPTURE_TRIGGER_PREFIX}gtd_tasks_au"`);

    const restarted = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await restarted.initialize();
    expect(await triggerNames(database)).toEqual(names);
    expect(await restarted.getSyncStatus()).toMatchObject({ captureEnabled: true });
    await restarted.createTask({ id: "after-restart", title: "x", bucket: "inbox" });
    expect(await metaFor(database, "gtd_tasks", "after-restart")).toBeDefined();
    expect(repository).toBeDefined();
  });

  it("does not deadlock when it runs next to other writes, and captures all of them", async () => {
    const { database, repository } = await open({ enable: false });
    await Promise.all([
      repository.createTask({ id: "t1", title: "one", bucket: "inbox" }),
      repository.enableSyncCapture(),
      repository.createTask({ id: "t2", title: "two", bucket: "inbox" }),
      repository.saveDailyEntry(createEmptyDailyEntry("2026-04-02")),
    ]);
    for (const id of ["t1", "t2"]) {
      expect((await metaFor(database, "gtd_tasks", id))?.deleted_at).toBeNull();
    }
    expect(await metaFor(database, "daily_entries", "2026-04-02")).toBeDefined();
    expect(await readMarks(database)).toEqual([]);
  });

  it("rolls everything back when enabling fails", async () => {
    const { database, repository } = await open({ enable: false });
    await repository.createTask({ id: "t1", title: "one", bucket: "inbox" });
    // A registry/schema mismatch makes installation throw halfway.
    await database.execute("DROP TABLE finance_budget_months");
    await expect(repository.enableSyncCapture()).rejects.toThrow(/finance_budget_months/);
    expect(await triggerNames(database)).toEqual([]);
    expect(await readMeta(database)).toEqual([]);
    expect(await repository.getSyncStatus()).toMatchObject({ captureEnabled: false });
  });
});

// Production enforces foreign keys (sqlx turns `PRAGMA foreign_keys` on by default), and two
// migrations declare `ON DELETE CASCADE`: weekly_objective_results -> weekly_objectives and
// ai_proposals -> ai_messages. SQLite fires the child table's DELETE triggers for rows removed by
// an FK action, so cascaded rows are still marked and tombstoned.
describe("with foreign keys enforced, as in production", () => {
  const objective = {
    id: "objective-1",
    title: "Deep work",
    kind: "manual",
    targetHours: null,
    rescuetimeKind: null,
    rescuetimeThing: null,
    sortOrder: 0,
    startsOnWeekStartDate: "2026-03-29",
    endsOnWeekStartDate: null,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  } as never;
  const resultId = '["2026-03-29","objective-1"]';

  const seedObjective = async (opened: Opened) => {
    await opened.repository.saveWeeklyObjective(objective);
    await opened.repository.saveWeeklyObjectiveResult({
      weekStartDate: "2026-03-29",
      objectiveId: "objective-1",
      achieved: true,
      updatedAt: "",
    });
    expect(
      (await metaFor(opened.database, "weekly_objective_results", resultId))?.deleted_at,
    ).toBeNull();
  };

  it("really enforces them in this adapter (and not by default)", async () => {
    const on = await open({ foreignKeys: true });
    expect(await on.database.select("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    const off = await open();
    expect(await off.database.select("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 0 }]);
  });

  it("marks and tombstones results removed by the ON DELETE CASCADE of their objective", async () => {
    const opened = await open({ foreignKeys: true });
    await seedObjective(opened);
    // A raw delete of the parent: the repository path deletes the results explicitly first, this
    // one leaves the removal of the child entirely to the foreign key action.
    await opened.database.execute("DELETE FROM weekly_objectives WHERE id = 'objective-1'");
    expect(
      await opened.database.select("SELECT COUNT(*) AS n FROM weekly_objective_results"),
    ).toEqual([{ n: 0 }]);
    expect(await readMarks(opened.database)).toEqual([
      { entity_type: "weekly_objective_results", entity_id: resultId, op: "delete" },
      { entity_type: "weekly_objectives", entity_id: "objective-1", op: "delete" },
    ]);
    // The next repository write stamps the leftover marks.
    await opened.repository.createTask({ id: "t1", title: "x", bucket: "inbox" });
    expect(
      (await metaFor(opened.database, "weekly_objective_results", resultId))?.deleted_at,
    ).toBeTruthy();
    expect(
      (await metaFor(opened.database, "weekly_objectives", "objective-1"))?.deleted_at,
    ).toBeTruthy();
    expect(await readMarks(opened.database)).toEqual([]);
  });

  it("tombstones objective and results through deleteWeeklyObjective", async () => {
    const opened = await open({ foreignKeys: true });
    await seedObjective(opened);
    await opened.repository.deleteWeeklyObjective("objective-1");
    expect(
      (await metaFor(opened.database, "weekly_objective_results", resultId))?.deleted_at,
    ).toBeTruthy();
    expect(
      (await metaFor(opened.database, "weekly_objectives", "objective-1"))?.deleted_at,
    ).toBeTruthy();
    expect(await readMarks(opened.database)).toEqual([]);
  });

  it("marks and tombstones ai_proposals removed by the cascade of their ai_messages row", async () => {
    const opened = await open({ foreignKeys: true });
    const { database, repository } = opened;
    await database.execute(
      `INSERT INTO ai_messages (id, surface, scope_key, stance, kind, input_hash, prompt_version, model, status, body_json, body_text, delta_class, notified, tokens_prompt, tokens_completion, latency_ms, created_at)
       VALUES ('m1', 's', 'k', 'x', 'k', 'h', 'v', 'm', 'ok', '{}', '', 'none', 0, 0, 0, 0, 't')`,
    );
    await database.execute(
      `INSERT INTO ai_proposals (id, message_id, type, payload_json, status, created_at)
       VALUES ('p1', 'm1', 'memory', '{}', 'pending', 't')`,
    );
    await repository.createTask({ id: "t0", title: "stamp", bucket: "inbox" });
    expect((await metaFor(database, "ai_proposals", "p1"))?.deleted_at).toBeNull();
    await database.execute("DELETE FROM ai_messages WHERE id = 'm1'");
    expect(await readMarks(database)).toEqual([
      { entity_type: "ai_proposals", entity_id: "p1", op: "delete" },
    ]);
    await repository.createTask({ id: "t1", title: "stamp", bucket: "inbox" });
    expect((await metaFor(database, "ai_proposals", "p1"))?.deleted_at).toBeTruthy();
    // The union table itself is still never clocked.
    expect((await readMeta(database)).some((row) => row.entity_type === "ai_messages")).toBe(false);
  });

  it("captures a full random-looking workload with foreign keys on", async () => {
    const opened = await open({ foreignKeys: true });
    await seedObjective(opened);
    await opened.repository.saveAnnualGoal(goal());
    await opened.repository.saveFinanceAccount(account());
    await opened.repository.importFinanceTransactions({
      accountId: "account-1",
      profileId: null,
      fileName: "a.csv",
      fileHash: "h",
      rows: [importRow()],
    });
    expect(await readMarks(opened.database)).toEqual([]);
    expect((await readMeta(opened.database, "finance_transactions")).length).toBe(1);
  });
});

describe("capture disabled: nothing changes", () => {
  it("creates no trigger and no sync row, and issues no sync query for any write", async () => {
    const { database, queries, repository } = await open({ enable: false });
    expect(await triggerNames(database)).toEqual([]);
    queries.length = 0;

    await repository.createTask({ id: "t1", title: "one", bucket: "inbox" });
    await repository.completeTask("t1");
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"));
    await repository.updateSettings((current) => ({ ...current, aiModel: "vendor/model-0" }));
    await repository.saveSettings({ ...(await repository.getSettings()), aiEnabled: true });
    await repository.saveFinanceAccount(account());
    await repository.importFinanceTransactions({
      accountId: "account-1",
      profileId: null,
      fileName: "a.csv",
      fileHash: "h",
      rows: [importRow()],
    });
    await repository.startPomodoro({ taskId: "t1" });
    await repository.saveAnnualGoal(goal());
    await repository.generateDueRecurringTasks("2026-04-01");

    expect(queries.length).toBeGreaterThan(20);
    expect(queries.filter((query) => SYNC_QUERY.test(query))).toEqual([]);
    expect(await readMeta(database)).toEqual([]);
    expect(await database.select("SELECT * FROM sync_entity_snapshot")).toEqual([]);
    expect(await readIdentity(database)).toMatchObject({ change_counter: 0 });
  });

  it("costs exactly one cheap query at initialize for a database that never enabled capture", async () => {
    const recorded = recordingDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => recorded.database);
    await repository.initialize();
    expect(
      recorded.queries
        .filter((query) => SYNC_QUERY.test(query))
        .filter((query) => !query.includes("CREATE TABLE")),
    ).toEqual(["SELECT id FROM sync_capture_state WHERE id = 1"]);
  });
});

describe("end to end through the repository methods", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = (ms = 60_000) => vi.setSystemTime(new Date(Date.now() + ms));

  it("tasks: create, edit one field, complete, cancel; events get no meta", async () => {
    const { database, repository } = await open();
    const created = await repository.createTask({
      id: "task-1",
      title: "Write plan",
      bucket: "next_action",
      contextIds: ["context:maison"],
    });
    const afterCreate = await metaFor(database, "gtd_tasks", "task-1");
    expect(afterCreate?.deleted_at).toBeNull();
    expect(clocksOf(afterCreate)["context_ids_json.context:maison"]).toBe(afterCreate?.row_hlc);

    tick();
    await repository.saveTask({ ...created, title: "Write the plan" });
    const afterEdit = await metaFor(database, "gtd_tasks", "task-1");
    const edited = changedFields(afterCreate, afterEdit);
    expect(edited).toContain("title");
    expect(edited.every((field) => ["title", "updated_at"].includes(field))).toBe(true);
    expect(compareHlc(afterCreate?.row_hlc as string, afterEdit?.row_hlc as string)).toBe(-1);

    tick();
    await repository.completeTask("task-1");
    const afterComplete = await metaFor(database, "gtd_tasks", "task-1");
    const completed = changedFields(afterEdit, afterComplete);
    expect(completed).toEqual(expect.arrayContaining(["status", "completed_at"]));
    expect(completed).not.toContain("title");
    expect(completed).not.toContain("notes");

    // The union table that task lifecycle writes to is never clocked.
    expect(
      (await database.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM gtd_task_events"))[0]?.n,
    ).toBeGreaterThan(0);
    expect((await readMeta(database)).some((row) => row.entity_type === "gtd_task_events")).toBe(
      false,
    );
    expect(await readMarks(database)).toEqual([]);
  });

  it("contexts and projects: create and edit", async () => {
    const { database, repository } = await open();
    const context = await repository.saveContext({
      id: "context:deep",
      name: "Deep",
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z",
    });
    const created = await metaFor(database, "gtd_contexts", "context:deep");
    tick();
    await repository.saveContext({
      ...context,
      name: "Deep work",
      updatedAt: new Date().toISOString(),
    });
    expect(changedFields(created, await metaFor(database, "gtd_contexts", "context:deep"))).toEqual(
      ["name", "updated_at"],
    );

    const project = await repository.saveProject({
      id: "project-1",
      title: "Projet",
      status: "active",
      statusChangedAt: "2026-04-01T10:00:00.000Z",
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-04-01T10:00:00.000Z",
    });
    const projectCreated = await metaFor(database, "gtd_projects", "project-1");
    tick();
    await repository.saveProject({ ...project, notes: "n", contextIds: ["context:deep"] });
    const projectEdited = changedFields(
      projectCreated,
      await metaFor(database, "gtd_projects", "project-1"),
    );
    expect(projectEdited).toEqual(
      expect.arrayContaining(["notes", "context_ids_json.context:deep"]),
    );
    expect(projectEdited).not.toContain("title");
  });

  it("daily entries stamp per metric key", async () => {
    const { database, repository } = await open();
    const entry = createEmptyDailyEntry("2026-04-01");
    await repository.saveDailyEntry(entry);
    const created = await metaFor(database, "daily_entries", "2026-04-01");
    tick();
    await repository.saveDailyEntry({
      ...entry,
      metrics: { ...entry.metrics, pushups: 25 },
      updatedAt: new Date().toISOString(),
    });
    expect(changedFields(created, await metaFor(database, "daily_entries", "2026-04-01"))).toEqual([
      "metrics_json.pushups",
      "updated_at",
    ]);
  });

  it("weekly reviews: create and edit a note key", async () => {
    const { database, repository } = await open();
    const review = createEmptyWeeklyReview("2026-03-29");
    await repository.saveWeeklyReview(review);
    const created = await metaFor(database, "weekly_reviews", "2026-03-29");
    expect(created).toBeDefined();
    tick();
    const noteKey = Object.keys(review.notes)[0] as keyof typeof review.notes;
    await repository.saveWeeklyReview({
      ...review,
      notes: { ...review.notes, [noteKey]: "a note" },
    });
    const edited = changedFields(created, await metaFor(database, "weekly_reviews", "2026-03-29"));
    expect(edited).toContain(`notes_json.${noteKey}`);
    expect(edited.every((field) => field.startsWith("notes_json.") || field === "updated_at")).toBe(
      true,
    );
  });

  it("annual goals: create, edit one milestone, delete (tombstone), recreate (resurrection)", async () => {
    const { database, repository } = await open();
    await repository.saveAnnualGoal(goal());
    const created = await metaFor(database, "annual_goals", "goal-1");
    expect(clocksOf(created)["milestones_json.milestone-1"]).toBeDefined();

    tick();
    await repository.saveAnnualGoal(
      goal({
        milestones: [
          { id: "milestone-1", title: "10 livres", completedAt: "2026-02-01", sortOrder: 0 },
          { id: "milestone-2", title: "24 livres", completedAt: null, sortOrder: 1 },
        ],
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const edited = await metaFor(database, "annual_goals", "goal-1");
    expect(changedFields(created, edited)).toEqual(["milestones_json.milestone-1", "updated_at"]);

    tick();
    await repository.deleteAnnualGoal("goal-1");
    const tombstone = await metaFor(database, "annual_goals", "goal-1");
    expect(tombstone?.deleted_at).toBeTruthy();
    expect(tombstone?.deleted_at).toBe(tombstone?.row_hlc);
    expect(clocksOf(tombstone)).toEqual(clocksOf(edited));
    expect(
      await database.select("SELECT * FROM sync_entity_snapshot WHERE entity_id = 'goal-1'"),
    ).toEqual([]);

    tick();
    await repository.saveAnnualGoal(goal({ title: "Lire 30 livres" }));
    const revived = await metaFor(database, "annual_goals", "goal-1");
    expect(revived?.deleted_at).toBeNull();
    expect(compareHlc(tombstone?.row_hlc as string, revived?.row_hlc as string)).toBe(-1);
    expect(clocksOf(revived).title).toBe(revived?.row_hlc);
  });

  it("weekly objectives: deleting the objective tombstones it and its results", async () => {
    const { database, repository } = await open({ foreignKeys: true });
    const objective = await repository.saveWeeklyObjective({
      id: "objective-1",
      title: "Deep work",
      kind: "manual",
      targetHours: null,
      rescuetimeKind: null,
      rescuetimeThing: null,
      sortOrder: 0,
      startsOnWeekStartDate: "2026-03-29",
      endsOnWeekStartDate: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    } as never);
    await repository.saveWeeklyObjectiveResult({
      weekStartDate: "2026-03-29",
      objectiveId: objective.id,
      achieved: true,
      updatedAt: "",
    });
    const resultId = '["2026-03-29","objective-1"]';
    expect((await metaFor(database, "weekly_objective_results", resultId))?.deleted_at).toBeNull();
    await repository.deleteWeeklyObjective(objective.id);
    expect((await metaFor(database, "weekly_objectives", objective.id))?.deleted_at).toBeTruthy();
    expect(
      (await metaFor(database, "weekly_objective_results", resultId))?.deleted_at,
    ).toBeTruthy();
  });

  it("pomodoro: start and complete a session and its segments", async () => {
    const { database, repository } = await open();
    await repository.createTask({ id: "task-focus", title: "Focus", bucket: "next_action" });
    const started = await repository.startPomodoro({ taskId: "task-focus" });
    const sessionId = started.activeSession?.id as string;
    const running = await metaFor(database, "pomodoro_sessions", sessionId);
    expect(running?.field_clocks_json).toBe("{}");
    expect(await readMarks(database)).toEqual([]);

    tick(25 * 60_000);
    await repository.stopPomodoroSession(sessionId, "completed", new Date().toISOString());
    const done = await metaFor(database, "pomodoro_sessions", sessionId);
    expect(compareHlc(running?.row_hlc as string, done?.row_hlc as string)).toBe(-1);
    const segments = await readMeta(database, "pomodoro_segments");
    expect(segments.length).toBeGreaterThan(0);
  });

  it("finance: account, import, categorize, splits, undo (tombstones)", async () => {
    const { database, repository } = await open();
    await repository.saveFinanceAccount(account());
    expect((await metaFor(database, "finance_accounts", "account-1"))?.deleted_at).toBeNull();

    const summary = await repository.importFinanceTransactions({
      accountId: "account-1",
      profileId: null,
      fileName: "a.csv",
      fileHash: "h1",
      rows: [
        importRow({ descriptionRaw: "IGA", merchantKey: "IGA" }),
        importRow({ descriptionRaw: "ESSO", merchantKey: "ESSO", amountMinor: -4200 }),
        importRow({ descriptionRaw: "COSTCO", merchantKey: "COSTCO", amountMinor: -9900 }),
      ],
    });
    const transactions = await repository.listFinanceTransactions({});
    expect(transactions).toHaveLength(3);
    for (const transaction of transactions) {
      expect(
        (await metaFor(database, "finance_transactions", transaction.id))?.deleted_at,
      ).toBeNull();
    }
    expect(await metaFor(database, "finance_import_batches", summary.batchId)).toBeDefined();
    expect(await readMarks(database)).toEqual([]);

    const byAmount = (amount: number) =>
      transactions.find((t) => t.amountMinor === amount) as (typeof transactions)[number];
    const first = byAmount(-1234);
    const before = await metaFor(database, "finance_transactions", first.id);
    tick();
    await repository.setFinanceTransactionCategory({
      transactionId: first.id,
      categoryId: "fincat:alimentation.epicerie",
      scope: "this",
    });
    const after = await metaFor(database, "finance_transactions", first.id);
    expect(compareHlc(before?.row_hlc as string, after?.row_hlc as string)).toBe(-1);
    expect(after?.field_clocks_json).toBe("{}");

    const second = byAmount(-4200);
    await repository.saveFinanceTransactionSplits(second.id, [
      {
        id: "",
        transactionId: second.id,
        amountMinor: -3000,
        categoryId: "fincat:alimentation.epicerie",
        notes: null,
        sortOrder: 0,
        createdAt: "",
      },
      {
        id: "",
        transactionId: second.id,
        amountMinor: -1200,
        categoryId: "fincat:transport.essence",
        notes: null,
        sortOrder: 1,
        createdAt: "",
      },
    ]);
    const splits = await repository.listFinanceTransactionSplits(second.id);
    expect(splits).toHaveLength(2);
    for (const split of splits) {
      expect(await metaFor(database, "finance_transaction_splits", split.id)).toBeDefined();
    }

    tick();
    const undo = await repository.undoFinanceImportBatch(summary.batchId);
    expect(undo.deleted).toBeGreaterThanOrEqual(1);
    expect(undo.refusedUserCategorized).toBeGreaterThanOrEqual(1);
    const survivors = new Set((await repository.listFinanceTransactions({})).map((t) => t.id));
    for (const transaction of transactions) {
      const meta = await metaFor(database, "finance_transactions", transaction.id);
      expect(meta?.deleted_at === null).toBe(survivors.has(transaction.id));
    }
    expect(await readMarks(database)).toEqual([]);
  });

  it("composite keys with an integer column: merchant memory upsert, update and forget", async () => {
    const { database, repository } = await open();
    const entry = {
      merchantKey: 'CAFE "DU COIN"',
      accountId: "account-1",
      sign: -1 as const,
      categoryId: "fincat:alimentation.epicerie",
      hitCount: 1,
      correctionCount: 0,
      confidence: 0.9,
      source: "user_correction" as const,
      lastAppliedAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };
    const id = '["CAFE \\"DU COIN\\"","account-1",-1]';
    await repository.upsertFinanceMerchantMemory(entry);
    const created = await metaFor(database, "finance_merchant_memory", id);
    expect(created?.deleted_at).toBeNull();
    tick();
    await repository.upsertFinanceMerchantMemory({ ...entry, hitCount: 2 });
    const updated = await metaFor(database, "finance_merchant_memory", id);
    expect(compareHlc(created?.row_hlc as string, updated?.row_hlc as string)).toBe(-1);
    tick();
    await repository.forgetFinanceMerchantMemory(entry.merchantKey, "account-1", -1);
    const forgotten = await metaFor(database, "finance_merchant_memory", id);
    expect(forgotten?.deleted_at).toBe(forgotten?.row_hlc);
    expect(compareHlc(updated?.row_hlc as string, forgotten?.row_hlc as string)).toBe(-1);
  });

  it("settings: synced keys get per-key meta; device keys and secrets never do", async () => {
    const { database, repository } = await open();
    const before = await readMeta(database, "setting");
    await repository.updateSettings((current) => ({
      ...current,
      gtdImportDoneAt: "2026-04-01T00:00:00.000Z",
      aiModel: "vendor/model",
      aiApiKey: "sk-super-secret",
      rescuetimeApiKey: "rt-secret",
      llmBridgeToken: "bridge-secret",
      lastBackupAt: "2026-04-01T00:00:00.000Z",
      backupDestinationDir: "/somewhere",
    }));
    const after = await readMeta(database, "setting");
    const added = after
      .filter((row) => !before.some((old) => old.entity_id === row.entity_id))
      .map((row) => row.entity_id)
      .sort();
    expect(added).toEqual(["aiModel", "gtdImportDoneAt"]);
    for (const row of after) {
      expect(capturedSettingKeys()).toContain(row.entity_id);
    }

    // Changing a secret alone creates nothing and moves nothing.
    const state = await syncState(database);
    await repository.updateSettings((current) => ({ ...current, aiApiKey: "sk-other" }));
    expect(await syncState(database)).toEqual(state);
    const everything = JSON.stringify([
      await database.select("SELECT * FROM sync_entity_meta"),
      await database.select("SELECT * FROM sync_entity_snapshot"),
      await database.select("SELECT * FROM sync_dirty"),
    ]);
    expect(everything).not.toContain("sk-");
    expect(everything).not.toContain("rt-secret");
    expect(everything).not.toContain("bridge-secret");
  });

  it("hard delete of tasks through a repository path that uses deleteTasksByIds", async () => {
    const { database, repository } = await open();
    // Two imported duplicates of one recurring group, as an older import left them.
    for (const id of ["dup-a", "dup-b"]) {
      await database.execute(
        `INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, source_external_id,
           recurrence_group_id, created_at, updated_at)
         VALUES ($1, 'Retro hebdomadaire', '', 'open', 'next_action', '[]', 'google_import', $1, 'rec-1', 't', 't')`,
        [id],
      );
    }
    // Any repository write stamps the marks the raw inserts left behind.
    await repository.createTask({ id: "unrelated", title: "x", bucket: "inbox" });
    for (const id of ["dup-a", "dup-b"]) {
      expect((await metaFor(database, "gtd_tasks", id))?.deleted_at).toBeNull();
    }
    tick();
    const collapsed = await repository.collapseGoogleRecurringTasks({
      items: [
        {
          id: "list-1",
          title: "Next Actions - Perso (3)",
          items: [
            {
              id: "task-new",
              title: "Retro hebdomadaire",
              status: "needsAction",
              task_recurrence_id: "rec-1",
              scheduled_time: [{ current: true, start: "2026-03-29T10:00:00.000Z" }],
              updated: "2026-03-29T10:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(collapsed).toBe(1);
    const remaining = new Set(
      (await repository.listTasks({ includeCompleted: true })).map((t) => t.id),
    );
    expect(remaining.has("dup-a") || remaining.has("dup-b")).toBe(false);
    for (const id of ["dup-a", "dup-b"]) {
      expect((await metaFor(database, "gtd_tasks", id))?.deleted_at).toBeTruthy();
    }
    expect(
      (await metaFor(database, "gtd_tasks", "google-recurrence:rec-1"))?.deleted_at,
    ).toBeNull();
    expect(await readMarks(database)).toEqual([]);
  });
});

describe("writes that bypass writeTransaction are still stamped", () => {
  it("stamps finance-store and pomodoro writes right after they commit", async () => {
    const { database, repository } = await open();
    await repository.saveFinanceAccount(account());
    await repository.saveFinancePerson({
      id: "person-1",
      displayName: "Alex",
      color: null,
      archived: false,
      createdAt: "",
      updatedAt: "",
    });
    expect(await metaFor(database, "finance_accounts", "account-1")).toBeDefined();
    expect(await metaFor(database, "finance_people", "person-1")).toBeDefined();
    expect(await readMarks(database)).toEqual([]);
  });

  it("keeps the marks and stamps them on the next write when a flush fails", async () => {
    const { database, repository } = await open();
    const execute = database.execute.bind(database);
    let failing = true;
    vi.spyOn(database, "execute").mockImplementation(async (sql, values) => {
      if (failing && sql.startsWith("INSERT OR REPLACE INTO sync_entity_meta")) {
        throw new Error("stamp failed");
      }
      return execute(sql, values);
    });
    // The finance write itself commits; only the follow-up stamp fails and is swallowed.
    await repository.saveFinanceAccount(account());
    expect(await repository.listFinanceAccounts()).toHaveLength(1);
    expect(await readMarks(database)).toEqual([
      { entity_type: "finance_accounts", entity_id: "account-1", op: "upsert" },
    ]);
    expect(await metaFor(database, "finance_accounts", "account-1")).toBeUndefined();

    failing = false;
    await repository.createTask({ id: "t1", title: "next write", bucket: "inbox" });
    expect(await readMarks(database)).toEqual([]);
    expect((await metaFor(database, "finance_accounts", "account-1"))?.deleted_at).toBeNull();
    vi.restoreAllMocks();
  });

  it("rolls the whole writeTransaction back when stamping fails", async () => {
    const { database, repository } = await open();
    const execute = database.execute.bind(database);
    vi.spyOn(database, "execute").mockImplementation(async (sql, values) => {
      if (sql.startsWith("INSERT OR REPLACE INTO sync_entity_meta")) {
        throw new Error("stamp failed");
      }
      return execute(sql, values);
    });
    await expect(repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"))).rejects.toThrow(
      "stamp failed",
    );
    vi.restoreAllMocks();
    expect(await repository.getDailyEntry("2026-04-01")).toBeNull();
    expect(await readMarks(database)).toEqual([]);
    expect((await readMeta(database)).some((row) => row.entity_type === "daily_entries")).toBe(
      false,
    );
  });
});

describe("idle generators leave capture state untouched", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TODAY = "2026-04-01";
  const template: RecurringTaskTemplate = {
    id: "recurring-template:idle",
    title: "Daily thing",
    notes: "",
    targetBucket: "next_action",
    contextIds: [],
    projectId: null,
    ruleType: "daily",
    dailyInterval: 1,
    weeklyInterval: 1,
    weeklyDays: [0],
    monthlyMode: "day_of_month",
    dayOfMonth: 1,
    nthWeek: 1,
    weekday: 6,
    scheduledTime: null,
    startDate: TODAY,
    status: "active",
    lastGeneratedForDate: null,
    pendingMissedOccurrences: 0,
    statusChangedAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };

  const generators = async (opened: Opened) => ({
    recurring: await opened.repository.generateDueRecurringTasks(TODAY),
    scheduled: await opened.repository.promoteDueScheduledTasks(TODAY),
    relationship: await opened.repository.generateDailyRelationshipTasks(TODAY),
  });

  it("an empty database", async () => {
    const opened = await open();
    await opened.repository.updateSettings((c) => ({ ...c, relationshipDrawsEnabled: false }));
    const before = await syncState(opened.database);
    expect(await generators(opened)).toEqual({ recurring: 0, scheduled: 0, relationship: 0 });
    expect(await syncState(opened.database)).toEqual(before);
  });

  it("a second pass after the work was done", async () => {
    const opened = await open();
    await opened.repository.updateSettings((c) => ({ ...c, relationshipDrawsEnabled: true }));
    await opened.repository.saveRecurringTaskTemplate(template);
    await opened.repository.createTask({
      title: "Tomorrow",
      bucket: "scheduled",
      scheduledFor: "2026-04-02T09:00:00",
    });
    const first = await generators(opened);
    expect(first.recurring).toBe(1);
    expect(first.relationship).toBeGreaterThan(0);
    // The first pass did capture what it created.
    expect((await readMeta(opened.database, "gtd_tasks")).length).toBeGreaterThanOrEqual(
      first.recurring + first.relationship,
    );

    const before = await syncState(opened.database);
    const second = await generators(opened);
    expect(second).toEqual({ recurring: 0, scheduled: 0, relationship: 0 });
    expect(await syncState(opened.database)).toEqual(before);
    const changes = await opened.database.select<{ n: number }[]>("SELECT total_changes() AS n");
    await generators(opened);
    expect(
      (await opened.database.select<{ n: number }[]>("SELECT total_changes() AS n"))[0]?.n,
    ).toBe(changes[0]?.n);
  });
});

describe("two independent repositories never capture what must not be captured", () => {
  // A tiny deterministic PRNG so a failing seed reproduces.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const capturedNames = new Set(capturedTables().map((entry) => entry.table));

  const assertInvariants = async (opened: Opened) => {
    const { database } = opened;
    expect(await readMarks(database)).toEqual([]);
    const meta = await readMeta(database);
    const schema = await readLiveSchema(database, [...capturedNames]);
    for (const row of meta) {
      if (row.entity_type === "setting") {
        expect(capturedSettingKeys()).toContain(row.entity_id);
        expect(row.field_clocks_json).toBe("{}");
        continue;
      }
      // Never a union table, a device table, a sidecar or bookkeeping.
      expect(capturedNames.has(row.entity_type)).toBe(true);
      const live = schema.get(row.entity_type);
      const keyColumns = new Set(live?.primaryKey);
      for (const key of Object.keys(clocksOf(row))) {
        const field = key.split(".")[0] as string;
        expect(live?.columns.includes(field) && !keyColumns.has(field)).toBe(true);
      }
      if (row.deleted_at !== null) expect(row.deleted_at).toBe(row.row_hlc);
    }
    const counter = (await readIdentity(database))?.change_counter ?? 0;
    expect(counter).toBeGreaterThanOrEqual(0);
  };

  const operations: ((o: Opened, rnd: () => number, i: number) => Promise<unknown>)[] = [
    (o, _r, i) => o.repository.createTask({ id: `task-${i}`, title: `T${i}`, bucket: "inbox" }),
    async (o, rnd) => {
      const tasks = await o.repository.listTasks({ includeCompleted: true });
      const task = tasks[Math.floor(rnd() * tasks.length)];
      if (task)
        await o.repository.saveTask({
          ...task,
          title: `${task.title}!`,
          contextIds: rnd() < 0.5 ? ["context:a"] : [],
        });
    },
    async (o, rnd) => {
      const tasks = await o.repository.listTasks({});
      const task = tasks[Math.floor(rnd() * tasks.length)];
      if (task) await o.repository.completeTask(task.id);
    },
    (o, _r, i) =>
      o.repository.saveContext({
        id: `context:c${i % 4}`,
        name: `Context ${i}`,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
    (o, rnd) => {
      const entry = createEmptyDailyEntry("2026-04-01");
      entry.metrics = { ...entry.metrics, pushups: Math.floor(rnd() * 50) };
      return o.repository.saveDailyEntry(entry);
    },
    (o, rnd) => {
      const review = createEmptyWeeklyReview("2026-03-29");
      const key = Object.keys(review.notes)[0] as keyof typeof review.notes;
      return o.repository.saveWeeklyReview({
        ...review,
        notes: { ...review.notes, [key]: String(rnd()) },
      });
    },
    (o, rnd, i) =>
      o.repository.saveAnnualGoal(
        goal({ id: `goal-${i % 3}`, title: `G${Math.floor(rnd() * 5)}` }),
      ),
    (o, _r, i) => o.repository.deleteAnnualGoal(`goal-${i % 3}`),
    (o, rnd) =>
      o.repository.updateSettings((current) => ({
        ...current,
        aiModel: rnd() < 0.5 ? "vendor/a" : "vendor/b",
        aiApiKey: `sk-${rnd()}`,
        lastBackupAt: new Date(Math.floor(rnd() * 1e12)).toISOString(),
        financeEnabled: rnd() < 0.5,
      })),
    async (o, _r, i) => {
      await o.repository.saveFinanceAccount(account());
      await o.repository.importFinanceTransactions({
        accountId: "account-1",
        profileId: null,
        fileName: `f${i}.csv`,
        fileHash: `h${i}`,
        rows: [
          importRow({ descriptionRaw: `ROW ${i}`, merchantKey: `ROW ${i}`, amountMinor: -(i + 1) }),
        ],
      });
    },
    async (o) => {
      const batches = await o.repository.listFinanceImportBatches(1);
      const batch = batches[0];
      if (batch) await o.repository.undoFinanceImportBatch(batch.id);
    },
    async (o) => {
      const state = await o.repository.startPomodoro({});
      if (state.activeSession) {
        await o.repository.stopPomodoroSession(state.activeSession.id, "cancelled");
      }
    },
    (o) => o.repository.generateDueRecurringTasks("2026-04-01"),
    (o) => o.repository.generateDailyRelationshipTasks("2026-04-01"),
    (o) => o.repository.promoteDueScheduledTasks("2026-04-01"),
  ];

  it.each([1, 2, 3, 4, 5, 6])(
    "seed %i: a random operation sequence on two repositories",
    async (seed) => {
      const [a, b] = [await open(), await open()];
      for (const [index, opened] of [a, b].entries()) {
        const rnd = prng(seed * 101 + index);
        for (let step = 0; step < 40; step += 1) {
          const operation = operations[Math.floor(rnd() * operations.length)];
          try {
            await operation?.(opened, rnd, step);
          } catch {
            // Some random operations are legitimately invalid (undo of nothing, completing twice);
            // the invariants must hold regardless.
          }
          await assertInvariants(opened);
        }
      }
      // The two databases are independent: each has its own identity counter and clocks.
      expect(a.database).not.toBe(b.database);
    },
  );
});

describe("performance: a 1000-row finance import", () => {
  it("stamps every imported row (in the follow-up flush after the import) and costs little extra", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      importRow({
        postedDate: `2026-03-${String((i % 28) + 1).padStart(2, "0")}`,
        amountMinor: -(100 + i),
        descriptionRaw: `MERCHANT ${i}`,
        merchantKey: `MERCHANT ${i}`,
      }),
    );
    const timed = async (enable: boolean) => {
      const opened = await open({ enable });
      await opened.repository.saveFinanceAccount(account());
      const started = performance.now();
      const summary = await opened.repository.importFinanceTransactions({
        accountId: "account-1",
        profileId: null,
        fileName: "big.csv",
        fileHash: "big",
        rows,
      });
      return { opened, summary, ms: performance.now() - started };
    };
    const plain = await timed(false);
    const captured = await timed(true);
    expect(plain.summary.imported).toBe(1000);
    expect(captured.summary.imported).toBe(1000);
    expect(await readMeta(captured.opened.database, "finance_transactions")).toHaveLength(1000);
    expect(await readMarks(captured.opened.database)).toEqual([]);
    expect(await readMeta(plain.opened.database, "finance_transactions")).toEqual([]);
    console.info(
      `[sync-capture perf] 1000-row finance import: ${plain.ms.toFixed(0)} ms without capture, ${captured.ms.toFixed(0)} ms with capture`,
    );
    expect(captured.ms).toBeLessThan(15_000);
  });
});
