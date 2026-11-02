// @vitest-environment node
import { describe, expect, it } from "vitest";
import { backfillSyncCapture } from "./capture-backfill";
import { capturedSettingKeys, stampDirtyEntities } from "./capture-stamp";
import { disableSyncCapture, installSyncCapture } from "./capture-install";
import {
  CAPTURE_NOW,
  clocksOf,
  createCaptureDb,
  insertContext,
  insertTask,
  type MetaRow,
  readIdentity,
  readMarks,
  readMeta,
  readMetaOf,
  stampedTransaction,
  syncState,
  T0,
} from "./capture-test-utils";
import { compareHlc, isValidHlc } from "./hlc";
import { settingKeys, settingRule } from "./registry";

type Db = Awaited<ReturnType<typeof createCaptureDb>>;

const stamp = <T>(db: Db, work: () => Promise<T>, nowMs = CAPTURE_NOW) =>
  stampedTransaction(db, work, nowMs);

const snapshotOf = async (db: Db, type: string, id: string) =>
  (
    await db.select<{ snapshot_json: string | null; content_hash: string | null }[]>(
      "SELECT snapshot_json, content_hash FROM sync_entity_snapshot WHERE entity_type = $1 AND entity_id = $2",
      [type, id],
    )
  )[0];

const setSettings = (db: Db, value: Record<string, unknown>) =>
  db.execute(
    "INSERT INTO app_settings (id, value) VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    [JSON.stringify(value)],
  );

describe("stampDirtyEntities: field-clock tables", () => {
  it("stamps every field of a created row with one clock and records the snapshot", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await insertTask(db, "t1", { context_ids_json: '["context:a","context:b"]' });
    });
    const meta = await readMetaOf(db, "gtd_tasks", "t1");
    expect(meta?.deleted_at).toBeNull();
    const clocks = clocksOf(meta);
    expect(Object.keys(clocks).sort()).toEqual(
      [
        "title",
        "notes",
        "status",
        "bucket",
        "project_id",
        "parent_task_id",
        "scheduled_for",
        "completed_at",
        "source",
        "source_external_id",
        "created_at",
        "updated_at",
        "recurrence_group_id",
        "pending_past_recurrences",
        "recurring_template_id",
        "recurrence_due_date",
        "is_recurring_instance",
        "deadline",
        "planned_order",
        "source_url",
        "context_ids_json.context:a",
        "context_ids_json.context:b",
      ].sort(),
    );
    expect(new Set(Object.values(clocks)).size).toBe(1);
    expect(meta?.row_hlc).toBe(Object.values(clocks)[0]);
    expect(isValidHlc(meta?.row_hlc)).toBe(true);
    expect(Object.keys(clocks)).not.toContain("id");
    const snapshot = await snapshotOf(db, "gtd_tasks", "t1");
    expect(JSON.parse(snapshot?.snapshot_json ?? "null")).toMatchObject({
      title: "Task t1",
      context_ids_json: ["context:a", "context:b"],
    });
    expect(snapshot?.content_hash).toBeNull();
    expect(await readMarks(db)).toEqual([]);
    expect((await readIdentity(db))?.change_counter).toBe(1);
  });

  it("stamps only the fields that changed", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1"));
    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, async () => {
      await db.execute("UPDATE gtd_tasks SET title = 'Renamed', bucket = 'next' WHERE id = 't1'");
    });
    const after = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    const changed = Object.keys(after).filter((key) => after[key] !== created[key]);
    expect(changed.sort()).toEqual(["bucket", "title"]);
    expect(compareHlc(created.title as string, after.title as string)).toBe(-1);
    expect(after.title).toBe(after.bucket);
    expect((await readMetaOf(db, "gtd_tasks", "t1"))?.row_hlc).toBe(after.title);
    expect((await readIdentity(db))?.change_counter).toBe(2);
  });

  it("treats updated_at as an ordinary scalar field", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1"));
    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, async () => {
      await db.execute(
        "UPDATE gtd_tasks SET updated_at = '2026-10-02T00:00:00.000Z' WHERE id = 't1'",
      );
    });
    const after = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual(["updated_at"]);
  });

  it("does not touch sync state at all for an UPDATE that sets identical values", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["a"]' }));
    const before = await syncState(db);
    await stamp(db, async () => {
      await db.execute("UPDATE gtd_tasks SET title = title, bucket = 'inbox', notes = ''");
      await db.execute("UPDATE gtd_tasks SET context_ids_json = '[\"a\"]'");
    });
    expect(await syncState(db)).toEqual(before);
  });

  it("does not move clocks or counters when an OR-set is merely reordered", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["a","b"]' }));
    const before = await syncState(db);
    await stamp(db, async () => {
      await db.execute('UPDATE gtd_tasks SET context_ids_json = \'["b","a"]\'');
    });
    expect(await syncState(db)).toEqual(before);
  });

  it("stamps a single added and a single removed OR-set element", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["a","b"]' }));
    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, async () => {
      await db.execute('UPDATE gtd_tasks SET context_ids_json = \'["a","b","c"]\'');
    });
    const added = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(added).filter((key) => added[key] !== created[key])).toEqual([
      "context_ids_json.c",
    ]);
    await stamp(db, async () => {
      await db.execute('UPDATE gtd_tasks SET context_ids_json = \'["a","c"]\'');
    });
    const removed = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(removed).filter((key) => removed[key] !== added[key])).toEqual([
      "context_ids_json.b",
    ]);
    // The removal keeps its clock (a key tombstone) so the merge can tell remove from never-added.
    expect(Object.keys(removed)).toContain("context_ids_json.b");
  });

  it("stamps per key of a JSON-map column and nothing else", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO daily_entries (date, status, metrics_json, principles_json, morning_intention, night_reflection, tomorrow_focus, updated_at)
         VALUES ('2026-10-01', 'in_progress', '{"pushups":10,"marche":null}', '{"ecriture":true}', '', '', '', '${T0}')`,
      );
    });
    const created = clocksOf(await readMetaOf(db, "daily_entries", "2026-10-01"));
    expect(Object.keys(created)).toEqual(
      expect.arrayContaining([
        "metrics_json.pushups",
        "metrics_json.marche",
        "principles_json.ecriture",
        "status",
        "morning_intention",
      ]),
    );
    expect(Object.keys(created)).not.toContain("metrics_json");
    await stamp(db, async () => {
      await db.execute(
        `UPDATE daily_entries SET metrics_json = '{"pushups":12,"marche":null,"course":3}'`,
      );
    });
    const after = clocksOf(await readMetaOf(db, "daily_entries", "2026-10-01"));
    expect(
      Object.keys(after)
        .filter((key) => after[key] !== created[key])
        .sort(),
    ).toEqual(["metrics_json.course", "metrics_json.pushups"]);
    // Removing a key leaves a clock without a value.
    await stamp(db, async () => {
      await db.execute(`UPDATE daily_entries SET metrics_json = '{"pushups":12,"course":3}'`);
    });
    const removed = clocksOf(await readMetaOf(db, "daily_entries", "2026-10-01"));
    expect(Object.keys(removed).filter((key) => removed[key] !== after[key])).toEqual([
      "metrics_json.marche",
    ]);
  });

  it("compares atomic JSON columns by parsed value, not by text", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO weekly_reviews (week_start_date, week_end_date, status, notes_json, ritual_checklist_json, updated_at)
         VALUES ('2026-09-27', '2026-10-03', 'draft', '{}', '[1,2]', '${T0}')`,
      );
    });
    const before = await syncState(db);
    await stamp(db, async () => {
      await db.execute("UPDATE weekly_reviews SET ritual_checklist_json = '[1, 2]'");
    });
    expect(await syncState(db)).toEqual(before);
    await stamp(db, async () => {
      await db.execute("UPDATE weekly_reviews SET ritual_checklist_json = '[1, 2, 3]'");
    });
    const created = clocksOf(before.meta[0]);
    const after = clocksOf(await readMetaOf(db, "weekly_reviews", "2026-09-27"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual([
      "ritual_checklist_json",
    ]);
  });

  it("uses a composite key, with only the non-key columns as fields", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        "INSERT INTO weekly_objective_results (week_start_date, objective_id, achieved, updated_at) VALUES ('2026-10-04', 'obj-1', 0, 't')",
      );
    });
    const meta = await readMetaOf(db, "weekly_objective_results", '["2026-10-04","obj-1"]');
    expect(Object.keys(clocksOf(meta)).sort()).toEqual(["achieved", "updated_at"]);
  });

  it("demotes a map column with an unmergeable shape to an atomic field instead of failing the write", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, created_at, updated_at)
         VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"label":"no id"}]', '${T0}', '${T0}')`,
      );
    });
    const created = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(created.milestones_json).toBeDefined();
    expect(Object.keys(created).some((key) => key.startsWith("milestones_json."))).toBe(false);
    await stamp(db, async () => {
      await db.execute(`UPDATE annual_goals SET milestones_json = '[{"label":"still no id"}]'`);
    });
    const after = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(after.milestones_json).not.toBe(created.milestones_json);
  });

  it("keeps a field either atomic or per key across valid -> unmergeable -> valid shapes", async () => {
    const db = await createCaptureDb();
    const setMilestones = (json: string) =>
      stamp(db, () => db.execute("UPDATE annual_goals SET milestones_json = $1", [json]));
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, created_at, updated_at)
         VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"id":"m1","done":false}]', '${T0}', '${T0}')`,
      );
    });
    const first = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(first["milestones_json.m1"]).toBeDefined();
    expect(first.milestones_json).toBeUndefined();

    // Valid -> unmergeable: one atomic clock, and the per-id clocks are gone (no contradiction).
    await setMilestones('[{"label":"no id"}]');
    const broken = await readMetaOf(db, "annual_goals", "g1");
    const brokenClocks = clocksOf(broken);
    expect(brokenClocks.milestones_json).toBe(broken?.row_hlc);
    expect(Object.keys(brokenClocks).some((key) => key.startsWith("milestones_json."))).toBe(false);

    // Unmergeable -> valid: per-id clocks again, the bare clock is dropped, and the repair is a
    // per-id add of m1 at the new clock.
    await setMilestones('[{"id":"m1","done":true}]');
    const repaired = await readMetaOf(db, "annual_goals", "g1");
    const repairedClocks = clocksOf(repaired);
    expect(repairedClocks["milestones_json.m1"]).toBe(repaired?.row_hlc);
    expect(repairedClocks.milestones_json).toBeUndefined();
    expect(compareHlc(broken?.row_hlc as string, repaired?.row_hlc as string)).toBe(-1);

    // And a later per-id edit stays per key.
    await setMilestones('[{"id":"m1","done":true},{"id":"m2"}]');
    const later = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(later["milestones_json.m2"]).toBeDefined();
    expect(later.milestones_json).toBeUndefined();
    expect(later["milestones_json.m1"]).toBe(repairedClocks["milestones_json.m1"]);
  });

  describe("repairing an unmergeable map column", () => {
    const seedBroken = async (db: Db) => {
      await stamp(db, async () => {
        await db.execute(
          `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, created_at, updated_at)
           VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"x":1}]', '${T0}', '${T0}')`,
        );
      });
    };
    const snapshotMilestones = async (db: Db) =>
      JSON.parse((await snapshotOf(db, "annual_goals", "g1"))?.snapshot_json ?? "{}")
        .milestones_json;

    it("counts broken -> [] as a change on its own: clock, counter and snapshot all move", async () => {
      const db = await createCaptureDb();
      await seedBroken(db);
      const before = await readMetaOf(db, "annual_goals", "g1");
      const counter = (await readIdentity(db))?.change_counter;
      expect(clocksOf(before).milestones_json).toBe(before?.row_hlc);
      expect(await snapshotMilestones(db)).toEqual([{ x: 1 }]);

      await stamp(db, () => db.execute("UPDATE annual_goals SET milestones_json = '[]'"));

      const after = await readMetaOf(db, "annual_goals", "g1");
      expect(compareHlc(before?.row_hlc as string, after?.row_hlc as string)).toBe(-1);
      expect(clocksOf(after).milestones_json).toBe(after?.row_hlc);
      expect(Object.keys(clocksOf(after)).some((key) => key.startsWith("milestones_json."))).toBe(
        false,
      );
      expect((await readIdentity(db))?.change_counter).toBe((counter ?? 0) + 1);
      expect(await snapshotMilestones(db)).toEqual([]);
      // And the repaired value is now stable: re-saving it is a no-op.
      const state = await syncState(db);
      await stamp(db, () => db.execute("UPDATE annual_goals SET milestones_json = '[]'"));
      expect(await syncState(db)).toEqual(state);
    });

    it("also works for an empty object", async () => {
      const db = await createCaptureDb();
      await seedBroken(db);
      const counter = (await readIdentity(db))?.change_counter ?? 0;
      await stamp(db, () => db.execute("UPDATE annual_goals SET milestones_json = '{}'"));
      expect((await readIdentity(db))?.change_counter).toBe(counter + 1);
      expect(await snapshotMilestones(db)).toEqual({});
    });

    it("never keeps a bare clock beside per-key clocks: broken -> [] plus a title edit, then an added id", async () => {
      const db = await createCaptureDb();
      await seedBroken(db);
      await stamp(db, () =>
        db.execute("UPDATE annual_goals SET milestones_json = '[]', title = 'Renamed'"),
      );
      const repaired = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
      expect(repaired.milestones_json).toBeDefined();
      expect(Object.keys(repaired).some((key) => key.startsWith("milestones_json."))).toBe(false);

      await stamp(db, () =>
        db.execute(`UPDATE annual_goals SET milestones_json = '[{"id":"m2","done":false}]'`),
      );
      const later = await readMetaOf(db, "annual_goals", "g1");
      const laterClocks = clocksOf(later);
      expect(laterClocks["milestones_json.m2"]).toBe(later?.row_hlc);
      expect(laterClocks.milestones_json).toBeUndefined();
      expect(laterClocks.title).toBe(repaired.title);
    });
  });

  it("stamps milestones (an array of {id}) per id", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, progress_log_json, created_at, updated_at)
         VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"id":"m1","done":false},{"id":"m2","done":false}]', '{"2026-10-01":3}', '${T0}', '${T0}')`,
      );
    });
    const created = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(created["milestones_json.m1"]).toBeDefined();
    expect(created["progress_log_json.2026-10-01"]).toBeDefined();
    await stamp(db, async () => {
      await db.execute(
        `UPDATE annual_goals SET milestones_json = '[{"id":"m1","done":true},{"id":"m2","done":false}]'`,
      );
    });
    const after = clocksOf(await readMetaOf(db, "annual_goals", "g1"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual([
      "milestones_json.m1",
    ]);
  });
});

describe("stampDirtyEntities: deletes, tombstones and resurrection", () => {
  it("writes a tombstone for a stamped row, keeps its clocks and drops the snapshot", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["a"]' }));
    const created = await readMetaOf(db, "gtd_tasks", "t1");
    await stamp(db, async () => {
      await db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
    });
    const tombstone = await readMetaOf(db, "gtd_tasks", "t1");
    expect(tombstone?.deleted_at).toBeTruthy();
    expect(tombstone?.row_hlc).toBe(tombstone?.deleted_at);
    expect(compareHlc(created?.row_hlc as string, tombstone?.row_hlc as string)).toBe(-1);
    expect(tombstone?.field_clocks_json).toBe(created?.field_clocks_json);
    expect(await snapshotOf(db, "gtd_tasks", "t1")).toBeUndefined();
    expect((await readIdentity(db))?.change_counter).toBe(2);
  });

  it("writes nothing for a row that was created and deleted before it was ever stamped", async () => {
    const db = await createCaptureDb();
    const before = await syncState(db);
    await stamp(db, async () => {
      await insertTask(db, "ghost");
      await db.execute("DELETE FROM gtd_tasks WHERE id = 'ghost'");
    });
    expect(await syncState(db)).toEqual(before);
  });

  it("does not re-tombstone an already deleted entity", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertContext(db, "c1"));
    await stamp(db, () => db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'"));
    const before = await syncState(db);
    await stamp(db, async () => {
      await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    });
    expect(await syncState(db)).toEqual(before);
  });

  it("starts over as a creation after a delete in an earlier transaction (resurrection)", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { title: "First life" }));
    const created = await readMetaOf(db, "gtd_tasks", "t1");
    await stamp(db, () => db.execute("DELETE FROM gtd_tasks WHERE id = 't1'"));
    const tombstone = await readMetaOf(db, "gtd_tasks", "t1");
    await stamp(db, () => insertTask(db, "t1", { title: "Second life" }));
    const revived = await readMetaOf(db, "gtd_tasks", "t1");
    expect(revived?.deleted_at).toBeNull();
    expect(compareHlc(tombstone?.row_hlc as string, revived?.row_hlc as string)).toBe(-1);
    const clocks = clocksOf(revived);
    for (const field of ["title", "bucket", "status", "created_at"]) {
      expect(clocks[field]).toBe(revived?.row_hlc);
    }
    expect(compareHlc(created?.row_hlc as string, clocks.title as string)).toBe(-1);
    expect(
      JSON.parse((await snapshotOf(db, "gtd_tasks", "t1"))?.snapshot_json ?? "{}"),
    ).toMatchObject({
      title: "Second life",
    });
  });

  it("re-stamps map keys and OR-set elements the new life no longer holds as removals", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["home","work"]' }));
    const first = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, () => db.execute("DELETE FROM gtd_tasks WHERE id = 't1'"));
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["work"]' }));
    const revived = await readMetaOf(db, "gtd_tasks", "t1");
    const clocks = clocksOf(revived);
    expect(revived?.deleted_at).toBeNull();
    // The omitted element is a removal dated at the recreation, not at its last edit.
    expect(clocks["context_ids_json.home"]).toBe(revived?.row_hlc);
    expect(clocks["context_ids_json.work"]).toBe(revived?.row_hlc);
    expect(
      compareHlc(
        first["context_ids_json.home"] as string,
        clocks["context_ids_json.home"] as string,
      ),
    ).toBe(-1);
    expect(new Set(Object.values(clocks))).toEqual(new Set([revived?.row_hlc]));
  });

  it("does the same for JSON-map columns (metrics) and id-array maps (milestones)", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO daily_entries (date, status, metrics_json, principles_json, morning_intention, night_reflection, tomorrow_focus, updated_at)
         VALUES ('2026-10-01', 'in_progress', '{"pushups":10,"marche":3}', '{}', '', '', '', '${T0}')`,
      );
      await db.execute(
        `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, created_at, updated_at)
         VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"id":"m1"},{"id":"m2"}]', '${T0}', '${T0}')`,
      );
    });
    await stamp(db, async () => {
      await db.execute("DELETE FROM daily_entries");
      await db.execute("DELETE FROM annual_goals");
    });
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO daily_entries (date, status, metrics_json, principles_json, morning_intention, night_reflection, tomorrow_focus, updated_at)
         VALUES ('2026-10-01', 'in_progress', '{"pushups":10}', '{}', '', '', '', '${T0}')`,
      );
      await db.execute(
        `INSERT INTO annual_goals (id, title, dimension, description, unit, evaluations_json, milestones_json, created_at, updated_at)
         VALUES ('g1', 'Goal', 'body', '', 'kg', '{}', '[{"id":"m1"}]', '${T0}', '${T0}')`,
      );
    });
    const entry = await readMetaOf(db, "daily_entries", "2026-10-01");
    expect(clocksOf(entry)["metrics_json.marche"]).toBe(entry?.row_hlc);
    const goal = await readMetaOf(db, "annual_goals", "g1");
    expect(clocksOf(goal)["milestones_json.m2"]).toBe(goal?.row_hlc);
  });

  it("keeps a same-transaction delete + insert a plain update (the omitted element is stamped once)", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1", { context_ids_json: '["home","work"]' }));
    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, async () => {
      await db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
      await insertTask(db, "t1", { context_ids_json: '["work"]' });
    });
    const after = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual([
      "context_ids_json.home",
    ]);
  });

  it("treats delete + identical re-insert in one transaction as no change, and a changed re-insert as only the changed fields", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertTask(db, "t1"));
    const before = await syncState(db);
    await stamp(db, async () => {
      await db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
      await insertTask(db, "t1");
    });
    expect(await syncState(db)).toEqual(before);

    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await stamp(db, async () => {
      await db.execute("DELETE FROM gtd_tasks WHERE id = 't1'");
      await insertTask(db, "t1", { title: "Changed" });
    });
    const after = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual(["title"]);
    expect((await readMetaOf(db, "gtd_tasks", "t1"))?.deleted_at).toBeNull();
  });

  it("tombstones the old key and creates the new one when a key is rewritten", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertContext(db, "old"));
    await stamp(db, () => db.execute("UPDATE gtd_contexts SET id = 'new' WHERE id = 'old'"));
    expect((await readMetaOf(db, "gtd_contexts", "old"))?.deleted_at).toBeTruthy();
    expect((await readMetaOf(db, "gtd_contexts", "new"))?.deleted_at).toBeNull();
  });
});

describe("stampDirtyEntities: row-clock and related classes", () => {
  const insertPerson = (db: Db, id: string, name = "Alex") =>
    db.execute(
      "INSERT INTO finance_people (id, display_name, color, archived, created_at, updated_at) VALUES ($1, $2, NULL, 0, 't', 't')",
      [id, name],
    );

  it("stamps the whole row with one row clock and a content hash, no field clocks", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertPerson(db, "p1"));
    const meta = await readMetaOf(db, "finance_people", "p1");
    expect(meta?.field_clocks_json).toBe("{}");
    expect(isValidHlc(meta?.row_hlc)).toBe(true);
    const snapshot = await snapshotOf(db, "finance_people", "p1");
    expect(snapshot?.snapshot_json).toBeNull();
    expect(snapshot?.content_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("moves the row clock only when the row content changed", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertPerson(db, "p1"));
    const created = await readMetaOf(db, "finance_people", "p1");
    const before = await syncState(db);
    await stamp(db, () => db.execute("UPDATE finance_people SET display_name = 'Alex'"));
    expect(await syncState(db)).toEqual(before);
    await stamp(db, () => db.execute("UPDATE finance_people SET display_name = 'Sam'"));
    const after = await readMetaOf(db, "finance_people", "p1");
    expect(compareHlc(created?.row_hlc as string, after?.row_hlc as string)).toBe(-1);
    expect(after?.deleted_at).toBeNull();
  });

  it("tombstones and resurrects row-clock rows", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => insertPerson(db, "p1"));
    await stamp(db, () => db.execute("DELETE FROM finance_people WHERE id = 'p1'"));
    const tombstone = await readMetaOf(db, "finance_people", "p1");
    expect(tombstone?.deleted_at).toBe(tombstone?.row_hlc);
    await stamp(db, () => insertPerson(db, "p1"));
    const revived = await readMetaOf(db, "finance_people", "p1");
    expect(revived?.deleted_at).toBeNull();
    expect(compareHlc(tombstone?.row_hlc as string, revived?.row_hlc as string)).toBe(-1);
  });

  it("stamps finance_transaction_splits as row-clock entities of their own (child-set, no unit clock yet)", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        "INSERT INTO finance_transaction_splits (id, transaction_id, amount_minor, category_id, notes, sort_order, created_at) VALUES ('s1', 'tx-1', 500, NULL, NULL, 0, 't')",
      );
    });
    expect((await readMetaOf(db, "finance_transaction_splits", "s1"))?.field_clocks_json).toBe(
      "{}",
    );
    expect(await readMetaOf(db, "finance_transactions", "tx-1")).toBeUndefined();
  });

  it("stamps pomodoro sessions as row-clock entities, including state changes", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        "INSERT INTO pomodoro_sessions (id, kind, status, started_at, ends_at, cycle_index, date) VALUES ('ps1', 'focus', 'running', 't', 't2', 1, '2026-10-01')",
      );
    });
    const running = await readMetaOf(db, "pomodoro_sessions", "ps1");
    await stamp(db, () => db.execute("UPDATE pomodoro_sessions SET status = 'completed'"));
    const done = await readMetaOf(db, "pomodoro_sessions", "ps1");
    expect(compareHlc(running?.row_hlc as string, done?.row_hlc as string)).toBe(-1);
  });
});

describe("stampDirtyEntities: settings", () => {
  const settingMeta = (db: Db) => readMeta(db, "setting");

  it("stamps a changed synced key as a setting entity, once", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => setSettings(db, { language: "en" }));
    const meta = await settingMeta(db);
    expect(meta.map((row) => row.entity_id)).toEqual(["language"]);
    expect(meta[0]?.field_clocks_json).toBe("{}");
    expect((await snapshotOf(db, "setting", "language"))?.snapshot_json).toBe('"en"');
    expect((await readIdentity(db))?.change_counter).toBe(1);

    const before = await syncState(db);
    await stamp(db, () =>
      setSettings(db, { language: "en", lastBackupAt: "2026-10-18T00:00:00.000Z" }),
    );
    expect(await syncState(db)).toEqual(before);
  });

  it("does not stamp a key that still has its default value", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => setSettings(db, {}));
    expect(await settingMeta(db)).toEqual([]);
    expect((await readIdentity(db))?.change_counter).toBe(0);
  });

  it("stamps a change back to the default once a different value was stamped", async () => {
    const db = await createCaptureDb();
    await stamp(db, () => setSettings(db, { language: "en" }));
    const first = (await settingMeta(db))[0] as MetaRow;
    await stamp(db, () => setSettings(db, { language: "fr" }));
    const second = (await settingMeta(db))[0] as MetaRow;
    expect(compareHlc(first.row_hlc, second.row_hlc)).toBe(-1);
  });

  it("never creates meta or snapshots for device-scope keys or secrets", async () => {
    const db = await createCaptureDb();
    await stamp(db, () =>
      setSettings(db, {
        aiApiKey: "sk-secret-1234",
        rescuetimeApiKey: "rt-secret",
        llmBridgeToken: "bridge-token",
        llmBridgeEnabled: true,
        llmBridgePort: 4567,
        aiBaseUrl: "https://example.test/v1",
        backupDestinationDir: "/Users/x/Drive/backups",
        autoBackupEnabled: false,
        lastBackupAt: "2026-10-18T00:00:00.000Z",
        lastBackupPath: "/Users/x/Drive/backups/a.db",
        runInTray: true,
        launchAtLogin: true,
        storageMode: "sqlite",
        aiPulseFirstOpenAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(await settingMeta(db)).toEqual([]);
    expect(
      await db.select("SELECT * FROM sync_entity_snapshot WHERE entity_type = 'setting'"),
    ).toEqual([]);
    expect((await readIdentity(db))?.change_counter).toBe(0);

    // Changing the AI key alone, later, still creates nothing.
    await stamp(db, () => setSettings(db, { aiApiKey: "sk-another-secret" }));
    expect(await readMeta(db)).toEqual([]);
    expect(JSON.stringify(await syncState(db))).not.toContain("sk-");
  });

  it("stamps synced keys of every scope, and exactly the registry's non-device non-secret keys", async () => {
    const db = await createCaptureDb();
    await stamp(db, () =>
      setSettings(db, {
        language: "en",
        aiModel: "some/model",
        financeEnabled: true,
        relationshipDrawChildrenProcessedDate: "2026-10-17",
      }),
    );
    expect((await settingMeta(db)).map((row) => row.entity_id).sort()).toEqual([
      "aiModel",
      "financeEnabled",
      "language",
      "relationshipDrawChildrenProcessedDate",
    ]);
    const captured = capturedSettingKeys();
    for (const key of settingKeys()) {
      const rule = settingRule(key);
      expect(captured.includes(key)).toBe(rule.scope !== "device" && rule.secret !== true);
    }
    expect(captured).not.toContain("aiApiKey");
    expect(captured).not.toContain("lastBackupAt");
  });

  it("ignores a corrupt settings blob instead of failing the write", async () => {
    const db = await createCaptureDb();
    await stamp(db, () =>
      db.execute("INSERT INTO app_settings (id, value) VALUES (1, '{not json')"),
    );
    expect(await settingMeta(db)).toEqual([]);
  });
});

describe("stampDirtyEntities: mechanics", () => {
  it("is a single cheap query when nothing is dirty", async () => {
    const db = await createCaptureDb();
    const seen: string[] = [];
    const select = db.select.bind(db);
    const execute = db.execute.bind(db);
    db.select = ((query: string, values?: unknown[]) => {
      seen.push(query);
      return select(query, values);
    }) as typeof db.select;
    db.execute = ((query: string, values?: unknown[]) => {
      seen.push(query);
      return execute(query, values);
    }) as typeof db.execute;
    expect(await stampDirtyEntities(db, CAPTURE_NOW)).toBe(0);
    expect(seen).toEqual(["SELECT 1 AS present FROM sync_dirty LIMIT 1"]);
  });

  it("issues distinct, strictly increasing clocks to different entities in one transaction", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      for (let i = 0; i < 20; i += 1) await insertContext(db, `c${String(i).padStart(2, "0")}`);
    });
    const clocks = (await readMeta(db, "gtd_contexts")).map((row) => row.row_hlc);
    expect(new Set(clocks).size).toBe(20);
    const sorted = [...clocks].sort(compareHlc);
    expect(sorted).toEqual([...clocks].sort());
    const identity = await readIdentity(db);
    expect(identity?.change_counter).toBe(20);
    expect(identity?.physical_ms).toBe(CAPTURE_NOW);
    expect(identity?.counter).toBe(19);
  });

  it("drains more marks than one internal chunk", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      for (let i = 0; i < 1250; i += 1) await insertContext(db, `c${i}`);
    });
    expect(await readMarks(db)).toEqual([]);
    expect(await readMeta(db, "gtd_contexts")).toHaveLength(1250);
    expect((await readIdentity(db))?.change_counter).toBe(1250);
  });

  it("never creates meta for union tables, device tables or sidecars", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute(
        `INSERT INTO gtd_task_events (id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json)
         VALUES ('e1', 't1', 'task_created', '2026-10-01', 't', 't', 'k1', '{}')`,
      );
      await db.execute("INSERT INTO sync_peers (peer_id, peer_name) VALUES ('p', 'n')");
    });
    expect(await readMeta(db)).toEqual([]);
    // The stamper counts nothing for them; the union counter trigger counted the one event insert,
    // and the device-local peers table counts nothing at all.
    expect((await readIdentity(db))?.change_counter).toBe(1);
  });

  it("discards marks, without failing, when the identity row disappeared", async () => {
    const db = await createCaptureDb();
    await db.execute("INSERT INTO sync_dirty VALUES ('gtd_contexts', 'c1', 'upsert')");
    await db.execute("DELETE FROM sync_identity");
    expect(await stampDirtyEntities(db, CAPTURE_NOW)).toBe(0);
    expect(await readMarks(db)).toEqual([]);
  });

  it("drops marks for unknown entity types and malformed keys", async () => {
    const db = await createCaptureDb();
    await db.execute(
      `INSERT INTO sync_dirty VALUES ('nope', 'x', 'upsert'), ('weekly_objective_results', 'not json', 'upsert'), ('device_thing', 'y', 'delete')`,
    );
    expect(await stampDirtyEntities(db, CAPTURE_NOW)).toBe(0);
    expect(await readMarks(db)).toEqual([]);
    expect(await readMeta(db)).toEqual([]);
  });

  it("rolls the user's write back when the identity state is corrupt (a failed stamp never half-commits)", async () => {
    const db = await createCaptureDb();
    await db.execute("UPDATE sync_identity SET counter = -1");
    await expect(stamp(db, () => insertContext(db, "c1"))).rejects.toThrow(
      /clock state is invalid/,
    );
    expect(await db.select("SELECT id FROM gtd_contexts")).toEqual([]);
    expect(await readMarks(db)).toEqual([]);
    expect(await readMeta(db)).toEqual([]);
  });

  it("does not capture a write made while applying = 1, then stamps nothing for it", async () => {
    const db = await createCaptureDb();
    await stamp(db, async () => {
      await db.execute("UPDATE sync_identity SET applying = 1");
      await insertContext(db, "remote");
      await db.execute("UPDATE sync_identity SET applying = 0");
    });
    expect(await readMeta(db)).toEqual([]);
    expect((await readIdentity(db))?.change_counter).toBe(0);
  });
});

/** Stamps the rows every migrated database already holds (the seeded finance categories). */
const baseline = async (db: Db) => {
  await backfillSyncCapture(db, CAPTURE_NOW - 10_000);
};

describe("backfillSyncCapture", () => {
  it("stamps pre-existing rows once, and a second run stamps nothing", async () => {
    const db = await createCaptureDb({ capture: false });
    await insertContext(db, "c1");
    await insertTask(db, "t1");
    await db.execute(
      "INSERT INTO weekly_objective_results (week_start_date, objective_id, achieved, updated_at) VALUES ('2026-10-04', 'obj-1', 1, 't')",
    );
    await setSettings(db, { language: "en", aiApiKey: "sk-secret" });
    await installSyncCapture(db);

    const stamped = await backfillSyncCapture(db, CAPTURE_NOW);
    // 1 context + 1 task + 1 result + seeded finance categories + the language setting.
    expect(stamped).toBeGreaterThanOrEqual(4);
    expect(await readMetaOf(db, "gtd_contexts", "c1")).toBeDefined();
    expect(await readMetaOf(db, "gtd_tasks", "t1")).toBeDefined();
    expect(
      await readMetaOf(db, "weekly_objective_results", '["2026-10-04","obj-1"]'),
    ).toBeDefined();
    expect((await readMeta(db, "setting")).map((row) => row.entity_id)).toEqual(["language"]);
    expect((await readIdentity(db))?.change_counter).toBe(stamped);

    const after = await syncState(db);
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 5_000)).toBe(0);
    expect(await syncState(db)).toEqual(after);
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 9_000, { verify: true })).toBe(0);
    expect(await syncState(db)).toEqual(after);
  });

  it("tombstones live meta rows whose row is gone (a delete no trigger saw)", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    await stamp(db, async () => {
      await insertContext(db, "c1");
      await insertContext(db, "c2");
    });
    await disableSyncCapture(db);
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    await installSyncCapture(db);
    const stamped = await backfillSyncCapture(db, CAPTURE_NOW + 1_000);
    expect(stamped).toBe(1);
    expect((await readMetaOf(db, "gtd_contexts", "c1"))?.deleted_at).toBeTruthy();
    expect((await readMetaOf(db, "gtd_contexts", "c2"))?.deleted_at).toBeNull();
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 2_000)).toBe(0);
  });

  it("still tombstones deleted rows when another row has a NULL primary key", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    await stamp(db, async () => {
      await insertContext(db, "c1");
      await insertContext(db, "c2");
    });
    await disableSyncCapture(db);
    await db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'");
    // gtd_contexts.id is a nullable TEXT primary key, so SQLite accepts a NULL key.
    await db.execute(
      "INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES (NULL, 'orphan', 't', 't')",
    );
    await installSyncCapture(db);
    await backfillSyncCapture(db, CAPTURE_NOW + 1_000);
    expect((await readMetaOf(db, "gtd_contexts", "c1"))?.deleted_at).toBeTruthy();
    expect((await readMetaOf(db, "gtd_contexts", "c2"))?.deleted_at).toBeNull();
    // The NULL-keyed row cannot be addressed and is never stamped; a second run is a no-op.
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 2_000)).toBe(0);
    expect(await readMarks(db)).toEqual([]);
  });

  it("heals the victim row of an INSERT OR REPLACE on another unique key", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    await stamp(db, () => insertContext(db, "victim", "same-name"));
    await stamp(db, async () => {
      await db.execute(
        "INSERT OR REPLACE INTO gtd_contexts (id, name, created_at, updated_at) VALUES ('winner', 'same-name', 't', 't')",
      );
    });
    // The winner is stamped by its insert trigger; the victim's delete was invisible.
    expect((await readMetaOf(db, "gtd_contexts", "winner"))?.deleted_at).toBeNull();
    expect((await readMetaOf(db, "gtd_contexts", "victim"))?.deleted_at).toBeNull();
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 1_000)).toBe(1);
    expect((await readMetaOf(db, "gtd_contexts", "victim"))?.deleted_at).toBeTruthy();
  });

  it("restamps a row that is present again after its tombstone (missed re-insert)", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    await stamp(db, () => insertContext(db, "c1"));
    await stamp(db, () => db.execute("DELETE FROM gtd_contexts WHERE id = 'c1'"));
    await disableSyncCapture(db);
    await insertContext(db, "c1", "back");
    await installSyncCapture(db);
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 1_000)).toBe(1);
    expect((await readMetaOf(db, "gtd_contexts", "c1"))?.deleted_at).toBeNull();
  });

  it("only re-checks rows that already have clocks when asked to verify", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    await stamp(db, async () => {
      await insertTask(db, "t1");
      await insertTask(db, "t2");
    });
    const created = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    await disableSyncCapture(db);
    await db.execute("UPDATE gtd_tasks SET title = 'edited while off' WHERE id = 't1'");
    await installSyncCapture(db);

    expect(await backfillSyncCapture(db, CAPTURE_NOW + 1_000)).toBe(0);
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 2_000, { verify: true })).toBe(1);
    const after = clocksOf(await readMetaOf(db, "gtd_tasks", "t1"));
    expect(Object.keys(after).filter((key) => after[key] !== created[key])).toEqual(["title"]);
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 3_000, { verify: true })).toBe(0);
  });

  it("requires a sync identity", async () => {
    const db = await createCaptureDb({ identity: false, capture: false });
    await expect(backfillSyncCapture(db, CAPTURE_NOW)).rejects.toThrow(
      /identity has not been created/,
    );
  });

  it("leaves union-table rows alone", async () => {
    const db = await createCaptureDb({ capture: false });
    await db.execute(
      `INSERT INTO gtd_task_events (id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json)
       VALUES ('e1', 't1', 'task_created', '2026-10-01', 't', 't', 'k1', '{}')`,
    );
    await installSyncCapture(db);
    await backfillSyncCapture(db, CAPTURE_NOW, { verify: true });
    expect((await readMeta(db)).some((row) => row.entity_type === "gtd_task_events")).toBe(false);
  });
});

describe("performance", () => {
  it("stamps a 1000-row bulk insert and re-verifies it quickly", async () => {
    const db = await createCaptureDb();
    await baseline(db);
    const counterBefore = (await readIdentity(db))?.change_counter ?? 0;
    const started = performance.now();
    await stamp(db, async () => {
      for (let i = 0; i < 1000; i += 1) {
        await db.execute(
          "INSERT INTO finance_people (id, display_name, color, archived, created_at, updated_at) VALUES ($1, $2, NULL, 0, 't', 't')",
          [`p${i}`, `Person ${i}`],
        );
      }
    });
    const elapsed = performance.now() - started;
    expect(await readMeta(db, "finance_people")).toHaveLength(1000);
    expect(((await readIdentity(db))?.change_counter ?? 0) - counterBefore).toBe(1000);
    expect(elapsed).toBeLessThan(10_000);
    const verifyStarted = performance.now();
    expect(await backfillSyncCapture(db, CAPTURE_NOW + 1, { verify: true })).toBe(0);
    expect(performance.now() - verifyStarted).toBeLessThan(10_000);
  });
});
