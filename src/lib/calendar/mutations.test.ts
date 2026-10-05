// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultCalendarSyncSettings, type CalendarSyncLink } from "../../domain/calendar-sync";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "../storage/memory-repository";
import { TauriSqliteRepository } from "../storage/tauri-sqlite-repository";
import { runCalendarSyncMutation, saveCalendarSyncPreferences } from "./mutations";

const factories = {
  memory: () => new MemoryRepository(),
  sqlite: () =>
    new TauriSqliteRepository("sqlite::memory:", async () => createNodeSqliteDatabase()),
};

for (const [name, factory] of Object.entries(factories)) {
  describe(`calendar preference writes (${name})`, () => {
    it("preserves connection identity, generation and links when a save queues behind connect", async () => {
      const repository = factory();
      await repository.initialize();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timestamp = "2026-10-04T10:00:00.000Z";
      const link: CalendarSyncLink = {
        taskId: "task",
        occurrenceKey: "2026-10-04",
        calendarId: "calendar",
        eventId: "event",
        generation: 7,
        state: "synced",
        detachReason: null,
        payloadSignature: "payload",
        eventStartAt: timestamp,
        failureCount: 0,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      // Represents an OAuth attempt from a previous Settings mount.
      const connect = runCalendarSyncMutation(async () => {
        await gate;
        await repository.saveCalendarSyncSettings({
          ...defaultCalendarSyncSettings(timestamp),
          enabled: true,
          oauthClientId: "client",
          connectedAccountId: "person@example.com",
          calendarId: "calendar",
          state: "active",
          generation: 7,
        });
        await repository.saveCalendarSyncLink(link);
      });
      const save = saveCalendarSyncPreferences(repository, {
        enabled: false,
        oauthClientId: " client ",
      });
      release();
      await connect;
      expect(await save).toMatchObject({
        enabled: false,
        oauthClientId: "client",
        connectedAccountId: "person@example.com",
        calendarId: "calendar",
        state: "active",
        generation: 7,
      });
      expect(await repository.listCalendarSyncLinks()).toEqual([link]);
    });
  });
}
