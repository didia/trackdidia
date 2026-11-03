// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bootstrapApplication } from "../../app/bootstrap";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
// SAFETY: every repository here is backed by an isolated `:memory:` SQLite database.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { ENTITY_TYPED_SIDECARS } from "../sync/profile-data";
import { SYNC_DOMAINS } from "../sync/registry";
import { financeAccount } from "../sync/test-support/finance-fixtures";
import { annualGoal } from "../sync/test-support/personal-fixtures";
import { createSyncDevice, type SyncDevice } from "../sync/test-support/two-device-harness";
import { MemoryRepository } from "./memory-repository";
import type { Database } from "./sqlite-db";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const device = (options: { enableCapture?: boolean } = {}): Promise<SyncDevice> =>
  createSyncDevice("Probe", 0, options);

const rawMeta = (db: Database, entityType: string, entityId: string) =>
  db.execute(
    `INSERT INTO sync_entity_meta (entity_type, entity_id, field_clocks_json, row_hlc)
     VALUES ($1, $2, '{}', '0000000000001-0000-dev')`,
    [entityType, entityId],
  );

describe("inspectSyncProfileData on a database that never held anything of the user's", () => {
  it("is empty before capture, with the 3 seeded finance categories whitelisted", async () => {
    const probe = await device({ enableCapture: false });
    for (const exact of [true, false]) {
      const inspection = await probe.repo.inspectSyncProfileData({ exact });
      expect(inspection.counts).toEqual({ gtd: 0, personal: 0, finance: 0 });
      expect(inspection.sources).toEqual([]);
      expect(inspection.exact).toBe(exact);
    }
    const seeded = await probe.db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM finance_categories",
    );
    expect(Number(seeded[0]?.n)).toBe(3);
  });

  it("is still empty once capture gave every seed row a clock and a snapshot", async () => {
    const probe = await device();
    const meta = await probe.db.select<{ entity_type: string; entity_id: string }[]>(
      "SELECT entity_type, entity_id FROM sync_entity_meta ORDER BY 1, 2",
    );
    // The seeds really are in the sidecars (otherwise this test proves nothing).
    expect(meta.map((row) => `${row.entity_type}:${row.entity_id}`)).toEqual(
      expect.arrayContaining([
        "finance_categories:fincat:split",
        "finance_categories:fincat:transfert",
        "finance_categories:fincat:non-categorise",
        "setting:dimancheNotesRelocatedAt",
      ]),
    );
    const snapshots = await probe.db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM sync_entity_snapshot WHERE entity_type = 'finance_categories'",
    );
    expect(Number(snapshots[0]?.n)).toBe(3);
    expect((await probe.repo.inspectSyncProfileData()).counts).toEqual({
      gtd: 0,
      personal: 0,
      finance: 0,
    });
  });

  it("stays empty of personal and finance after a first bootstrap (only gtd draw rows appear)", async () => {
    const probe = await device();
    await bootstrapApplication(probe.repo);
    await probe.stamp();
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.personal).toBe(0);
    expect(inspection.counts.finance).toBe(0);
    expect(inspection.counts.gtd).toBeGreaterThan(0);
  });

  it("whitelists the default finance taxonomy once finance was enabled and seeded", async () => {
    const probe = await device();
    await probe.repo.seedFinanceDefaultCategories();
    await probe.repo.updateSettings((current) => ({
      ...current,
      financeCategoriesSeededAt: "2026-11-02T00:00:00.000Z",
    }));
    await probe.stamp();
    const rows = await probe.db.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM finance_categories",
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(3);
    expect((await probe.repo.inspectSyncProfileData()).counts.finance).toBe(0);
  });
});

describe("inspectSyncProfileData finds user data", () => {
  it("counts the rows of a personal table and its sidecars", async () => {
    const probe = await device();
    await probe.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.personal).toBeGreaterThanOrEqual(3); // row + meta + snapshot
    expect(inspection.counts.finance).toBe(0);
    expect(inspection.sources.map((source) => source.source)).toEqual(
      expect.arrayContaining(["daily_entries", "sync_entity_meta:personal entities"]),
    );
  });

  it("counts a finance account", async () => {
    const probe = await device();
    await probe.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.finance).toBeGreaterThanOrEqual(3);
    expect(inspection.counts.personal).toBe(0);
  });

  it("counts a gtd task as gtd and nothing else", async () => {
    const probe = await device();
    await probe.repo.createTask({ id: "t1", title: "A task", bucket: "inbox" });
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.gtd).toBeGreaterThan(0);
    expect(inspection.counts.personal + inspection.counts.finance).toBe(0);
  });

  it("finds a personal row that survives only as a sidecar (the deleted row's tombstone)", async () => {
    const probe = await device();
    await probe.repo.saveAnnualGoal(annualGoal({ id: "goal-1", title: "Secret goal" }));
    await probe.repo.deleteAnnualGoal("goal-1");
    // Emptied by hand: no table row is left, but the tombstone keeps the deleted values.
    await probe.db.execute("DELETE FROM sync_entity_snapshot");
    await probe.db.execute("DELETE FROM sync_dirty");
    const goals = await probe.db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM annual_goals");
    expect(Number(goals[0]?.n)).toBe(0);
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.personal).toBe(1);
    expect(inspection.sources).toEqual([
      { domain: "personal", source: "sync_entity_meta:personal entities", count: 1 },
    ]);
  });

  it("finds a sidecar row in every entity-typed sidecar table, each routed by its entity type", async () => {
    for (const sidecar of ENTITY_TYPED_SIDECARS) {
      const probe = await device({ enableCapture: false });
      await probe.db.execute("PRAGMA foreign_keys = OFF");
      const columns = await probe.db.select<
        { name: string; notnull: number; dflt_value: unknown }[]
      >(`SELECT name, "notnull", dflt_value FROM pragma_table_info('${sidecar.table}')`);
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        if (column.name === "entity_type") values[column.name] = "weekly_reviews";
        else if (column.notnull === 1 && column.dflt_value === null) values[column.name] = "x";
        else if (column.name === sidecar.idColumn) values[column.name] = "x";
      }
      const names = Object.keys(values);
      await probe.db.execute(
        `INSERT INTO ${sidecar.table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((name) => values[name]),
      );
      const inspection = await probe.repo.inspectSyncProfileData();
      expect(inspection.counts, sidecar.table).toEqual({ gtd: 0, personal: 1, finance: 0 });
    }
  });

  it("routes sidecar rows by entity type and, for settings, by key", async () => {
    const probe = await device();
    await rawMeta(probe.db, "finance_transactions", "tx-1");
    await rawMeta(probe.db, "gtd_tasks", "task-1");
    await rawMeta(probe.db, "setting", "aiModel");
    await rawMeta(probe.db, "setting", "language");
    await rawMeta(probe.db, "setting", "aiApiKey"); // device-local: belongs to no domain
    await rawMeta(probe.db, "table_from_a_newer_build", "x"); // unknown: the private side
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts).toEqual({ gtd: 2, personal: 2, finance: 1 });
  });

  it("whitelists the seeded finance categories by id only", async () => {
    const probe = await device();
    // The seeds already carry clock and snapshot rows (capture gave them): nothing.
    expect((await probe.repo.inspectSyncProfileData()).counts.finance).toBe(0);
    await rawMeta(probe.db, "finance_categories", "fincat:mine");
    expect((await probe.repo.inspectSyncProfileData()).counts.finance).toBe(1);
    await probe.db.execute(
      `INSERT INTO finance_categories (id, name, kind, is_system, sort_order, created_at, updated_at)
       VALUES ('fincat:mine', 'Mine', 'expense', 0, 9, 'x', 'x')`,
    );
    // The row itself, its clock, and the capture trigger's mark.
    expect((await probe.repo.inspectSyncProfileData()).counts.finance).toBe(3);
  });

  it("counts a personal setting that was changed, and not the markers the app writes itself", async () => {
    const probe = await device();
    await probe.repo.updateSettings((current) => ({
      ...current,
      aiMaxTokensUpgradeDoneAt: "2026-11-02T00:00:00.000Z",
      relationshipDrawChildrenProcessedDate: "2026-11-02",
    }));
    expect((await probe.repo.inspectSyncProfileData()).counts).toEqual({
      gtd: 0,
      personal: 0,
      finance: 0,
    });
    await probe.repo.updateSettings((current) => ({ ...current, aiEnabled: true }));
    const inspection = await probe.repo.inspectSyncProfileData();
    expect(inspection.counts.personal).toBeGreaterThanOrEqual(1);
    expect(inspection.sources.map((source) => source.source)).toContain("app_settings:aiEnabled");
  });

  it("counts a sync_conflicts row about a personal entity", async () => {
    const probe = await device();
    await probe.db.execute(
      `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
       VALUES ('c1', 'weekly_reviews', 'w1', 'overwritten_edit', '{}', '{}', 'x')`,
    );
    expect((await probe.repo.inspectSyncProfileData()).counts.personal).toBe(1);
  });
});

describe("inspectSyncProfileData options", () => {
  it("looks only at the domains it is asked for", async () => {
    const probe = await device();
    await probe.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await probe.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));
    const onlyFinance = await probe.repo.inspectSyncProfileData({ domains: ["finance"] });
    expect(onlyFinance.counts.personal).toBe(0);
    expect(onlyFinance.counts.finance).toBeGreaterThan(0);
    expect(onlyFinance.sources.every((source) => source.domain === "finance")).toBe(true);
  });

  it("with exact: false stops at the first row of each source and never counts", async () => {
    const probe = await device();
    for (let day = 1; day <= 9; day += 1) {
      await probe.repo.saveDailyEntry(createEmptyDailyEntry(`2026-10-0${day}`));
    }
    const exact = await probe.repo.inspectSyncProfileData({ domains: ["personal", "finance"] });
    expect(exact.counts.personal).toBeGreaterThan(20);

    const queries: string[] = [];
    const select = probe.db.select.bind(probe.db);
    probe.db.select = ((query: string, values?: unknown[]) => {
      queries.push(query);
      return select(query, values);
    }) as Database["select"];
    const quick = await probe.repo.inspectSyncProfileData({
      domains: ["personal", "finance"],
      exact: false,
    });
    expect(quick.exact).toBe(false);
    expect(quick.counts.personal).toBeGreaterThan(0);
    // Every look at a table or a sidecar is a one-row probe: no COUNT over the data.
    const probes = queries.filter((query) => /FROM "?(\w+)"?\s+WHERE/.test(query));
    expect(probes.length).toBeGreaterThan(20);
    for (const query of queries) {
      if (query.includes("GROUP BY")) continue; // the settings keys: a handful of rows
      if (query.includes("app_settings")) continue;
      expect(query, query).not.toMatch(/COUNT\(/);
      expect(query, query).toMatch(/LIMIT 1/);
    }
  });

  it("is cheap on a database with many personal rows: statements do not grow with the data", async () => {
    const small = await device();
    const large = await device();
    await large.db.execute("PRAGMA foreign_keys = OFF");
    // 3,000 finance people (a plain table): enough rows to see a scan, few columns to insert.
    for (let start = 0; start < 3000; start += 500) {
      const rows = Array.from({ length: 500 }, (_, i) => `('p${start + i}', 'N', 0, 'x', 'x')`);
      await large.db.execute(
        `INSERT INTO finance_people (id, display_name, archived, created_at, updated_at) VALUES ${rows.join(", ")}`,
      );
    }
    const countStatements = async (probe: SyncDevice) => {
      let statements = 0;
      const select = probe.db.select.bind(probe.db);
      probe.db.select = ((query: string, values?: unknown[]) => {
        statements += 1;
        return select(query, values);
      }) as Database["select"];
      await probe.repo.inspectSyncProfileData({ domains: ["personal", "finance"], exact: false });
      return statements;
    };
    expect(await countStatements(large)).toBe(await countStatements(small));
  });
});

describe("the entity-typed sidecar list", () => {
  it("names every table of the migrated schema that has an entity_type column", async () => {
    const db = createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
    await repository.initialize();
    const tables = await db.select<{ name: string }[]>(
      `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
       WHERE m.type = 'table' AND c.name = 'entity_type' ORDER BY m.name`,
    );
    expect(tables.map((table) => table.name).sort()).toEqual(
      ENTITY_TYPED_SIDECARS.map((sidecar) => sidecar.table).sort(),
    );
    for (const sidecar of ENTITY_TYPED_SIDECARS) {
      const columns = await db.select<{ name: string }[]>(
        `SELECT name FROM pragma_table_info('${sidecar.table}')`,
      );
      expect(columns.map((column) => column.name)).toContain(sidecar.idColumn);
    }
  });
});

describe("browser preview parity", () => {
  it("MemoryRepository follows the sync-unavailable convention", async () => {
    const memory = new MemoryRepository();
    await memory.initialize();
    await expect(memory.inspectSyncProfileData()).rejects.toThrow(/browser preview|navigateur/i);
  });

  it("looks at all three domains by default", () => {
    expect(SYNC_DOMAINS).toEqual(["gtd", "personal", "finance"]);
  });
});
