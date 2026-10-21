// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RecurringTaskTemplate } from "../../domain/types";
import * as recurringTemplatesRows from "../storage/sqlite/rows/recurringTemplates";
import type { Database } from "../storage/sqlite-db";
import {
  captureRecurringInstance,
  ensureInstanceOccurrences,
  isGeneratorPullBack,
} from "./capture-recurrence";
import { createCaptureDb, CAPTURE_DEVICE } from "./capture-test-utils";
import { encodeHlc } from "./hlc";

const TEMPLATE = "tpl-1";
const HLC = encodeHlc(1_800_000_000_000, 0, CAPTURE_DEVICE);

const template = (overrides: Partial<RecurringTaskTemplate> = {}): RecurringTaskTemplate => ({
  id: TEMPLATE,
  title: "Habit",
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
  startDate: "2026-03-01",
  status: "active",
  lastGeneratedForDate: "2026-03-15",
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-03-01T00:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
  ...overrides,
});

const seed = async (overrides: Partial<RecurringTaskTemplate> = {}): Promise<Database> => {
  const db = await createCaptureDb();
  await db.execute(
    `INSERT INTO recurring_task_templates (${recurringTemplatesRows.COLUMNS}) VALUES (${Array.from({ length: 22 }, (_, i) => `$${i + 1}`).join(", ")})`,
    recurringTemplatesRows.toParams(template(overrides)),
  );
  return db;
};

const instance = (due: string, status = "active", pending = 0): Record<string, unknown> => ({
  id: `recurring-task:${TEMPLATE}`,
  is_recurring_instance: 1,
  recurring_template_id: TEMPLATE,
  recurrence_due_date: due,
  status,
  pending_past_recurrences: pending,
});

const outcomes = async (db: Database) =>
  Object.fromEntries(
    (
      await db.select<{ due_date: string; outcome: string }[]>(
        "SELECT due_date, outcome FROM sync_recurrence_occurrences ORDER BY due_date",
      )
    ).map((row) => [row.due_date, row.outcome]),
  );

const clears = async (db: Database) =>
  (
    await db.select<{ cleared_through_date: string }[]>(
      "SELECT cleared_through_date FROM sync_recurrence_clears",
    )
  ).map((row) => row.cleared_through_date);

describe("a generator pull-back is not a user outcome", () => {
  const TODAY = "2026-10-20";

  it("an instance cancelled while due after local today with the watermark cleared records nothing", async () => {
    const db = await seed({ lastGeneratedForDate: null, startDate: "2026-10-21" });
    const previous = instance("2026-10-21");
    await captureRecurringInstance(db, previous, instance("2026-10-21", "cancelled"), HLC, TODAY);
    expect(await outcomes(db)).toEqual({});
    expect(await clears(db)).toEqual([]);
    expect(await isGeneratorPullBack(db, TEMPLATE, "cancelled")).toBe(true);
    expect(
      await isGeneratorPullBack(db, TEMPLATE, "cancelled", { due: "2026-10-21", today: TODAY }),
    ).toBe(true);
  });

  it("a user's cancel of a future-dated instance (watermark still set) is recorded", async () => {
    const db = await seed({ lastGeneratedForDate: "2026-10-21", startDate: "2026-10-21" });
    await captureRecurringInstance(
      db,
      instance("2026-10-21"),
      instance("2026-10-21", "cancelled"),
      HLC,
      TODAY,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-21": "cancelled" });
  });

  it("a stale editor nulled the watermark: the user's cancel of an instance due today is still recorded", async () => {
    // A template card loaded before the first generation saves `lastGeneratedForDate: null`; the
    // watermark is no proof of a pull-back for a live cancel of an instance that is already due.
    const db = await seed({ lastGeneratedForDate: null });
    await captureRecurringInstance(
      db,
      instance("2026-10-20"),
      instance("2026-10-20", "cancelled"),
      HLC,
      TODAY,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-20": "cancelled" });
    const earlier = await seed({ lastGeneratedForDate: null });
    await captureRecurringInstance(
      earlier,
      instance("2026-10-18"),
      instance("2026-10-18", "cancelled"),
      HLC,
      TODAY,
    );
    expect(await outcomes(earlier)).toEqual({ "2026-10-18": "cancelled" });
  });

  it("residue already in a snapshot (creation) is bookkeeping on and after its due date", async () => {
    // The lagging laptop's day caught up before the row was first stamped: only the cleared
    // watermark can tell, and it decides.
    const db = await seed({ lastGeneratedForDate: null });
    await captureRecurringInstance(db, null, instance("2026-10-20", "cancelled"), HLC, TODAY);
    expect(await outcomes(db)).toEqual({ "2026-10-20": "active" });
  });

  it("a user's cancel on or before today (watermark set) is recorded", async () => {
    const db = await seed({ lastGeneratedForDate: "2026-10-20" });
    await captureRecurringInstance(
      db,
      instance("2026-10-20"),
      instance("2026-10-20", "cancelled"),
      HLC,
      TODAY,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-20": "cancelled" });
  });

  it("generating forward from the residue passes the date over; it is not a user cancel", async () => {
    // Snapshot: cancelled by the pull-back, occurrence left active. Two days later the generator
    // builds a new active instance on the same row id.
    const db = await seed({ lastGeneratedForDate: "2026-10-22", startDate: "2026-10-21" });
    await db.execute(
      "INSERT INTO sync_recurrence_occurrences (template_id, due_date, outcome, outcome_hlc, device_id) VALUES ($1, '2026-10-21', 'active', $2, $3)",
      [TEMPLATE, HLC, CAPTURE_DEVICE],
    );
    await captureRecurringInstance(
      db,
      instance("2026-10-21", "cancelled", 0),
      instance("2026-10-22", "active", 1),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-21": "missed", "2026-10-22": "active" });
    expect(await clears(db)).toEqual([]);
  });

  it("generating forward from a residue that was never recorded behaves the same", async () => {
    const db = await seed({ lastGeneratedForDate: "2026-10-22", startDate: "2026-10-21" });
    await captureRecurringInstance(
      db,
      instance("2026-10-21", "cancelled", 0),
      instance("2026-10-22", "active", 1),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-21": "missed", "2026-10-22": "active" });
  });

  it("generating forward from a cancel the user made keeps it cancelled and clears the old backlog", async () => {
    const db = await seed({ lastGeneratedForDate: "2026-10-22", startDate: "2026-10-21" });
    await db.execute(
      "INSERT INTO sync_recurrence_occurrences (template_id, due_date, outcome, outcome_hlc, device_id) VALUES ($1, '2026-10-21', 'cancelled', $2, $3)",
      [TEMPLATE, HLC, CAPTURE_DEVICE],
    );
    await captureRecurringInstance(
      db,
      instance("2026-10-21", "cancelled", 0),
      instance("2026-10-22", "active", 0),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-21": "cancelled", "2026-10-22": "active" });
    expect(await clears(db)).toEqual(["2026-10-21"]);
  });

  it("a completion is never mistaken for a pull-back", async () => {
    const db = await seed({ lastGeneratedForDate: null });
    await captureRecurringInstance(
      db,
      instance("2026-10-21"),
      instance("2026-10-21", "completed"),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-10-21": "completed" });
  });

  it("the baseline pass applies the same rule", async () => {
    const db = await seed({ lastGeneratedForDate: null, startDate: "2026-10-21" });
    await db.execute(
      `INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, created_at, updated_at,
         recurring_template_id, recurrence_due_date, is_recurring_instance, pending_past_recurrences)
       VALUES ('recurring-task:${TEMPLATE}', 't', '', 'cancelled', 'next_action', '[]', 'manual', 't', 't', '${TEMPLATE}', '2026-10-21', 1, 0)`,
    );
    await ensureInstanceOccurrences(db, async () => HLC);
    expect(await outcomes(db)).toEqual({ "2026-10-21": "active" });
  });
});

describe("what an advance records is bounded by the row's own backlog", () => {
  it("records every passed date when the backlog grew by that many", async () => {
    const db = await seed();
    await captureRecurringInstance(
      db,
      instance("2026-03-15"),
      instance("2026-03-18", "active", 3),
      HLC,
    );
    expect(await outcomes(db)).toEqual({
      "2026-03-15": "missed",
      "2026-03-16": "missed",
      "2026-03-17": "missed",
      "2026-03-18": "active",
    });
  });

  it("does not record a date as missed that a collapsed multi-step advance completed in between", async () => {
    // 15 active -> (16 completed, 17 missed) -> 18 active, seen by the stamper as one step: the
    // generator's own backlog is 1, so only the latest passed date is missed.
    const db = await seed();
    await captureRecurringInstance(
      db,
      instance("2026-03-15"),
      instance("2026-03-18", "active", 1),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-03-17": "missed", "2026-03-18": "active" });
  });

  it("records no missed date when the backlog did not grow", async () => {
    const db = await seed();
    await captureRecurringInstance(
      db,
      instance("2026-03-15"),
      instance("2026-03-18", "active", 0),
      HLC,
    );
    expect(await outcomes(db)).toEqual({ "2026-03-18": "active" });
  });

  it("after a terminal previous state the whole new backlog counts and the old one is cleared", async () => {
    const db = await seed();
    await captureRecurringInstance(
      db,
      instance("2026-03-15", "completed", 4),
      instance("2026-03-18", "active", 2),
      HLC,
    );
    expect(await outcomes(db)).toEqual({
      "2026-03-15": "completed",
      "2026-03-16": "missed",
      "2026-03-17": "missed",
      "2026-03-18": "active",
    });
    expect(await clears(db)).toEqual(["2026-03-15"]);
  });
});
