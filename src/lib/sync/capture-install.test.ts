// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertRegistryMatchesSchema,
  buildCaptureTriggers,
  buildTableCaptureTriggers,
  CAPTURE_TRIGGER_PREFIX,
  capturedTables,
  captureTriggerTables,
  disableSyncCapture,
  ensureSyncCapture,
  expectedCaptureHash,
  installSyncCapture,
  isCapturedTable,
  isSyncCaptureInstalled,
  readLiveSchema,
  SETTINGS_TABLE,
} from "./capture-install";
import { createCaptureDb, insertContext, readMarks, syncState } from "./capture-test-utils";
import { SYNC_DOMAINS, TABLE_REGISTRY } from "./registry";

const triggerRows = async (db: Awaited<ReturnType<typeof createCaptureDb>>) =>
  db.select<{ name: string; tbl_name: string; sql: string }[]>(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  );

describe("which tables are captured", () => {
  it("is every synced non-union, non-sidecar table of the gtd, personal and finance domains", () => {
    const expected = TABLE_REGISTRY.filter(
      (entry) =>
        (SYNC_DOMAINS as readonly string[]).includes(entry.domain) &&
        entry.mergeClass !== "grow-only-union" &&
        entry.mergeClass !== "sidecar",
    ).map((entry) => entry.table);
    expect(capturedTables().map((entry) => entry.table)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(25);
    expect(captureTriggerTables()).toEqual([...expected, SETTINGS_TABLE]);
  });

  it("never captures union tables, sidecars, device-local tables or the sync bookkeeping", () => {
    for (const table of [
      "gtd_task_events",
      "ai_messages",
      "sync_recurrence_occurrences",
      "sync_recurrence_clears",
      "sync_entity_meta",
      "sync_id_aliases",
      "sync_conflicts",
      "sync_identity",
      "sync_peers",
      "sync_dirty",
      "sync_entity_snapshot",
      "sync_capture_state",
      "schema_migrations",
      "rescuetime_snapshot_cache",
      "finance_alert_notifications",
      "calendar_sync_settings",
      "calendar_sync_links",
      "email_triage_accounts",
      "app_settings",
    ]) {
      expect(isCapturedTable(table)).toBe(false);
    }
    expect(isCapturedTable("not_a_table")).toBe(false);
  });
});

describe("generated trigger SQL", () => {
  it("covers every captured table and the settings blob, from the registry and the live schema", async () => {
    const db = await createCaptureDb({ capture: false });
    const schema = await readLiveSchema(db, captureTriggerTables());
    const triggers = buildCaptureTriggers(schema);
    const byTable = new Map<string, string[]>();
    for (const trigger of triggers) {
      expect(trigger.name.startsWith(CAPTURE_TRIGGER_PREFIX)).toBe(true);
      byTable.set(trigger.table, [...(byTable.get(trigger.table) ?? []), trigger.name]);
    }
    expect([...byTable.keys()].sort()).toEqual([...captureTriggerTables()].sort());
    for (const [table, names] of byTable) {
      expect(names).toHaveLength(table === SETTINGS_TABLE ? 2 : 3);
    }
    expect(triggers.map((trigger) => trigger.name)).toEqual(
      triggers.map((trigger) => trigger.name).sort(),
    );
  });

  it("builds single and composite keys, and guards on the identity row and the applying flag", () => {
    const [insert, update, remove] = buildTableCaptureTriggers("gtd_tasks", ["id"]);
    expect(insert?.sql).toContain('AFTER INSERT ON "gtd_tasks"');
    expect(insert?.sql).toContain("WHEN (SELECT applying FROM sync_identity WHERE id = 1) = 0");
    expect(insert?.sql).toContain('CAST(NEW."id" AS TEXT)');
    expect(update?.sql).toContain(
      '\'delete\' WHERE CAST(OLD."id" AS TEXT) IS NOT CAST(NEW."id" AS TEXT)',
    );
    expect(remove?.sql).toContain('CAST(OLD."id" AS TEXT)');
    const [compositeInsert] = buildTableCaptureTriggers("finance_merchant_memory", [
      "merchant_key",
      "account_id",
      "sign",
    ]);
    expect(compositeInsert?.sql).toContain(
      'json_array(NEW."merchant_key", NEW."account_id", NEW."sign")',
    );
  });

  it("rejects unsafe identifiers instead of interpolating them", () => {
    expect(() => buildTableCaptureTriggers("a;drop table x", ["id"])).toThrow(/Unsafe/);
    expect(() => buildTableCaptureTriggers("gtd_tasks", ['id"; DROP TABLE x; --'])).toThrow(
      /Unsafe/,
    );
  });

  it("is deterministic: the same schema gives the same SQL and the same hash", async () => {
    const first = await createCaptureDb({ capture: false });
    const second = await createCaptureDb({ capture: false });
    const build = async (db: typeof first) => {
      const schema = await readLiveSchema(db, captureTriggerTables());
      const triggers = buildCaptureTriggers(schema);
      return { triggers, hash: expectedCaptureHash(schema, triggers) };
    };
    const a = await build(first);
    const b = await build(second);
    const again = await build(first);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(again.hash);
    expect(a.triggers).toEqual(b.triggers);
    expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes the hash when a captured table gains a column", async () => {
    const db = await createCaptureDb({ capture: false });
    const hashNow = async () => {
      const schema = await readLiveSchema(db, captureTriggerTables());
      return expectedCaptureHash(schema, buildCaptureTriggers(schema));
    };
    const before = await hashNow();
    await db.execute("ALTER TABLE gtd_contexts ADD COLUMN color TEXT");
    expect(await hashNow()).not.toBe(before);
  });
});

describe("registry versus live schema", () => {
  it("accepts the real primary keys of every captured table", async () => {
    const db = await createCaptureDb({ capture: false });
    const schema = await readLiveSchema(db, captureTriggerTables());
    for (const table of captureTriggerTables()) {
      expect(() => assertRegistryMatchesSchema(table, schema.get(table))).not.toThrow();
    }
  });

  it("fails loudly on a primary-key mismatch or a missing table", async () => {
    expect(() =>
      assertRegistryMatchesSchema("gtd_tasks", { columns: ["id", "title"], primaryKey: ["title"] }),
    ).toThrow(/registry primary key of "gtd_tasks" is \(id\) but the database has \(title\)/);
    expect(() =>
      assertRegistryMatchesSchema("weekly_objective_results", {
        columns: ["week_start_date", "objective_id"],
        primaryKey: ["objective_id", "week_start_date"],
      }),
    ).toThrow(/registry primary key/);
    expect(() => assertRegistryMatchesSchema("gtd_tasks", undefined)).toThrow(/does not exist/);

    const db = await createCaptureDb({ capture: false });
    await db.execute("DROP TABLE finance_budget_months");
    await expect(installSyncCapture(db)).rejects.toThrow(
      /table "finance_budget_months" does not exist/,
    );
    expect(await triggerRows(db)).toEqual([]);
    expect(await isSyncCaptureInstalled(db)).toBe(false);
  });
});

describe("installSyncCapture", () => {
  it("creates one trigger per generated entry and records the installed hash", async () => {
    const db = await createCaptureDb({ capture: false });
    expect(await triggerRows(db)).toEqual([]);
    const result = await installSyncCapture(db, new Date("2026-10-18T12:00:00.000Z"));
    const rows = await triggerRows(db);
    expect(rows).toHaveLength(result.triggerCount);
    expect(rows.every((row) => row.name.startsWith(CAPTURE_TRIGGER_PREFIX))).toBe(true);
    expect(
      await db.select("SELECT id, installed_hash, installed_at FROM sync_capture_state"),
    ).toEqual([
      { id: 1, installed_hash: result.installedHash, installed_at: "2026-10-18T12:00:00.000Z" },
    ]);
    expect(await isSyncCaptureInstalled(db)).toBe(true);
    const tables = new Set(rows.map((row) => row.tbl_name));
    expect(tables.has("gtd_task_events")).toBe(false);
    expect(tables.has("ai_messages")).toBe(false);
    expect(tables.has("sync_entity_meta")).toBe(false);
    expect(tables.has("gtd_tasks")).toBe(true);
    expect(tables.has("app_settings")).toBe(true);
  });

  it("is idempotent: reinstalling gives the same triggers and one state row", async () => {
    const db = await createCaptureDb({ capture: false });
    const first = await installSyncCapture(db);
    const before = await triggerRows(db);
    const second = await installSyncCapture(db);
    expect(second).toEqual(first);
    expect(await triggerRows(db)).toEqual(before);
    expect(await db.select("SELECT COUNT(*) AS n FROM sync_capture_state")).toEqual([{ n: 1 }]);
  });

  it("leaves foreign triggers alone and only replaces its own", async () => {
    const db = await createCaptureDb({ capture: false });
    await db.execute(
      "CREATE TRIGGER trg_user_audit AFTER INSERT ON gtd_contexts BEGIN SELECT 1; END",
    );
    await installSyncCapture(db);
    await installSyncCapture(db);
    expect((await triggerRows(db)).some((row) => row.name === "trg_user_audit")).toBe(true);
    await disableSyncCapture(db);
    expect((await triggerRows(db)).map((row) => row.name)).toEqual(["trg_user_audit"]);
  });
});

describe("ensureSyncCapture", () => {
  it("does nothing, and creates nothing, when capture was never enabled", async () => {
    const db = await createCaptureDb({ capture: false });
    expect(await ensureSyncCapture(db)).toEqual({ state: "disabled" });
    expect(await triggerRows(db)).toEqual([]);
    expect(await isSyncCaptureInstalled(db)).toBe(false);
  });

  it("reports current when nothing drifted and writes nothing", async () => {
    const db = await createCaptureDb();
    const before = await triggerRows(db);
    const result = await ensureSyncCapture(db);
    expect(result.state).toBe("current");
    expect(await triggerRows(db)).toEqual(before);
  });

  it("repairs a dropped trigger", async () => {
    const db = await createCaptureDb();
    const before = await triggerRows(db);
    await db.execute(`DROP TRIGGER "${CAPTURE_TRIGGER_PREFIX}gtd_tasks_au"`);
    expect(await triggerRows(db)).toHaveLength(before.length - 1);
    const result = await ensureSyncCapture(db);
    expect(result.state).toBe("reinstalled");
    expect(await triggerRows(db)).toEqual(before);
  });

  it("repairs a table rebuilt by a migration (same columns, triggers gone with the old table)", async () => {
    const db = await createCaptureDb();
    await db.execute("ALTER TABLE gtd_contexts RENAME TO gtd_contexts_old");
    await db.execute(
      "CREATE TABLE gtd_contexts (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    await db.execute("DROP TABLE gtd_contexts_old");
    const names = (await triggerRows(db)).map((row) => row.name);
    expect(names.some((name) => name.includes("gtd_contexts"))).toBe(false);
    expect((await ensureSyncCapture(db)).state).toBe("reinstalled");
    expect(
      (await triggerRows(db))
        .filter((row) => row.tbl_name === "gtd_contexts")
        .map((row) => row.name),
    ).toHaveLength(3);
    await insertContext(db, "c1");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
    ]);
  });

  it("reinstalls when a column was added, and when the stored hash is stale", async () => {
    const db = await createCaptureDb();
    await db.execute("ALTER TABLE gtd_contexts ADD COLUMN color TEXT");
    expect((await ensureSyncCapture(db)).state).toBe("reinstalled");
    expect((await ensureSyncCapture(db)).state).toBe("current");
    await db.execute("UPDATE sync_capture_state SET installed_hash = 'stale'");
    expect((await ensureSyncCapture(db)).state).toBe("reinstalled");
    expect((await ensureSyncCapture(db)).state).toBe("current");
  });

  it("removes stray capture-prefixed triggers that are not in the expected set", async () => {
    const db = await createCaptureDb();
    await db.execute(
      `CREATE TRIGGER "${CAPTURE_TRIGGER_PREFIX}gtd_task_events_ai" AFTER INSERT ON gtd_task_events BEGIN SELECT 1; END`,
    );
    expect((await ensureSyncCapture(db)).state).toBe("reinstalled");
    expect((await triggerRows(db)).some((row) => row.tbl_name === "gtd_task_events")).toBe(false);
  });
});

describe("disableSyncCapture", () => {
  it("drops the triggers, the marks and the state, and keeps the history", async () => {
    const db = await createCaptureDb();
    await db.execute(
      "INSERT INTO sync_entity_meta (entity_type, entity_id, row_hlc) VALUES ('gtd_contexts', 'c1', 'h')",
    );
    await db.execute("INSERT INTO sync_entity_snapshot VALUES ('gtd_contexts', 'c1', '{}', NULL)");
    await insertContext(db, "c2");
    expect(await readMarks(db)).toHaveLength(1);
    const result = await disableSyncCapture(db);
    expect(result.droppedTriggers).toBeGreaterThan(50);
    expect(await triggerRows(db)).toEqual([]);
    expect(await isSyncCaptureInstalled(db)).toBe(false);
    expect(await readMarks(db)).toEqual([]);
    const state = await syncState(db);
    expect(state.meta).toHaveLength(1);
    expect(state.snapshots).toHaveLength(1);
    expect(state.identity?.change_counter).toBe(0);
    // Disabled means inert: no new marks.
    await insertContext(db, "c3");
    expect(await readMarks(db)).toEqual([]);
  });
});
