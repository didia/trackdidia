// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultAppSettings, normalizeAppSettings } from "../../domain/settings";
import type { AppSettings, Task } from "../../domain/types";
import { runSqliteTransaction, transactionDb } from "../storage/transaction";
import { applyChangeSet, prepareApply, type SyncSettingsAccess } from "./apply-bundle";
import { stampDirtyEntities } from "./capture-stamp";
import { clocksOf, readIdentity, readMarks, readMetaOf, syncState } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import { HLC_REMOTE_MAX_AHEAD_MS, SyncClockError } from "./clock-store";
import { SyncApplyError, SyncChangeSetError } from "./errors";
import { compareHlc, encodeHlc, HLC_MAX_COUNTER, HLC_MAX_PHYSICAL_MS } from "./hlc";
import {
  createSyncHarness,
  readConflicts,
  type SyncDevice,
  jsonRoundTrip,
} from "./test-support/two-device-harness";

const applyingFlag = async (device: SyncDevice): Promise<number | undefined> =>
  (await readIdentity(device.db))?.applying;

const findTask = async (device: SyncDevice, id: string): Promise<Task | undefined> =>
  (await device.repo.listTasks({ includeCompleted: true })).find((task) => task.id === id);

const editTask = async (device: SyncDevice, id: string, patch: Partial<Task>) => {
  const current = await findTask(device, id);
  if (!current) throw new Error(`no task ${id}`);
  return device.repo.saveTask({ ...current, ...patch });
};

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON change sets
type Draft = Record<string, any>;

const mutated = (changeSet: SyncChangeSet, mutate: (draft: Draft) => void): SyncChangeSet => {
  const draft = jsonRoundTrip(changeSet) as unknown as Draft;
  mutate(draft);
  return draft as unknown as SyncChangeSet;
};

/** Settings reader / writer for tests that call `applyChangeSet` directly, outside the repository. */
const plainSettingsAccess: SyncSettingsAccess = {
  read: async (db) => {
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE id = 1",
    );
    return normalizeAppSettings(JSON.parse(rows[0]?.value ?? "{}"), defaultAppSettings());
  },
  write: async (db, settings: AppSettings) => {
    await db.execute("INSERT OR REPLACE INTO app_settings (id, value) VALUES (1, $1)", [
      JSON.stringify(settings),
    ]);
    return settings;
  },
};

const twoDevices = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  return { sim, a: sim.device("A"), b: sim.device("B") };
};

describe("one transaction that rolls back completely", () => {
  it("leaves nothing behind when a row halfway through the bundle is bad", async () => {
    const { b, a } = await twoDevices();
    for (const id of ["t-a", "t-b", "t-c"]) {
      await b.repo.createTask({ id, title: `Task ${id}`, bucket: "inbox", contextIds: ["home"] });
    }
    const good = await b.repo.listSyncChanges("gtd");
    const bad = mutated(good, (draft) => {
      const second = draft.entities.find((entity: Draft) => entity.entityId === "t-b");
      second.row.title = null; // NOT NULL in gtd_tasks
    });

    const before = await syncState(a.db);
    const tasksBefore = await a.db.select("SELECT * FROM gtd_tasks");

    const failure = await a.repo.applySyncBundle("gtd", bad).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncApplyError);
    expect(failure).toMatchObject({ code: "sql_error", table: "gtd_tasks", entityId: "t-b" });

    // t-a was inserted before t-b failed; rollback removed it together with its meta, snapshot,
    // the contexts, the union rows and the clock the bundle had advanced.
    expect(await a.db.select("SELECT * FROM gtd_tasks")).toEqual(tasksBefore);
    expect(await a.db.select("SELECT * FROM gtd_contexts")).toEqual([]);
    expect(await a.db.select("SELECT * FROM gtd_task_events")).toEqual([]);
    expect(await syncState(a.db)).toEqual(before);
    expect(await applyingFlag(a)).toBe(0);

    // The good bundle still applies afterwards: nothing is wedged.
    await expect(a.repo.applySyncBundle("gtd", good)).resolves.toMatchObject({
      applied: expect.any(Number),
    });
    expect((await a.repo.listTasks({})).map((task) => task.id).sort()).toEqual([
      "t-a",
      "t-b",
      "t-c",
    ]);
  });

  it("cannot leave the applying flag raised: capture still works for the next local write", async () => {
    const { a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    const bad = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      draft.entities[0].row.title = null;
    });
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toBeInstanceOf(SyncApplyError);

    // A fresh transaction sees the flag at 0 ...
    const inFreshTransaction = await runSqliteTransaction(a.db, async (tx) =>
      transactionDb(tx).select<{ applying: number }[]>(
        "SELECT applying FROM sync_identity WHERE id = 1",
      ),
    );
    expect(inFreshTransaction[0]?.applying).toBe(0);
    // ... and the capture triggers are live again.
    await a.repo.createTask({ id: "local", title: "Local", bucket: "inbox" });
    expect((await readMetaOf(a.db, "gtd_tasks", "local"))?.deleted_at).toBeNull();
  });

  it("resets the flag on success too", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    await sim.exchange(b, a, "gtd");
    expect(await applyingFlag(a)).toBe(0);
    await a.repo.createTask({ id: "local", title: "Local", bucket: "inbox" });
    expect((await readMetaOf(a.db, "gtd_tasks", "local"))?.deleted_at).toBeNull();
    expect(await readMarks(a.db)).toEqual([]);
  });

  it("does not deadlock next to other writes and reads on the same repository", async () => {
    const { a, b } = await twoDevices();
    await b.repo.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
    const changeSet = await b.repo.listSyncChanges("gtd");
    const results = await Promise.all([
      a.repo.createTask({ id: "w1", title: "w1", bucket: "inbox" }),
      a.repo.applySyncBundle("gtd", changeSet),
      a.repo.createTask({ id: "w2", title: "w2", bucket: "inbox" }),
      a.repo.listSyncChanges("gtd"),
    ]);
    expect(results).toHaveLength(4);
    expect((await a.repo.listTasks({})).map((task) => task.id).sort()).toEqual([
      "from-b",
      "w1",
      "w2",
    ]);
  });
});

describe("pending local edits are stamped before remote data overwrites them", () => {
  const setup = async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Original", bucket: "inbox" });
    await sim.syncAll("gtd");
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "Remote title" });
    // A edits the row behind the repository's back: the trigger leaves a mark that no
    // writeTransaction has stamped yet (the same state a failed stamp or a crash leaves).
    a.clock.advance(60_000);
    await a.db.execute("UPDATE gtd_tasks SET title = 'Pending local title' WHERE id = 't1'");
    return { sim, a, b };
  };

  it("drains the mark with a local clock and content first, so the later local edit wins", async () => {
    const { sim, a, b } = await setup();
    expect((await readMarks(a.db)).length).toBeGreaterThan(0);
    const counterBefore = (await readIdentity(a.db))?.change_counter ?? 0;

    await sim.exchange(b, a, "gtd");

    expect((await findTask(a, "t1"))?.title).toBe("Pending local title");
    const meta = await readMetaOf(a.db, "gtd_tasks", "t1");
    expect(clocksOf(meta).title).toContain(a.deviceId);
    // The drain is a real local change: it counts, the merge itself does not add to it.
    expect((await readIdentity(a.db))?.change_counter).toBe(counterBefore + 1);
    expect(await readMarks(a.db)).toEqual([]);

    // And it is published as the winner: B converges on the pending local edit.
    await sim.syncAll("gtd");
    expect((await findTask(b, "t1"))?.title).toBe("Pending local title");
  });

  it("an earlier pending edit competes honestly and loses to a later remote edit, but is logged", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Original", bucket: "inbox" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await a.db.execute("UPDATE gtd_tasks SET title = 'Pending local title' WHERE id = 't1'");
    b.clock.advance(120_000);
    await editTask(b, "t1", { title: "Later remote title" });

    await sim.exchange(b, a, "gtd");

    expect((await findTask(a, "t1"))?.title).toBe("Later remote title");
    const conflicts = await readConflicts(a);
    expect(conflicts).toHaveLength(1);
    expect(JSON.parse(conflicts[0]?.local_json as string).title.value).toBe("Pending local title");
  });
});

describe("merge-applied writes are invisible to capture", () => {
  it("stamps no local clock, bumps no counter, leaves no dirty mark, and is idempotent", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox", contextIds: ["home"] });
    await b.repo.completeTask("t1");
    const before = await readIdentity(a.db);

    await sim.exchange(b, a, "gtd");

    const after = await readIdentity(a.db);
    expect(after?.change_counter).toBe(before?.change_counter);
    expect(after?.last_publish_counter).toBe(before?.last_publish_counter);
    expect(await readMarks(a.db)).toEqual([]);
    // Every clock stored for the merged entity is B's: A stamped nothing of its own.
    const meta = await readMetaOf(a.db, "gtd_tasks", "t1");
    expect(Object.values(clocksOf(meta)).every((clock) => clock.endsWith(b.deviceId))).toBe(true);
    expect(await stampDirtyEntities(a.db, a.clock.now)).toBe(0);

    const state = await syncState(a.db);
    const second = await sim.exchange(b, a, "gtd");
    expect(second).toMatchObject({
      applied: 0,
      tombstonesApplied: 0,
      conflictsLogged: 0,
      hlcAdvanced: false,
    });
    expect(await syncState(a.db)).toEqual(state);
    expect(await stampDirtyEntities(a.db, a.clock.now)).toBe(0);
  });

  it("fires no capture trigger while merging: the applying flag, with no stamping hook to hide it", async () => {
    // The repository's pre-commit stamper would quietly discard marks whose snapshot already
    // matches, so run the apply step in a bare transaction: any mark left behind is a trigger that
    // fired.
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({
      id: "t1",
      title: "To update",
      bucket: "inbox",
      contextIds: ["home"],
    });
    await b.repo.createTask({ id: "t2", title: "To delete", bucket: "inbox" });
    await b.repo.updateSettings((current) => ({
      ...current,
      gtdImportDoneAt: "2026-10-01T00:00:00.000Z",
    }));
    await sim.exchange(b, a, "gtd");
    await sim.syncAll("gtd");

    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "Updated", contextIds: ["home", "work"] });
    await b.db.execute("DELETE FROM gtd_tasks WHERE id = 't2'");
    await b.stamp();
    await b.repo.createTask({ id: "t3", title: "Inserted", bucket: "inbox" });

    const bundle = prepareApply(
      "gtd",
      jsonRoundTrip(await b.repo.listSyncChanges("gtd")),
      a.clock.now,
    );
    expect(await readMarks(a.db)).toEqual([]);
    const result = await runSqliteTransaction(a.db, async (tx) =>
      applyChangeSet(transactionDb(tx), bundle, {
        nowMs: a.clock.now,
        settings: plainSettingsAccess,
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.tombstonesApplied).toBe(1);
    expect((await findTask(a, "t1"))?.title).toBe("Updated");
    expect(await findTask(a, "t2")).toBeUndefined();
    expect(await findTask(a, "t3")).toBeDefined();
    expect(await readMarks(a.db)).toEqual([]);
    expect(await applyingFlag(a)).toBe(0);
    await sim.expectConverged("gtd", { snapshots: true });
  });

  it("writes the snapshot of every applied row as the stamper would decode it", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox", contextIds: ["b", "a"] });
    await sim.exchange(b, a, "gtd");
    const snapshot = await a.db.select<{ snapshot_json: string }[]>(
      "SELECT snapshot_json FROM sync_entity_snapshot WHERE entity_type = 'gtd_tasks' AND entity_id = 't1'",
    );
    const decoded = JSON.parse(snapshot[0]?.snapshot_json as string) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      title: "From B",
      status: "active",
      pending_past_recurrences: 0,
    });
    expect([...(decoded.context_ids_json as string[])].sort()).toEqual(["a", "b"]);
    // A verifying scan finds the state exactly as stamped: nothing to restamp.
    expect(await a.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
  });
});

describe("the remote clock", () => {
  it("is absorbed, so local clocks issued afterwards are causally after everything applied", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");
    b.clock.advance(5 * 3_600_000); // B's clock is 5 hours ahead of A's
    await editTask(b, "t1", { title: "From the future" });
    const changeSet = await b.repo.listSyncChanges("gtd");

    const result = await a.repo.applySyncBundle("gtd", changeSet);
    expect(result.hlcAdvanced).toBe(true);

    a.clock.advance(1_000); // A's wall clock is still hours behind B's
    await editTask(a, "t1", { notes: "After the merge" });
    const meta = await readMetaOf(a.db, "gtd_tasks", "t1");
    expect(compareHlc(clocksOf(meta).notes as string, changeSet.hlcHigh)).toBe(1);
  });

  it("rejects a malformed hlcHigh before anything is written", async () => {
    const { a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    const bad = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      draft.hlcHigh = "not-a-clock";
    });
    const before = await syncState(a.db);
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toMatchObject({
      code: "invalid_clock",
    });
    expect(await syncState(a.db)).toEqual(before);
  });

  it("rejects a clock more than 24 hours ahead without writing", async () => {
    const { a, b } = await twoDevices();
    b.clock.advance(HLC_REMOTE_MAX_AHEAD_MS + 3_600_000);
    await b.repo.createTask({ id: "t1", title: "From the far future", bucket: "inbox" });
    const before = await syncState(a.db);
    const failure = await a.repo
      .applySyncBundle("gtd", await b.repo.listSyncChanges("gtd"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncClockError);
    expect(failure).toMatchObject({ code: "remote_too_far_ahead" });
    expect(await syncState(a.db)).toEqual(before);
    expect(await a.db.select("SELECT * FROM gtd_tasks")).toEqual([]);
  });

  it("rejects a clock at the very top of the range instead of crashing the clock", async () => {
    const { a, b } = await twoDevices();
    const top = encodeHlc(HLC_MAX_PHYSICAL_MS, HLC_MAX_COUNTER, b.deviceId);
    const bad = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      draft.hlcHigh = top;
    });
    const before = await syncState(a.db);
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toMatchObject({
      code: "remote_too_far_ahead",
    });
    expect(await syncState(a.db)).toEqual(before);
    // The clock is not wedged: local edits still work.
    await a.repo.createTask({ id: "still-works", title: "ok", bucket: "inbox" });
  });

  it("does not move the clock when the bundle is already behind it", async () => {
    const { sim, a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    const first = await sim.exchange(b, a, "gtd");
    expect(first.hlcAdvanced).toBe(true);
    const clock = await readIdentity(a.db);
    const second = await sim.exchange(b, a, "gtd");
    expect(second.hlcAdvanced).toBe(false);
    expect(await readIdentity(a.db)).toEqual(clock);
  });
});

describe("refusals", () => {
  it("refuses a bundle for another domain than the one requested", async () => {
    const { a, b } = await twoDevices();
    const changeSet = await b.repo.listSyncChanges("gtd");
    await expect(a.repo.applySyncBundle("personal", changeSet)).rejects.toMatchObject({
      name: "SyncApplyError",
      code: "domain_mismatch",
    });
  });

  it("refuses an entity of another domain inside the bundle", async () => {
    const { a, b } = await twoDevices();
    const bad = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      draft.entities.push({
        table: "daily_entries",
        entityId: "2026-10-04",
        row: { date: "2026-10-04", status: "not_started" },
        fieldClocks: {},
        rowHlc: draft.hlcHigh,
        deletedAt: null,
      });
    });
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toMatchObject({
      name: "SyncChangeSetError",
      code: "table_not_in_domain",
    });
    expect(await a.db.select("SELECT * FROM daily_entries")).toEqual([]);
  });

  const unsupported: [string, "gtd" | "personal" | "finance", string, string, Draft][] = [
    ["a Pomodoro session", "gtd", "pomodoro_sessions", "s1", { id: "s1" }],
    ["a Pomodoro segment", "gtd", "pomodoro_segments", "seg1", { id: "seg1" }],
    [
      "a recurrence sidecar row",
      "gtd",
      "sync_recurrence_clears",
      "tpl-1",
      { template_id: "tpl-1" },
    ],
    [
      "an AI proposal (monotonic status, foreign key)",
      "personal",
      "ai_proposals",
      "p1",
      { id: "p1" },
    ],
    [
      "a weekly objective (parent of a cascading foreign key)",
      "personal",
      "weekly_objectives",
      "o1",
      { id: "o1" },
    ],
    [
      "a weekly objective result (foreign key)",
      "personal",
      "weekly_objective_results",
      JSON.stringify(["2026-10-04", "o1"]),
      { week_start_date: "2026-10-04", objective_id: "o1" },
    ],
    ["an AI memory (row clock)", "personal", "ai_memories", "m1", { id: "m1" }],
    ["a finance account (row clock)", "finance", "finance_accounts", "acc-1", { id: "acc-1" }],
    [
      "a finance transaction split (child set)",
      "finance",
      "finance_transaction_splits",
      "split-1",
      { id: "split-1" },
    ],
  ];

  it.each(unsupported)(
    "refuses the WHOLE bundle when it mentions %s, naming the table",
    async (_label, domain, table, id, row) => {
      const { a, b } = await twoDevices();
      await b.repo.createTask({ id: "t1", title: "Would have applied", bucket: "inbox" });
      const base = await b.repo.listSyncChanges(domain);
      const bad = mutated(base, (draft) => {
        draft.entities.push({
          table,
          entityId: id,
          row,
          fieldClocks: {},
          rowHlc: draft.hlcHigh,
          deletedAt: null,
        });
      });
      const before = await syncState(a.db);
      const failure = await a.repo.applySyncBundle(domain, bad).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SyncApplyError);
      expect(failure).toMatchObject({ code: "unsupported_merge_class", table });
      expect(await syncState(a.db)).toEqual(before);
      expect(await a.db.select("SELECT * FROM gtd_tasks")).toEqual([]);
    },
  );

  it("refuses when change capture is not enabled on the receiver", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const b = sim.device("B");
    const bare = (await createSyncHarness(["X"], { enableCapture: false })).device("X");
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    await expect(
      bare.repo.applySyncBundle("gtd", await b.repo.listSyncChanges("gtd")),
    ).rejects.toMatchObject({ code: "capture_disabled" });
    expect(await bare.db.select("SELECT * FROM gtd_tasks")).toEqual([]);
  });

  it("refuses a change set from a newer schema", async () => {
    const { a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From B", bucket: "inbox" });
    const newer = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      draft.schemaVersion += 1;
    });
    const before = await syncState(a.db);
    await expect(a.repo.applySyncBundle("gtd", newer)).rejects.toMatchObject({
      code: "schema_newer_than_local",
    });
    expect(await syncState(a.db)).toEqual(before);
  });

  it("refuses an unknown format version and garbage", async () => {
    const { a, b } = await twoDevices();
    const changeSet = await b.repo.listSyncChanges("gtd");
    await expect(
      a.repo.applySyncBundle("gtd", { ...changeSet, formatVersion: 2 } as never),
    ).rejects.toMatchObject({ code: "unsupported_format_version" });
    await expect(a.repo.applySyncBundle("gtd", null as never)).rejects.toBeInstanceOf(
      SyncChangeSetError,
    );
    await expect(a.repo.applySyncBundle("nope" as never, changeSet)).rejects.toBeDefined();
  });

  it("needs a sync identity", async () => {
    const { b } = await twoDevices();
    const sim = await createSyncHarness(["X"]);
    const x = sim.device("X");
    await x.db.execute("DELETE FROM sync_identity");
    await expect(
      x.repo.applySyncBundle("gtd", await b.repo.listSyncChanges("gtd")),
    ).rejects.toMatchObject({ code: "identity_missing" });
  });
});

describe("settings can never smuggle a secret or a device key", () => {
  const withSetting = async (domain: "gtd" | "personal", key: string, value: unknown) => {
    const { a, b } = await twoDevices();
    const base = await b.repo.listSyncChanges(domain);
    return {
      a,
      bundle: mutated(base, (draft) => {
        draft.settings.push({ key, value, rowHlc: draft.hlcHigh });
      }),
    };
  };

  for (const [domain, key] of [
    ["personal", "aiApiKey"],
    ["gtd", "aiApiKey"],
    ["personal", "rescuetimeApiKey"],
    ["personal", "llmBridgeToken"],
    ["gtd", "backupDestinationDir"],
    ["gtd", "autoBackupEnabled"],
    ["personal", "aiBaseUrl"],
    ["gtd", "aiModel"],
    ["personal", "language"],
  ] as const) {
    it(`rejects a ${domain} bundle carrying ${key} and writes nothing`, async () => {
      const { a, bundle } = await withSetting(domain, key, "sk-malicious");
      const before = await syncState(a.db);
      const settingsBefore = await a.repo.getSettings();
      await expect(a.repo.applySyncBundle(domain, bundle)).rejects.toMatchObject({
        name: "SyncChangeSetError",
        code: "setting_not_syncable",
      });
      expect(await a.repo.getSettings()).toEqual(settingsBefore);
      expect(await syncState(a.db)).toEqual(before);
    });
  }

  it.each([
    ["personal", "aiApiKey", "a secret"],
    ["gtd", "backupDestinationDir", "a device key"],
    ["gtd", "aiModel", "a key of another domain"],
    ["personal", "language", "a key of another domain"],
  ] as const)(
    "holds even when validation is bypassed: the apply step re-checks %s/%s (%s)",
    async (domain, key, _label) => {
      const { a, bundle } = await withSetting(domain, key, "malicious");
      const before = await syncState(a.db);
      const settingsBefore = await a.repo.getSettings();
      await expect(
        runSqliteTransaction(a.db, async (tx) =>
          applyChangeSet(transactionDb(tx), bundle, {
            nowMs: a.clock.now,
            settings: plainSettingsAccess,
          }),
        ),
      ).rejects.toMatchObject({ name: "SyncApplyError", code: "setting_not_syncable" });
      expect(await a.repo.getSettings()).toEqual(settingsBefore);
      expect(await syncState(a.db)).toEqual(before);
    },
  );

  it("merges settings by their registry rule", async () => {
    const { sim, a, b } = await twoDevices();
    a.clock.advance(1_000);
    await a.repo.updateSettings((current) => ({
      ...current,
      previousDayReviewDoneDate: "2026-10-10",
      aiModel: "vendor/a",
    }));
    b.clock.advance(60_000); // later clock, earlier date: a date that only moves forward must not go back
    await b.repo.updateSettings((current) => ({
      ...current,
      previousDayReviewDoneDate: "2026-10-05",
      aiModel: "vendor/b",
    }));
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      const settings = await device.repo.getSettings();
      expect(settings.previousDayReviewDoneDate).toBe("2026-10-10");
      expect(settings.aiModel).toBe("vendor/b"); // lww: B's later write
    }

    // One-time marker: any value beats none, the earlier completion stays.
    a.clock.advance(1_000);
    await a.repo.updateSettings((current) => ({
      ...current,
      gtdImportDoneAt: "2026-10-02T00:00:00.000Z",
    }));
    b.clock.advance(1_000);
    await b.repo.updateSettings((current) => ({
      ...current,
      gtdImportDoneAt: "2026-10-01T00:00:00.000Z",
    }));
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect((await device.repo.getSettings()).gtdImportDoneAt).toBe("2026-10-01T00:00:00.000Z");
    }
    await sim.expectConverged("gtd");
    await sim.expectConverged("personal");
  });

  it("a merged setting is snapshotted, so a later local edit stamps only that key", async () => {
    const { sim, a, b } = await twoDevices();
    b.clock.advance(1_000);
    await b.repo.updateSettings((current) => ({ ...current, aiModel: "vendor/b" }));
    await sim.exchange(b, a, "personal");
    const merged = await readMetaOf(a.db, "setting", "aiModel");
    expect(merged?.row_hlc).toContain(b.deviceId);
    expect(await stampDirtyEntities(a.db, a.clock.now)).toBe(0);

    a.clock.advance(60_000);
    await a.repo.updateSettings((current) => ({ ...current, aiMaxTokens: 1234 }));
    expect((await readMetaOf(a.db, "setting", "aiModel"))?.row_hlc).toBe(merged?.row_hlc);
    expect((await readMetaOf(a.db, "setting", "aiMaxTokens"))?.row_hlc).toContain(a.deviceId);
  });
});

describe("unique keys", () => {
  it("aborts the whole bundle on a declared natural key collision, with a distinct code", async () => {
    const { a, b } = await twoDevices();
    await a.repo.saveContext({ id: "ctx-a", name: "Maison", createdAt: "", updatedAt: "" });
    await b.repo.saveContext({ id: "ctx-b", name: "Maison", createdAt: "", updatedAt: "" });
    await b.repo.createTask({ id: "t-from-b", title: "Rides along", bucket: "inbox" });
    const before = await syncState(a.db);

    const failure = await a.repo
      .applySyncBundle("gtd", await b.repo.listSyncChanges("gtd"))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncApplyError);
    expect(failure).toMatchObject({ code: "natural_key_collision", table: "gtd_contexts" });
    expect((failure as SyncApplyError).index).toBeTruthy();
    expect((failure as SyncApplyError).message).toContain("gtd_contexts");
    expect(await syncState(a.db)).toEqual(before);
    expect((await a.repo.listTasks({})).map((task) => task.id)).toEqual([]);
  });

  it("aborts on a task natural key (source_external_id) too", async () => {
    const { a, b } = await twoDevices();
    await a.repo.createTask({
      id: "t-a",
      title: "Draw",
      bucket: "inbox",
      sourceExternalId: "draw:2026-10-04",
    });
    await b.repo.createTask({
      id: "t-b",
      title: "Draw",
      bucket: "inbox",
      sourceExternalId: "draw:2026-10-04",
    });
    await expect(
      a.repo.applySyncBundle("gtd", await b.repo.listSyncChanges("gtd")),
    ).rejects.toMatchObject({ code: "natural_key_collision", table: "gtd_tasks" });
  });

  it("aborts with a different code, naming the index, on a unique key the registry does not declare", async () => {
    const { a, b } = await twoDevices();
    await a.db.execute(
      "CREATE UNIQUE INDEX test_only_unique_notes ON gtd_tasks (notes) WHERE notes <> ''",
    );
    await a.repo.createTask({ id: "t-a", title: "A", notes: "same notes", bucket: "inbox" });
    await b.repo.createTask({ id: "t-b", title: "B", notes: "same notes", bucket: "inbox" });
    const before = await syncState(a.db);

    const failure = await a.repo
      .applySyncBundle("gtd", await b.repo.listSyncChanges("gtd"))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SyncApplyError",
      code: "unique_violation",
      table: "gtd_tasks",
    });
    expect((failure as SyncApplyError).index).toBe("test_only_unique_notes");
    expect(await syncState(a.db)).toEqual(before);
  });
});

describe("overwritten-edit log", () => {
  it("never logs identical values, and ignores updated_at / created_at differences", async () => {
    const { sim, a, b } = await twoDevices();
    const make = (device: SyncDevice, stamp: string) =>
      device.repo.createTask({
        id: "t1",
        title: "Same title",
        bucket: "inbox",
        createdAt: stamp,
        updatedAt: stamp,
      });
    a.clock.advance(1_000);
    await make(a, "2026-10-01T10:00:00.000Z");
    b.clock.advance(5_000);
    await make(b, "2026-10-02T10:00:00.000Z");

    await sim.syncAll("gtd");

    expect(await readConflicts(a)).toEqual([]);
    expect(await readConflicts(b)).toEqual([]);
    await sim.expectConverged("gtd");
  });

  it("is informational: a concurrent edit that lost is logged with both values and clocks", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", notes: "n", bucket: "inbox" });
    await sim.syncAll("gtd");
    a.clock.advance(1_000);
    await editTask(a, "t1", { notes: "A's notes" });
    b.clock.advance(9_000);
    await editTask(b, "t1", { notes: "B's notes" });
    await sim.exchange(b, a, "gtd");

    const [conflict] = await readConflicts(a);
    expect(conflict).toMatchObject({
      entity_type: "gtd_tasks",
      entity_id: "t1",
      kind: "overwritten_edit",
    });
    expect(conflict?.id).toMatch(/^overwritten:/);
    expect(conflict?.detected_at).toBe(new Date(a.clock.now).toISOString());
  });
});

describe("schema skew between the laptops", () => {
  it("keeps the local value of a column the sender's row lacks and ignores columns it does not know", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({
      id: "t1",
      title: "Plan",
      bucket: "inbox",
      sourceUrl: "https://example.test/x",
    });
    await sim.syncAll("gtd");
    b.clock.advance(5_000);
    await editTask(b, "t1", { title: "Edited on B" });

    const older = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      const entity = draft.entities.find((item: Draft) => item.entityId === "t1");
      delete entity.row.source_url; // a schema that predates the column
      delete entity.row.planned_order;
      delete entity.fieldClocks.source_url;
      entity.row.column_from_a_newer_schema = "ignored";
      entity.fieldClocks.column_from_a_newer_schema = draft.hlcHigh;
    });
    await a.repo.applySyncBundle("gtd", older);

    const merged = await findTask(a, "t1");
    expect(merged).toMatchObject({ title: "Edited on B", sourceUrl: "https://example.test/x" });
    const columns = (await a.db.select<{ name: string }[]>("PRAGMA table_info(gtd_tasks)")).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("column_from_a_newer_schema");
    expect(Object.keys(clocksOf(await readMetaOf(a.db, "gtd_tasks", "t1")))).not.toContain(
      "column_from_a_newer_schema",
    );
  });

  it("inserts an entity from an older schema, leaving the missing columns at their defaults", async () => {
    const { a, b } = await twoDevices();
    await b.repo.createTask({ id: "t1", title: "From an older laptop", bucket: "inbox" });
    const older = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      const entity = draft.entities.find((item: Draft) => item.table === "gtd_tasks");
      for (const column of [
        "planned_order",
        "source_url",
        "deadline",
        "pending_past_recurrences",
      ]) {
        delete entity.row[column];
      }
    });
    await a.repo.applySyncBundle("gtd", older);
    expect(await findTask(a, "t1")).toMatchObject({
      title: "From an older laptop",
      pendingPastRecurrences: 0,
    });
  });
});

describe("grow-only union tables", () => {
  it("inserts missing rows, never updates an existing one, and ignores a dedupe_key collision", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await sim.syncAll("gtd");
    const events = await a.db.select<
      { id: string; dedupe_key: string | null; event_date: string }[]
    >("SELECT id, dedupe_key, event_date FROM gtd_task_events ORDER BY id");
    expect(events.length).toBeGreaterThan(0);
    const first = events[0] as { id: string; event_date: string };

    // The sender "rewrites" an event it already has and invents a second id for a known dedupe key.
    const tampered = mutated(await b.repo.listSyncChanges("gtd"), (draft) => {
      const rows = draft.unionRows.gtd_task_events;
      rows.find((row: Draft) => row.id === first.id).event_date = "1999-01-01";
      const withKey = rows.find((row: Draft) => row.dedupe_key);
      if (withKey) rows.push({ ...withKey, id: "event-with-a-second-id" });
    });
    const result = await a.repo.applySyncBundle("gtd", tampered);

    expect(result.applied).toBe(0);
    expect(
      (
        await a.db.select<{ event_date: string }[]>(
          "SELECT event_date FROM gtd_task_events WHERE id = $1",
          [first.id],
        )
      )[0]?.event_date,
    ).toBe(first.event_date);
    expect(
      await a.db.select("SELECT id FROM gtd_task_events WHERE id = 'event-with-a-second-id'"),
    ).toEqual([]);
  });
});
