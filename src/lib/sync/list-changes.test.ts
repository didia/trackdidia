// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { FinanceAccount, FinanceImportRow } from "../../domain/finance";
import type { AiMemory, AnnualGoal } from "../../domain/types";
// SAFETY: every repository here is backed by an isolated `:memory:` SQLite database.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import type { Database } from "../storage/sqlite-db";
import { TauriSqliteRepository } from "../storage/tauri-sqlite-repository";
import { type SyncChangeSet, validateChangeSet } from "./change-set";
import { SyncClockError } from "./clock-store";
import { compareHlc, parseHlc } from "./hlc";
import { settingsKeysInScope, SYNC_DOMAINS, tablesInDomain } from "./registry";
import { strategyForTable } from "./merge-strategies";
import { createSyncHarness, type SyncDevice } from "./test-support/two-device-harness";

const SECRETS = {
  aiApiKey: "sk-or-v1-SECRET-OPENROUTER",
  rescuetimeApiKey: "RESCUETIME-SECRET-KEY",
  llmBridgeToken: "BRIDGE-SECRET-TOKEN",
  backupDestinationDir: "/Users/someone/Google Drive/PRIVATE-BACKUPS",
  aiBaseUrl: "https://user:PASSWORD-IN-URL@llm.internal.example/v1",
};

const account = (): FinanceAccount => ({
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
});

const importRow = (): FinanceImportRow => ({
  accountId: "account-1",
  postedDate: "2026-04-01",
  amountMinor: -1234,
  currency: "CAD",
  descriptionRaw: "SECRET MERCHANT FINANCE ROW",
  descriptionOriginal: null,
  merchantKey: "SECRET MERCHANT",
  categoryHint: null,
  personId: null,
  notes: null,
  labelsJson: null,
  sourceRowJson: null,
});

const goal: AnnualGoal = {
  id: "goal-1",
  title: "PERSONAL GOAL TITLE",
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
  progressLog: {},
  milestones: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memory = (): AiMemory => ({
  id: "memory-1",
  kind: "preference",
  statement: "PERSONAL MEMORY STATEMENT",
  detail: "",
  confidence: 0.9,
  source: "ai_extracted",
  status: "active",
  evidenceFrom: null,
  evidenceTo: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  lastConfirmedAt: "2026-04-01T00:00:00.000Z",
  expiresAt: null,
  pinned: false,
});

/** A laptop holding data in every domain, plus secrets and device settings. */
const fullLaptop = async (): Promise<SyncDevice> => {
  const sim = await createSyncHarness(["A"]);
  const a = sim.device("A");
  await a.repo.updateSettings((current) => ({
    ...current,
    ...SECRETS,
    language: "fr",
    aiModel: "vendor/model-a",
    financeEnabled: true,
    financeBaseCurrency: "CAD",
    gtdImportDoneAt: "2026-10-01T00:00:00.000Z",
  }));
  await a.repo.createTask({
    id: "task-1",
    title: "GTD TASK TITLE",
    bucket: "inbox",
    contextIds: ["home"],
  });
  await a.repo.completeTask("task-1");
  await a.repo.saveDailyEntry({
    ...createEmptyDailyEntry("2026-04-01"),
    morningIntention: "PERSONAL JOURNAL",
  });
  await a.repo.saveAnnualGoal(goal);
  await a.repo.saveAiMemory(memory());
  await a.repo.saveFinanceAccount(account());
  await a.repo.importFinanceTransactions({
    accountId: "account-1",
    profileId: null,
    fileName: "a.csv",
    fileHash: "h",
    rows: [importRow()],
  });
  await a.repo.startPomodoro({ taskId: "task-1" });
  return a;
};

const tablesOf = (changeSet: SyncChangeSet): string[] => [
  ...new Set([
    ...changeSet.entities.map((entity) => entity.table),
    ...Object.keys(changeSet.unionRows),
  ]),
];

describe("listSyncChanges: privacy guards", () => {
  it("a gtd change set holds no row of any non-gtd table", async () => {
    const a = await fullLaptop();
    const changeSet = await a.repo.listSyncChanges("gtd");
    const gtdTables = new Set(tablesInDomain("gtd"));
    expect(tablesOf(changeSet).length).toBeGreaterThan(0);
    for (const table of tablesOf(changeSet)) {
      expect(gtdTables.has(table), table).toBe(true);
    }
    const text = JSON.stringify(changeSet);
    for (const needle of [
      "PERSONAL JOURNAL",
      "PERSONAL GOAL TITLE",
      "PERSONAL MEMORY STATEMENT",
      "SECRET MERCHANT",
      "Compte chèques",
    ]) {
      expect(text, needle).not.toContain(needle);
    }
    expect(text).toContain("GTD TASK TITLE");
  });

  it("no change set of any domain contains a secret or a device setting", async () => {
    const a = await fullLaptop();
    for (const domain of SYNC_DOMAINS) {
      const changeSet = await a.repo.listSyncChanges(domain);
      const text = JSON.stringify(changeSet);
      for (const secret of Object.values(SECRETS)) {
        expect(text, `${domain}: ${secret}`).not.toContain(secret);
      }
      const keys = new Set(settingsKeysInScope(domain));
      for (const entry of changeSet.settings) {
        expect(keys.has(entry.key as never), `${domain}: ${entry.key}`).toBe(true);
      }
      const keyNames = changeSet.settings.map((entry) => entry.key);
      for (const forbidden of Object.keys(SECRETS)) {
        expect(keyNames).not.toContain(forbidden);
      }
    }
  });

  it("publishes each domain's own synced settings, with their clocks, and only stamped keys", async () => {
    const a = await fullLaptop();
    const gtd = await a.repo.listSyncChanges("gtd");
    const personal = await a.repo.listSyncChanges("personal");
    const finance = await a.repo.listSyncChanges("finance");
    expect(gtd.settings.map((entry) => entry.key)).toContain("gtdImportDoneAt");
    expect(gtd.settings.find((entry) => entry.key === "gtdImportDoneAt")?.value).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(personal.settings.map((entry) => entry.key)).toContain("aiModel");
    expect(finance.settings.map((entry) => entry.key)).toEqual(["financeEnabled"]);
    // A key nobody changed has no clock and is not published.
    expect(personal.settings.map((entry) => entry.key)).not.toContain("aiMaxTokens");
    for (const entry of [...gtd.settings, ...personal.settings, ...finance.settings]) {
      expect(parseHlc(entry.rowHlc)).not.toBeNull();
    }
  });

  it("publishes the finance tables and AI memories, but never a device-local table or a derived snapshot", async () => {
    const a = await fullLaptop();
    const finance = await a.repo.listSyncChanges("finance");
    expect(tablesOf(finance)).toEqual(
      expect.arrayContaining([
        "finance_accounts",
        "finance_transactions",
        "finance_import_batches",
      ]),
    );
    const personal = await a.repo.listSyncChanges("personal");
    expect(tablesOf(personal)).toContain("ai_memories");
    const gtd = await a.repo.listSyncChanges("gtd");
    for (const changeSet of [finance, personal, gtd]) {
      for (const table of tablesOf(changeSet)) {
        expect(strategyForTable(table), table).not.toBeNull();
      }
    }
    // The device-local notification table is never read, and the derived snapshots stay home.
    await a.repo.snapshotFinanceAccountBalances("2026-04-02");
    const derived = await a.db.select(
      "SELECT 1 FROM finance_account_balance_snapshots WHERE source = 'derived'",
    );
    expect(derived).not.toEqual([]);
    const again = await a.repo.listSyncChanges("finance");
    expect(tablesOf(again)).not.toContain("finance_account_balance_snapshots");
    expect(tablesOf(again)).not.toContain("finance_alert_notifications");
  });

  it("publishes the personal field-clock tables and the union tables of each domain", async () => {
    const a = await fullLaptop();
    const personal = await a.repo.listSyncChanges("personal");
    expect(tablesOf(personal)).toEqual(expect.arrayContaining(["annual_goals", "daily_entries"]));
    const gtd = await a.repo.listSyncChanges("gtd");
    expect(tablesOf(gtd)).toEqual(
      expect.arrayContaining(["gtd_tasks", "gtd_contexts", "gtd_task_events"]),
    );
    expect((gtd.unionRows.gtd_task_events ?? []).length).toBeGreaterThan(0);
  });
});

describe("listSyncChanges: shape and consistency", () => {
  it("returns a validated, JSON-safe, deterministic full state with hlcHigh = the newest clock", async () => {
    const a = await fullLaptop();
    for (const domain of SYNC_DOMAINS) {
      const first = await a.repo.listSyncChanges(domain);
      const second = await a.repo.listSyncChanges(domain);
      expect(second).toEqual(first);
      expect(validateChangeSet(JSON.parse(JSON.stringify(first)))).toEqual(first);
      expect(first).toMatchObject({
        formatVersion: 1,
        domain,
        deviceId: a.deviceId,
        schemaVersion: 43,
      });
    }
    const gtd = await a.repo.listSyncChanges("gtd");
    const clocks = [
      ...gtd.entities.flatMap((entity) => [entity.rowHlc, ...Object.values(entity.fieldClocks)]),
      ...gtd.settings.map((entry) => entry.rowHlc),
    ];
    expect(clocks.sort().at(-1)).toBe(gtd.hlcHigh);
    for (const clock of clocks) expect(compareHlc(clock, gtd.hlcHigh)).toBeLessThanOrEqual(0);
  });

  it("reports the device's own clock when there is nothing to publish", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.device("A");
    const empty = await a.repo.listSyncChanges("finance");
    // A fresh database holds only the three system categories migration 37 inserts.
    expect(empty).toMatchObject({ unionRows: {}, settings: [] });
    expect(empty.entities.map((entity) => [entity.table, entity.entityId])).toEqual(
      [
        ["finance_categories", "fincat:non-categorise"],
        ["finance_categories", "fincat:transfert"],
        ["finance_categories", "fincat:split"],
      ].sort((x, y) => ((x[1] as string) < (y[1] as string) ? -1 : 1)),
    );
    expect(parseHlc(empty.hlcHigh)?.deviceId).toBe(a.deviceId);
  });

  it("publishes a tombstone as an entity with no row", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.device("A");
    await a.repo.saveAnnualGoal(goal);
    await a.repo.deleteAnnualGoal("goal-1");
    const personal = await a.repo.listSyncChanges("personal");
    const tombstone = personal.entities.find((entity) => entity.entityId === "goal-1");
    expect(tombstone).toMatchObject({ table: "annual_goals", row: null });
    expect(tombstone?.deletedAt).not.toBeNull();
  });

  it("does not publish a row that was never stamped (capture off)", async () => {
    const sim = await createSyncHarness(["A"], { enableCapture: false });
    const a = sim.device("A");
    await a.repo.createTask({ id: "t1", title: "Unstamped", bucket: "inbox" });
    const gtd = await a.repo.listSyncChanges("gtd");
    expect(gtd.entities).toEqual([]);
    await a.repo.enableSyncCapture();
    expect(
      (await a.repo.listSyncChanges("gtd")).entities.map((entity) => entity.entityId),
    ).toContain("t1");
  });

  it("needs the sync identity", async () => {
    const database = createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();
    await expect(repository.listSyncChanges("gtd")).rejects.toBeInstanceOf(SyncClockError);
  });

  it("rejects an unknown domain", async () => {
    const sim = await createSyncHarness(["A"]);
    await expect(sim.device("A").repo.listSyncChanges("device" as never)).rejects.toThrow(
      /Unknown sync domain/,
    );
  });

  it("only reads: every statement is a SELECT and nothing about the sync state changes", async () => {
    const database: Database = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
    const statements: string[] = [];
    const execute = database.execute.bind(database);
    const select = database.select.bind(database);
    let recording = false;
    database.execute = ((query: string, values?: unknown[]) => {
      if (recording) statements.push(query);
      return execute(query, values);
    }) as Database["execute"];
    database.select = ((query: string, values?: unknown[]) => {
      if (recording) statements.push(query);
      return select(query, values);
    }) as Database["select"];
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();
    await repository.ensureSyncIdentity({
      deviceId: "dev:00000000-0000-4000-8000-000000000009",
      deviceName: "R",
    });
    await repository.enableSyncCapture();
    await repository.createTask({ id: "t1", title: "x", bucket: "inbox" });
    await repository.saveAnnualGoal(goal);

    const state = await Promise.all(
      [
        "sync_entity_meta",
        "sync_entity_snapshot",
        "sync_dirty",
        "sync_identity",
        "sync_conflicts",
      ].map((table) => database.select(`SELECT * FROM ${table}`)),
    );
    recording = true;
    for (const domain of SYNC_DOMAINS) await repository.listSyncChanges(domain);
    recording = false;

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.trimStart().toUpperCase(), statement).toMatch(/^SELECT/);
    }
    expect(
      await Promise.all(
        [
          "sync_entity_meta",
          "sync_entity_snapshot",
          "sync_dirty",
          "sync_identity",
          "sync_conflicts",
        ].map((table) => database.select(`SELECT * FROM ${table}`)),
      ),
    ).toEqual(state);
  });
});
