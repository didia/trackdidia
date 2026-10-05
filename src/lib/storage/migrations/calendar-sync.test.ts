// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { TauriSqliteRepository } from "../tauri-sqlite-repository";
import { migrations } from "./index";

describe("migration 40 create_calendar_sync", () => {
  it("is the highest migration id, appended without rewriting earlier migrations", () => {
    const migration = migrations.find((item) => item.id === 40);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("create_calendar_sync");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS calendar_sync_settings");
    expect(migration?.sql).toContain("CREATE TABLE IF NOT EXISTS calendar_sync_links");
    expect(migration?.sql).toContain("PRIMARY KEY (task_id, occurrence_key)");
    expect(migration?.sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_links_event",
    );
    expect(Math.max(...migrations.map((item) => item.id))).toBe(40);
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort((left, right) => left - right),
    );
  });

  it("allows two NULL event_id rows without violating the unique (calendar_id, event_id) index", async () => {
    const database = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();

    const baseLink = {
      calendarId: "calendar:trackdidia",
      eventId: null,
      generation: 1,
      state: "pending" as const,
      payloadSignature: "{}",
      eventStartAt: "2026-01-12T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await repository.saveCalendarSyncLink({
      ...baseLink,
      taskId: "task:1",
      occurrenceKey: "2026-01-12",
    });
    await expect(
      repository.saveCalendarSyncLink({
        ...baseLink,
        taskId: "task:2",
        occurrenceKey: "2026-01-13",
      }),
    ).resolves.toBeDefined();

    const links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.eventId === null)).toBe(true);
  });

  it("rejects two rows sharing the same non-null (calendar_id, event_id) pair", async () => {
    const database = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();

    const baseLink = {
      calendarId: "calendar:trackdidia",
      eventId: "event:shared",
      generation: 1,
      state: "synced" as const,
      payloadSignature: "{}",
      eventStartAt: "2026-01-12T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await repository.saveCalendarSyncLink({
      ...baseLink,
      taskId: "task:1",
      occurrenceKey: "2026-01-12",
    });
    await expect(
      repository.saveCalendarSyncLink({
        ...baseLink,
        taskId: "task:2",
        occurrenceKey: "2026-01-13",
      }),
    ).rejects.toThrow();
  });

  it("stores the composite primary key and defaults", async () => {
    const database = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();

    const settings = await repository.getCalendarSyncSettings();
    expect(settings).toMatchObject({
      enabled: false,
      provider: "google",
      calendarSummary: "TrackDidia",
      defaultDurationMinutes: 30,
      includeNotes: false,
      markBusy: false,
      remindersEnabled: false,
      state: "disconnected",
      generation: 1,
    });

    await repository.saveCalendarSyncLink({
      taskId: "task:1",
      occurrenceKey: "2026-01-12",
      calendarId: "calendar:trackdidia",
      eventId: "event:1",
      generation: 1,
      state: "synced",
      payloadSignature: "{}",
      eventStartAt: "2026-01-12T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Same (task_id, occurrence_key) upserts in place rather than inserting a second row.
    await repository.saveCalendarSyncLink({
      taskId: "task:1",
      occurrenceKey: "2026-01-12",
      calendarId: "calendar:trackdidia",
      eventId: "event:1",
      generation: 1,
      state: "detached",
      payloadSignature: "{}",
      eventStartAt: "2026-01-12T09:00:00",
      detachReason: "completed",
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ state: "detached", detachReason: "completed" });
  });
});
