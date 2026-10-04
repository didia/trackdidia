import {
  type CalendarSyncDetachReason,
  type CalendarSyncLink,
  type CalendarSyncLinkState,
  type CalendarSyncSettings,
  defaultCalendarSyncSettings,
} from "../../domain/calendar-sync";
import type { Database } from "./email-triage-sqlite-db";

interface SettingsRow {
  enabled: number;
  provider: CalendarSyncSettings["provider"];
  oauth_client_id: string;
  connected_account_id: string | null;
  calendar_id: string | null;
  calendar_summary: string;
  default_duration_minutes: number;
  include_notes: number;
  mark_busy: number;
  reminders_enabled: number;
  state: CalendarSyncSettings["state"];
  generation: number;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const mapSettings = (row: SettingsRow): CalendarSyncSettings => ({
  enabled: Boolean(row.enabled),
  provider: row.provider,
  oauthClientId: row.oauth_client_id,
  connectedAccountId: row.connected_account_id,
  calendarId: row.calendar_id,
  calendarSummary: row.calendar_summary,
  defaultDurationMinutes: row.default_duration_minutes,
  includeNotes: Boolean(row.include_notes),
  markBusy: Boolean(row.mark_busy),
  remindersEnabled: Boolean(row.reminders_enabled),
  state: row.state,
  generation: row.generation,
  lastSyncAt: row.last_sync_at,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface LinkRow {
  task_id: string;
  occurrence_key: string;
  calendar_id: string;
  event_id: string | null;
  generation: number;
  state: CalendarSyncLinkState;
  payload_signature: string;
  event_start_at: string;
  detach_reason: CalendarSyncDetachReason | null;
  failure_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const mapLink = (row: LinkRow): CalendarSyncLink => ({
  taskId: row.task_id,
  occurrenceKey: row.occurrence_key,
  calendarId: row.calendar_id,
  eventId: row.event_id,
  generation: row.generation,
  state: row.state,
  payloadSignature: row.payload_signature,
  eventStartAt: row.event_start_at,
  detachReason: row.detach_reason,
  failureCount: row.failure_count,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * SQLite-backed store for calendar sync settings and links. Follows the
 * `EmailTriageSqliteStore` precedent: constructed with `() => this.getDb()`, its methods
 * are plain delegating calls that never enter the writer queue themselves — the
 * promotion-capture step in `TauriSqliteRepository` reaches it directly
 * (`this.getCalendarSyncStore()`) from inside its own `writeTransaction`, and
 * `DbSerialQueue` is not reentrant. The repository's public mutators wrap these calls in
 * `writeExclusive`/`writeTransaction` so they serialize with every other writer.
 */
export class CalendarSyncSqliteStore {
  constructor(private readonly getDb: () => Promise<Database>) {}

  async getSettings(): Promise<CalendarSyncSettings> {
    const db = await this.getDb();
    const rows = await db.select<SettingsRow[]>(
      "SELECT * FROM calendar_sync_settings WHERE id = 'global'",
    );
    return rows[0] ? mapSettings(rows[0]) : defaultCalendarSyncSettings(new Date().toISOString());
  }

  /**
   * Upserts settings. Bumps `generation` and clears every link when `connectedAccountId`
   * or `calendarId` changes relative to the stored row; a plain disconnect (neither field
   * changes) keeps `generation` and links intact.
   */
  async saveSettings(settings: CalendarSyncSettings): Promise<CalendarSyncSettings> {
    const previous = await this.getSettings();
    const hadIdentity = previous.connectedAccountId !== null || previous.calendarId !== null;
    const identityChanged =
      hadIdentity &&
      (previous.connectedAccountId !== settings.connectedAccountId ||
        previous.calendarId !== settings.calendarId);
    const next: CalendarSyncSettings = identityChanged
      ? { ...settings, generation: previous.generation + 1 }
      : settings;

    const db = await this.getDb();
    await db.execute(
      `INSERT INTO calendar_sync_settings (
        id, enabled, provider, oauth_client_id, connected_account_id, calendar_id, calendar_summary,
        default_duration_minutes, include_notes, mark_busy, reminders_enabled, state, generation,
        last_sync_at, last_error, created_at, updated_at
      ) VALUES ('global', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        provider = excluded.provider,
        oauth_client_id = excluded.oauth_client_id,
        connected_account_id = excluded.connected_account_id,
        calendar_id = excluded.calendar_id,
        calendar_summary = excluded.calendar_summary,
        default_duration_minutes = excluded.default_duration_minutes,
        include_notes = excluded.include_notes,
        mark_busy = excluded.mark_busy,
        reminders_enabled = excluded.reminders_enabled,
        state = excluded.state,
        generation = excluded.generation,
        last_sync_at = excluded.last_sync_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        next.enabled ? 1 : 0,
        next.provider,
        next.oauthClientId,
        next.connectedAccountId,
        next.calendarId,
        next.calendarSummary,
        next.defaultDurationMinutes,
        next.includeNotes ? 1 : 0,
        next.markBusy ? 1 : 0,
        next.remindersEnabled ? 1 : 0,
        next.state,
        next.generation,
        next.lastSyncAt,
        next.lastError,
        next.createdAt,
        next.updatedAt,
      ],
    );

    if (identityChanged) {
      await this.clearLinks();
    }

    return next;
  }

  async listLinks(): Promise<CalendarSyncLink[]> {
    const db = await this.getDb();
    const rows = await db.select<LinkRow[]>(
      "SELECT * FROM calendar_sync_links ORDER BY task_id, occurrence_key",
    );
    return rows.map(mapLink);
  }

  async getLink(taskId: string, occurrenceKey: string): Promise<CalendarSyncLink | null> {
    const db = await this.getDb();
    const rows = await db.select<LinkRow[]>(
      "SELECT * FROM calendar_sync_links WHERE task_id = $1 AND occurrence_key = $2",
      [taskId, occurrenceKey],
    );
    return rows[0] ? mapLink(rows[0]) : null;
  }

  async saveLink(link: CalendarSyncLink): Promise<CalendarSyncLink> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO calendar_sync_links (
        task_id, occurrence_key, calendar_id, event_id, generation, state, payload_signature,
        event_start_at, detach_reason, failure_count, last_error, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(task_id, occurrence_key) DO UPDATE SET
        calendar_id = excluded.calendar_id,
        event_id = excluded.event_id,
        generation = excluded.generation,
        state = excluded.state,
        payload_signature = excluded.payload_signature,
        event_start_at = excluded.event_start_at,
        detach_reason = excluded.detach_reason,
        failure_count = excluded.failure_count,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        link.taskId,
        link.occurrenceKey,
        link.calendarId,
        link.eventId,
        link.generation,
        link.state,
        link.payloadSignature,
        link.eventStartAt,
        link.detachReason,
        link.failureCount,
        link.lastError,
        link.createdAt,
        link.updatedAt,
      ],
    );
    return link;
  }

  async deleteLink(taskId: string, occurrenceKey: string): Promise<void> {
    const db = await this.getDb();
    await db.execute("DELETE FROM calendar_sync_links WHERE task_id = $1 AND occurrence_key = $2", [
      taskId,
      occurrenceKey,
    ]);
  }

  async detachLink(
    taskId: string,
    occurrenceKey: string,
    reason: CalendarSyncDetachReason,
    now: string,
  ): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `UPDATE calendar_sync_links
       SET state = 'detached', detach_reason = $3, updated_at = $4
       WHERE task_id = $1 AND occurrence_key = $2`,
      [taskId, occurrenceKey, reason, now],
    );
  }

  async clearLinks(): Promise<void> {
    const db = await this.getDb();
    await db.execute("DELETE FROM calendar_sync_links");
  }
}
