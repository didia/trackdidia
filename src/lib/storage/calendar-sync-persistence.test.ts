// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import type { Database } from "./email-triage-sqlite-db";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

/** Wraps a real database and throws once on the first `COMMIT`, simulating a mid-transaction crash. */
const withCommitFailureOnce = (inner: Database): Database => {
  let armed = true;
  return {
    async execute(query, bindValues) {
      if (armed && query.trim().toUpperCase() === "COMMIT") {
        armed = false;
        throw new Error("simulated crash before commit");
      }
      return inner.execute(query, bindValues);
    },
    select: (query, bindValues) => inner.select(query, bindValues),
  };
};

const connectedSettings = () => ({
  enabled: true,
  provider: "google" as const,
  oauthClientId: "",
  connectedAccountId: "account:1",
  calendarId: "calendar:trackdidia",
  calendarSummary: "TrackDidia",
  defaultDurationMinutes: 30,
  includeNotes: false,
  markBusy: false,
  remindersEnabled: false,
  state: "active" as const,
  generation: 1,
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("calendar sync persistence — atomicity with the real SQLite repository", () => {
  it("leaves no orphan pending link when a promotion transaction fails before commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-12T06:00:00.000Z"));

    const realDatabase = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => realDatabase);
    await repository.initialize();
    await repository.saveCalendarSyncSettings(connectedSettings());
    const task = await repository.createTask({
      title: "Due today",
      bucket: "scheduled",
      scheduledFor: "2026-01-12T09:00:00",
    });

    // Swap in a database that fails on the next COMMIT, simulating a crash right after the
    // capture write but before the transaction durably commits.
    const failingDb = withCommitFailureOnce(realDatabase);
    // @ts-expect-error — reaching into the private memoized db promise to inject the failure
    // for this one call, matching the "same transaction" invariant under test.
    repository.dbPromise = Promise.resolve(failingDb);

    await expect(repository.promoteDueScheduledTasks("2026-01-12")).rejects.toThrow(
      "simulated crash before commit",
    );

    // Inspect the raw rows directly: `listTasks()`/any repository read would itself retrigger
    // `promoteDueScheduledTasks`, masking the rollback this test is asserting on.
    const taskRows = await realDatabase.select<
      Array<{ bucket: string; scheduled_for: string | null }>
    >("SELECT bucket, scheduled_for FROM gtd_tasks WHERE id = $1", [task.id]);
    expect(taskRows[0]).toEqual({ bucket: "scheduled", scheduled_for: "2026-01-12T09:00:00" });

    const linkRows = await realDatabase.select<unknown[]>(
      "SELECT * FROM calendar_sync_links WHERE task_id = $1",
      [task.id],
    );
    expect(linkRows).toHaveLength(0);
  });

  it("serializes public calendar writes behind an in-flight promotion transaction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-12T06:00:00.000Z"));

    const realDatabase = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => realDatabase);
    await repository.initialize();
    await repository.saveCalendarSyncSettings(connectedSettings());
    await repository.createTask({
      title: "Due today",
      bucket: "scheduled",
      scheduledFor: "2026-01-12T09:00:00",
    });

    // Hold the promotion at COMMIT, then fail it, while an unrelated calendar write is issued.
    let reachedCommit: () => void = () => {};
    const atCommit = new Promise<void>((resolve) => {
      reachedCommit = resolve;
    });
    let releaseCommit: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const pausedDb: Database = {
      async execute(query, bindValues) {
        if (query.trim().toUpperCase() === "COMMIT") {
          reachedCommit();
          await gate;
          throw new Error("simulated promotion failure");
        }
        return realDatabase.execute(query, bindValues);
      },
      select: (query, bindValues) => realDatabase.select(query, bindValues),
    };
    // @ts-expect-error — reaching into the private memoized db promise to inject the pause.
    repository.dbPromise = Promise.resolve(pausedDb);

    const promotion = repository.promoteDueScheduledTasks("2026-01-12");
    const promotionOutcome = promotion.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await atCommit;

    const otherLink = {
      taskId: "task:other",
      occurrenceKey: "2026-01-14",
      calendarId: "calendar:trackdidia",
      eventId: "event:other",
      generation: 1,
      state: "synced" as const,
      payloadSignature: "{}",
      eventStartAt: "2026-01-14T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const save = repository.saveCalendarSyncLink(otherLink);
    // Let an unserialized write reach the open transaction before the promotion fails.
    await vi.advanceTimersByTimeAsync(50);
    releaseCommit();

    await expect(promotionOutcome).resolves.toBe("simulated promotion failure");
    await save;

    const rows = await realDatabase.select<unknown[]>(
      "SELECT * FROM calendar_sync_links WHERE task_id = 'task:other'",
    );
    expect(rows).toHaveLength(1);
  });
});
