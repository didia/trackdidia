import {
  type CalendarSyncDetachReason,
  type CalendarSyncLink,
  type CalendarSyncSettings,
  defaultCalendarSyncSettings,
} from "../../domain/calendar-sync";

const linkKey = (taskId: string, occurrenceKey: string): string =>
  `${taskId}\u0000${occurrenceKey}`;

const cloneLink = (link: CalendarSyncLink): CalendarSyncLink => ({ ...link });

/**
 * In-memory mirror of `CalendarSyncSqliteStore`, used by `MemoryRepository`. All methods
 * are synchronous so the promotion-capture step stays in the same synchronous block as
 * the promotion write, matching the SQLite store's "same transaction" guarantee.
 */
export class CalendarSyncMemoryStore {
  private settings: CalendarSyncSettings = defaultCalendarSyncSettings(new Date().toISOString());
  private links = new Map<string, CalendarSyncLink>();

  getSettings(): CalendarSyncSettings {
    return { ...this.settings };
  }

  saveSettings(settings: CalendarSyncSettings): CalendarSyncSettings {
    const previous = this.settings;
    const hadIdentity = previous.connectedAccountId !== null || previous.calendarId !== null;
    const identityChanged =
      hadIdentity &&
      (previous.connectedAccountId !== settings.connectedAccountId ||
        previous.calendarId !== settings.calendarId);
    const next: CalendarSyncSettings = identityChanged
      ? { ...settings, generation: previous.generation + 1 }
      : settings;

    this.settings = { ...next };
    if (identityChanged) {
      this.clearLinks();
    }
    return { ...next };
  }

  listLinks(): CalendarSyncLink[] {
    return [...this.links.values()]
      .sort(
        (a, b) =>
          a.taskId.localeCompare(b.taskId) || a.occurrenceKey.localeCompare(b.occurrenceKey),
      )
      .map(cloneLink);
  }

  getLink(taskId: string, occurrenceKey: string): CalendarSyncLink | null {
    const link = this.links.get(linkKey(taskId, occurrenceKey));
    return link ? cloneLink(link) : null;
  }

  saveLink(link: CalendarSyncLink): CalendarSyncLink {
    this.links.set(linkKey(link.taskId, link.occurrenceKey), cloneLink(link));
    return cloneLink(link);
  }

  deleteLink(taskId: string, occurrenceKey: string): void {
    this.links.delete(linkKey(taskId, occurrenceKey));
  }

  detachLink(
    taskId: string,
    occurrenceKey: string,
    reason: CalendarSyncDetachReason,
    now: string,
  ): void {
    const existing = this.links.get(linkKey(taskId, occurrenceKey));
    if (!existing) {
      return;
    }
    this.links.set(linkKey(taskId, occurrenceKey), {
      ...existing,
      state: "detached",
      detachReason: reason,
      updatedAt: now,
    });
  }

  clearLinks(): void {
    this.links.clear();
  }
}
