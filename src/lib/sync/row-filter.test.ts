// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import type { SyncEntity } from "./change-set";
import { SyncApplyError } from "./errors";
import { TABLE_REGISTRY } from "./registry";
import {
  assertEntitiesPublishable,
  filteredTables,
  isTerminalSessionStatus,
  publishFilterSql,
  rowPassesFilter,
} from "./row-filter";

const live = (table: string, id: string, row: Record<string, unknown>): SyncEntity => ({
  table,
  entityId: id,
  row,
  fieldClocks: {},
  rowHlc: "001790856000000-000000-dev:00000000-0000-4000-8000-000000000001",
  deletedAt: null,
});

describe("registry row filters as SQL and as a predicate", () => {
  it("has a predicate for every table that has a rowFilter, and no other", () => {
    const filtered = TABLE_REGISTRY.filter((entry) => entry.rowFilter).map((entry) => entry.table);
    expect(filteredTables().sort()).toEqual(filtered.sort());
  });

  it("the SQL filter and the predicate select the same Pomodoro rows (real SQLite)", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const statuses = ["running", "paused", "completed", "cancelled", "weird", ""];
    for (const [index, status] of statuses.entries()) {
      await db.execute(
        "INSERT INTO pomodoro_sessions (id, kind, status, started_at, ends_at, cycle_index, date) VALUES ($1, 'focus', $2, 't', 't', 1, 'd')",
        [`s${index}`, status],
      );
      await db.execute(
        "INSERT INTO pomodoro_segments (id, session_id, started_at) VALUES ($1, $2, 't')",
        [`g${index}`, `s${index}`],
      );
    }
    await db.execute(
      "INSERT INTO pomodoro_segments (id, session_id, started_at) VALUES ('g-orphan', 'nowhere', 't')",
    );

    const sessionSql = publishFilterSql("pomodoro_sessions") as string;
    const sessions = await db.select<{ id: string; status: string }[]>(
      `SELECT id, status FROM pomodoro_sessions WHERE (${sessionSql}) ORDER BY id`,
    );
    const everySession = await db.select<{ id: string; status: string }[]>(
      "SELECT id, status FROM pomodoro_sessions ORDER BY id",
    );
    const byPredicate = everySession.filter((row) =>
      rowPassesFilter("pomodoro_sessions", row, { terminalSessionIds: new Set() }),
    );
    expect(sessions).toEqual(byPredicate);
    expect(sessions.map((row) => row.status)).toEqual(["completed", "cancelled"]);

    const segmentSql = publishFilterSql("pomodoro_segments") as string;
    const segments = await db.select<{ id: string; session_id: string }[]>(
      `SELECT id, session_id FROM pomodoro_segments WHERE (${segmentSql}) ORDER BY id`,
    );
    const everySegment = await db.select<{ id: string; session_id: string }[]>(
      "SELECT id, session_id FROM pomodoro_segments ORDER BY id",
    );
    const terminal = new Set(sessions.map((row) => row.id));
    expect(segments).toEqual(
      everySegment.filter((row) =>
        rowPassesFilter("pomodoro_segments", row, { terminalSessionIds: terminal }),
      ),
    );
    expect(segments.map((row) => row.session_id).sort()).toEqual(["s2", "s3"]);
  });

  it("the statement-snapshot filter agrees too", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const sql = publishFilterSql("finance_account_balance_snapshots") as string;
    expect(sql).toBe("source = 'statement'");
    expect(
      rowPassesFilter(
        "finance_account_balance_snapshots",
        { source: "statement" },
        { terminalSessionIds: new Set() },
      ),
    ).toBe(true);
    expect(
      rowPassesFilter(
        "finance_account_balance_snapshots",
        { source: "derived" },
        { terminalSessionIds: new Set() },
      ),
    ).toBe(false);
  });

  it("treats only completed and cancelled as terminal", () => {
    expect(["completed", "cancelled"].every(isTerminalSessionStatus)).toBe(true);
    expect(
      ["running", "paused", "", "Completed", null, undefined].some(isTerminalSessionStatus),
    ).toBe(false);
  });

  it("an unfiltered table always passes", () => {
    expect(rowPassesFilter("gtd_tasks", {}, { terminalSessionIds: new Set() })).toBe(true);
    expect(publishFilterSql("gtd_tasks")).toBeNull();
  });
});

describe("assertEntitiesPublishable", () => {
  const done = live("pomodoro_sessions", "s1", { id: "s1", status: "completed" });
  const running = live("pomodoro_sessions", "s2", { id: "s2", status: "running" });
  const seg = (id: string, session: string) =>
    live("pomodoro_segments", id, { id, session_id: session });

  it("accepts terminal sessions and their segments", () => {
    expect(() => assertEntitiesPublishable([done, seg("g1", "s1")], "apply")).not.toThrow();
    expect(() => assertEntitiesPublishable([done, seg("g1", "s1")], "publish")).not.toThrow();
  });

  it("refuses a running session on apply with a typed error and on publish with a plain error", () => {
    expect(() => assertEntitiesPublishable([running], "apply")).toThrowError(SyncApplyError);
    try {
      assertEntitiesPublishable([running], "apply");
    } catch (error) {
      expect(error).toMatchObject({ code: "row_filter_violation", table: "pomodoro_sessions" });
    }
    expect(() => assertEntitiesPublishable([running], "publish")).toThrow(/Row filter breach/);
  });

  it("refuses a segment of a non-terminal session of the same set", () => {
    expect(() => assertEntitiesPublishable([running, seg("g1", "s2")], "apply")).toThrow(
      /never publishes/,
    );
  });

  it("on apply leaves a segment of an unmentioned session to the database; on publish it is a breach", () => {
    expect(() => assertEntitiesPublishable([seg("g1", "elsewhere")], "apply")).not.toThrow();
    expect(() => assertEntitiesPublishable([seg("g1", "elsewhere")], "publish")).toThrow();
  });

  it("lets tombstones pass", () => {
    const tombstone: SyncEntity = { ...done, row: null, deletedAt: done.rowHlc };
    expect(() => assertEntitiesPublishable([tombstone], "apply")).not.toThrow();
  });
});
