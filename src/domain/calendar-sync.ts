/**
 * One-way TrackDidia -> Google Calendar sync: domain types shared by the pure planner
 * (`src/lib/calendar/planner.ts`), the eligibility/payload helpers
 * (`src/lib/calendar/eligibility.ts`) and both storage implementations
 * (`src/lib/storage/calendar-sync-{sqlite,memory}-store.ts`). See
 * `specs/todo/calendar-sync.md` for the full design; Phase 0 covers the model and the
 * planner only, no network calls.
 */

export type CalendarSyncProvider = "google";

export type CalendarSyncConnectionState =
  | "disconnected"
  | "active"
  | "reconnect_required"
  | "needs_confirmation";

export interface CalendarSyncSettings {
  enabled: boolean;
  provider: CalendarSyncProvider;
  oauthClientId: string;
  connectedAccountId: string | null;
  calendarId: string | null;
  calendarSummary: string;
  /** No v1 UI; dormant setting. */
  defaultDurationMinutes: number;
  /** No v1 UI; dormant setting. */
  includeNotes: boolean;
  /** No v1 UI; dormant setting. */
  markBusy: boolean;
  /** No v1 UI; dormant setting. */
  remindersEnabled: boolean;
  state: CalendarSyncConnectionState;
  /**
   * Identity epoch of the connection. Bumped when `connectedAccountId` or `calendarId`
   * changes; that bump clears all links. Plain disconnect does not bump it.
   */
  generation: number;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CALENDAR_SYNC_MIN_DURATION_MINUTES = 5;
export const CALENDAR_SYNC_MAX_DURATION_MINUTES = 24 * 60;
export const CALENDAR_SYNC_DEFAULT_DURATION_MINUTES = 30;
export const CALENDAR_SYNC_PENDING_STALENESS_DAYS = 7;

export const clampCalendarSyncDurationMinutes = (minutes: number): number => {
  if (!Number.isFinite(minutes)) {
    return CALENDAR_SYNC_DEFAULT_DURATION_MINUTES;
  }
  return Math.min(
    CALENDAR_SYNC_MAX_DURATION_MINUTES,
    Math.max(CALENDAR_SYNC_MIN_DURATION_MINUTES, Math.round(minutes)),
  );
};

export const defaultCalendarSyncSettings = (now: string): CalendarSyncSettings => ({
  enabled: false,
  provider: "google",
  oauthClientId: "",
  connectedAccountId: null,
  calendarId: null,
  calendarSummary: "TrackDidia",
  defaultDurationMinutes: CALENDAR_SYNC_DEFAULT_DURATION_MINUTES,
  includeNotes: false,
  markBusy: false,
  remindersEnabled: false,
  state: "disconnected",
  generation: 1,
  lastSyncAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
});

export type CalendarSyncLinkState = "pending" | "synced" | "detached" | "failed";

export type CalendarSyncDetachReason =
  | "promoted"
  | "completed"
  | "cancelled"
  | "unscheduled"
  | "task_deleted"
  | "missing_remote";

export interface CalendarSyncLink {
  taskId: string;
  occurrenceKey: string;
  calendarId: string;
  /** Google-assigned; `null` until an event exists (pending, or failed without an event). */
  eventId: string | null;
  generation: number;
  state: CalendarSyncLinkState;
  /**
   * Canonical event body JSON (stable key order), compared with `===`. Doubles as the
   * stored snapshot for `pending` links: the reconciler builds the request from it and
   * never needs the task row.
   */
  payloadSignature: string;
  eventStartAt: string;
  detachReason: CalendarSyncDetachReason | null;
  failureCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Canonical event payload; `payloadSignature` is its stable-key-order JSON serialization. */
export interface CalendarSyncEventPayload {
  summary: string;
  description: string;
  start: { dateTime: string };
  end: { dateTime: string };
  transparency: "opaque" | "transparent";
  reminders: { useDefault: boolean; overrides: never[] };
  extendedProperties: {
    private: {
      trackdidiaTaskId: string;
      trackdidiaOccurrence: string;
    };
  };
}

export interface CalendarSyncCreateAction {
  taskId: string;
  occurrenceKey: string;
  calendarId: string;
  payload: CalendarSyncEventPayload;
  payloadSignature: string;
  /** True when this create originates from a captured `pending` snapshot, not a live task. */
  fromPendingSnapshot: boolean;
}

export interface CalendarSyncUpdateAction {
  taskId: string;
  occurrenceKey: string;
  calendarId: string;
  eventId: string;
  payload: CalendarSyncEventPayload;
  payloadSignature: string;
}

export type CalendarSyncDeleteReason = "exit" | "reschedule" | "rescheduled_after_promotion";

export interface CalendarSyncDeleteAction {
  taskId: string;
  occurrenceKey: string;
  calendarId: string;
  /** `null` when the link never had an event (dropped without any remote call). */
  eventId: string | null;
  reason: CalendarSyncDeleteReason;
}

export interface CalendarSyncDetachAction {
  taskId: string;
  occurrenceKey: string;
  reason: CalendarSyncDetachReason;
}

/**
 * Links whose `generation` no longer matches the current settings generation. These
 * belong to a connection that no longer exists; they are dropped from storage without
 * any remote call (the old calendar is abandoned, not reachable through the current
 * connection). See "generation" in `specs/todo/calendar-sync.md`.
 */
export interface CalendarSyncPurgeAction {
  taskId: string;
  occurrenceKey: string;
}

export interface CalendarSyncAbort {
  reason: "empty_task_set" | "needs_confirmation";
  lastError: string;
  /** Present only when `reason === "needs_confirmation"`. */
  deleteCount?: number;
}

export interface CalendarSyncPlan {
  creates: CalendarSyncCreateAction[];
  updates: CalendarSyncUpdateAction[];
  deletes: CalendarSyncDeleteAction[];
  detaches: CalendarSyncDetachAction[];
  purges: CalendarSyncPurgeAction[];
  abort?: CalendarSyncAbort;
}
