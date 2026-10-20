// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createCaptureDb,
  insertContext,
  insertTask,
  readMarks,
  readMeta,
  stampedTransaction,
  syncState,
} from "./capture-test-utils";

/**
 * The triggers only record WHAT changed. These tests pin the dirty marks they write for every kind
 * of SQL statement the repository uses, and when they must stay silent.
 */
describe("capture triggers write dirty marks", () => {
  it("marks an insert as an upsert, with the primary key as the entity id", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "context:maison");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "context:maison", op: "upsert" },
    ]);
  });

  it("marks an update as an upsert and a delete as a delete", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "c1");
    await db.execute("DELETE FROM sync_dirty");
    await db.execute("UPDATE gtd_contexts SET name = 'renamed' WHERE id = 'c1'");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
    ]);
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "delete" },
    ]);
  });

  it("lets a delete win over an earlier upsert in the same transaction", async () => {
    const db = await createCaptureDb();
    await db.execute("BEGIN IMMEDIATE");
    await insertContext(db, "c1");
    await db.execute("UPDATE gtd_contexts SET name = 'x' WHERE id = 'c1'");
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    await db.execute("COMMIT");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "delete" },
    ]);
  });

  it("turns a delete back into an upsert when the row is re-inserted later in the transaction", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "c1");
    await db.execute("DELETE FROM sync_dirty");
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    await insertContext(db, "c1", "again");
    await db.execute("COMMIT");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
    ]);
  });

  it("encodes composite keys as a JSON array in key order", async () => {
    const db = await createCaptureDb();
    await db.execute(
      `INSERT INTO finance_merchant_memory
        (merchant_key, account_id, sign, category_id, source, created_at, updated_at)
       VALUES ('cafe "du coin"', 'acc-1', -1, 'cat', 'user', 't', 't')`,
    );
    await db.execute(
      "INSERT INTO weekly_objective_results (week_start_date, objective_id, achieved, updated_at) VALUES ('2026-10-04', 'obj-1', 1, 't')",
    );
    expect(await readMarks(db)).toEqual([
      {
        entity_type: "finance_merchant_memory",
        entity_id: '["cafe \\"du coin\\"","acc-1",-1]',
        op: "upsert",
      },
      {
        entity_type: "weekly_objective_results",
        entity_id: '["2026-10-04","obj-1"]',
        op: "upsert",
      },
    ]);
  });

  it("marks the old key deleted and the new key upserted when a key is rewritten", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "old");
    await db.execute("DELETE FROM sync_dirty");
    await db.execute("UPDATE gtd_contexts SET id = 'new' WHERE id = 'old'");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "new", op: "upsert" },
      { entity_type: "gtd_contexts", entity_id: "old", op: "delete" },
    ]);
  });

  it("fires the insert branch of INSERT ... ON CONFLICT DO UPDATE for a new row and the update branch for an existing one", async () => {
    const db = await createCaptureDb();
    const upsert = (name: string) =>
      db.execute(
        `INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('c1', $1, 't', 't')
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        [name],
      );
    await upsert("first");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
    ]);
    await db.execute("DELETE FROM sync_dirty");
    await upsert("second");
    expect(await readMarks(db)).toEqual([
      { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
    ]);
    expect(await db.select("SELECT name FROM gtd_contexts")).toEqual([{ name: "second" }]);
  });

  it("stays silent for INSERT OR IGNORE that inserts nothing, and for ON CONFLICT DO NOTHING", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "c1");
    await db.execute("DELETE FROM sync_dirty");
    await db.execute(
      "INSERT OR IGNORE INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('c1', 'other', 't', 't')",
    );
    await db.execute(
      "INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('c1', 'other', 't', 't') ON CONFLICT DO NOTHING",
    );
    expect(await readMarks(db)).toEqual([]);
  });

  describe("INSERT OR REPLACE / REPLACE INTO (recursive_triggers is OFF, as in production)", () => {
    it("marks the replaced row as an upsert when the conflict is on the primary key", async () => {
      const db = await createCaptureDb();
      await insertContext(db, "c1");
      await db.execute("DELETE FROM sync_dirty");
      await db.execute(
        "INSERT OR REPLACE INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('c1', 'replaced', 't', 't')",
      );
      await db.execute(
        "REPLACE INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('c1', 'replaced twice', 't', 't')",
      );
      expect(await readMarks(db)).toEqual([
        { entity_type: "gtd_contexts", entity_id: "c1", op: "upsert" },
      ]);
    });

    it("does NOT see the victim row of a REPLACE on another unique key, which only the scan can heal", async () => {
      const db = await createCaptureDb();
      // gtd_contexts.name is UNIQUE.
      await insertContext(db, "victim", "same-name");
      await db.execute("DELETE FROM sync_dirty");
      await db.execute(
        "INSERT OR REPLACE INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('winner', 'same-name', 't', 't')",
      );
      expect(await db.select("SELECT id FROM gtd_contexts")).toEqual([{ id: "winner" }]);
      // Only the new row is marked; the replaced row's delete trigger did not fire.
      expect(await readMarks(db)).toEqual([
        { entity_type: "gtd_contexts", entity_id: "winner", op: "upsert" },
      ]);
    });
  });

  it("does not mark anything for tables that are not captured", async () => {
    const db = await createCaptureDb();
    await db.execute(
      `INSERT INTO gtd_task_events (id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json)
       VALUES ('e1', 't1', 'task_created', '2026-10-01', 't', 't', 'k1', '{}')`,
    );
    await db.execute(
      `INSERT INTO ai_messages (id, surface, scope_key, stance, kind, input_hash, prompt_version, model, status, body_json, body_text, delta_class, notified, tokens_prompt, tokens_completion, latency_ms, created_at)
       VALUES ('m1', 's', 'k', 'x', 'k', 'h', 'v', 'm', 'ok', '{}', '', 'none', 0, 0, 0, 0, 't')`,
    );
    await db.execute(
      "INSERT INTO rescuetime_snapshot_cache (week_start_date, kind, credential_fingerprint, payload_json, fetched_at) VALUES ('w', 'k', 'f', '{}', 't')",
    );
    await db.execute("INSERT INTO sync_peers (peer_id, peer_name) VALUES ('p', 'n')");
    await db.execute(
      "INSERT INTO sync_entity_meta (entity_type, entity_id, row_hlc) VALUES ('gtd_tasks', 'x', 'h')",
    );
    expect(await readMarks(db)).toEqual([]);
  });

  it("marks the settings blob (insert and update) but not its deletion", async () => {
    const db = await createCaptureDb();
    await db.execute("INSERT INTO app_settings (id, value) VALUES (1, '{}')");
    expect(await readMarks(db)).toEqual([
      { entity_type: "app_settings", entity_id: "1", op: "upsert" },
    ]);
    await db.execute("DELETE FROM sync_dirty");
    await db.execute("DELETE FROM app_settings");
    expect(await readMarks(db)).toEqual([]);
  });
});

describe("when the triggers must stay silent", () => {
  it("records nothing while a merge-apply transaction has set applying = 1", async () => {
    const db = await createCaptureDb();
    await db.execute("BEGIN IMMEDIATE");
    await db.execute("UPDATE sync_identity SET applying = 1 WHERE id = 1");
    await insertContext(db, "remote");
    await insertTask(db, "remote-task");
    await db.execute("UPDATE gtd_contexts SET name = 'edited' WHERE id = 'remote'");
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'remote'");
    await db.execute("UPDATE sync_identity SET applying = 0 WHERE id = 1");
    await db.execute("COMMIT");
    expect(await readMarks(db)).toEqual([]);
    // And it resumes afterwards.
    await insertContext(db, "local");
    expect(await readMarks(db)).toHaveLength(1);
  });

  it("records nothing without an identity row", async () => {
    const db = await createCaptureDb({ identity: false });
    await insertContext(db, "c1");
    await insertTask(db, "t1");
    await db.execute("DELETE FROM gtd_contexts");
    expect(await readMarks(db)).toEqual([]);
  });

  it("rolls marks back with the transaction", async () => {
    const db = await createCaptureDb();
    await db.execute("BEGIN IMMEDIATE");
    await insertContext(db, "c1");
    expect(await readMarks(db)).toHaveLength(1);
    await db.execute("ROLLBACK");
    expect(await readMarks(db)).toEqual([]);
    expect(await db.select("SELECT id FROM gtd_contexts")).toEqual([]);
  });

  it("leaves marks, meta, snapshots and counters empty when a stamped transaction throws", async () => {
    const db = await createCaptureDb();
    const before = await syncState(db);
    await expect(
      stampedTransaction(db, async () => {
        await insertContext(db, "c1");
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(await syncState(db)).toEqual(before);
    expect(await readMeta(db)).toEqual([]);
  });
});
