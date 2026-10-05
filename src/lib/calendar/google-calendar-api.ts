/**
 * Google Calendar API v3 client. See "Event identity: adopt-or-insert" and "Event payload"
 * in `specs/done/calendar-sync.md`. Base URL is already in the Rust `ALLOWED_HOSTS` list
 * (`www.googleapis.com`), so no capability or CSP change is needed.
 *
 * The OAuth scope decided in the spec (`calendar.app.created`) cannot read the primary
 * calendar or the account's email, so the authorization URL also requests the minimal,
 * non-sensitive `email` scope; `getAccountProfile` resolves the connected account's email
 * from `https://www.googleapis.com/oauth2/v3/userinfo` (same host, no extra capability).
 */
import type { CalendarSyncEventPayload } from "../../domain/calendar-sync";
import { ProviderHttpError } from "../email-triage/provider-http";
import type { GmailHttpClient } from "../email-triage/provider-http";
import { assertHttpSuccess, parseJsonBody } from "../email-triage/provider-http";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Google may return an empty page that still carries a `nextPageToken`; exhaust it. */
export const CALENDAR_SYNC_LOOKUP_MAX_PAGES = 20;

export interface CalendarEventLookupHit {
  id: string;
}

export type CalendarEventLookupResult =
  | { ok: true; hits: CalendarEventLookupHit[] }
  | {
      ok: false;
      reason:
        | "request_failed"
        | "page_cap_reached"
        | "reconnect_required"
        | "calendar_not_found"
        | "rate_limited";
    };

export interface CreateOrAdoptEventResult {
  status:
    | "inserted"
    | "adopted"
    | "lookup_failed"
    | "reconnect_required"
    | "calendar_not_found"
    | "rate_limited";
  eventId?: string;
  /** Present only when `status === "adopted"`; every other hit was deleted in the same run. */
  duplicateEventIdsDeleted?: string[];
}

/**
 * `lookupEventsByOccurrence` must not flatten an authentication failure (the access-token
 * getter throwing `reconnect_required`, or the refresh endpoint rejecting the grant
 * with `invalid_grant`) into a generic `request_failed`: Phase 2's reconciler needs to tell "the
 * grant is dead, stop and ask the user to reconnect" apart from "transient failure, retry
 * later with backoff".
 */
const isReconnectRequiredError = (error: unknown): boolean =>
  (error instanceof Error && error.message === "reconnect_required") ||
  isCalendarSyncInvalidGrantError(error);

export interface CalendarAccountProfile {
  email: string;
}

export class GoogleCalendarApiClient {
  constructor(
    private readonly http: GmailHttpClient,
    private readonly getAccessToken: (forceRefresh?: boolean) => Promise<string>,
  ) {}

  private async authorizedRequest(
    method: string,
    url: string,
    options: { searchParams?: URLSearchParams; body?: unknown } = {},
  ) {
    const token = await this.getAccessToken();
    const target = new URL(url);
    if (options.searchParams) {
      for (const [key, value] of options.searchParams) {
        target.searchParams.append(key, value);
      }
    }
    const request = (accessToken: string) =>
      this.http.request({
        method,
        url: target.toString(),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    const response = await request(token);
    if (response.status !== 401) return response;
    // Rejected access tokens can still have a valid refresh grant. Retry exactly once.
    return request(await this.getAccessToken(true));
  }

  async getAccountProfile(): Promise<CalendarAccountProfile> {
    const response = await this.authorizedRequest("GET", USERINFO_URL);
    assertHttpSuccess(response, "calendar_sync_userinfo");
    const payload = parseJsonBody<{ email?: string }>(response);
    if (!payload.email) {
      throw new ProviderHttpError(
        "calendar_sync_userinfo_missing_email",
        response.status,
        response.body,
      );
    }
    return { email: payload.email.trim().toLowerCase() };
  }

  /** Creates the dedicated TrackDidia calendar only when `existingCalendarId` is absent. */
  async ensureCalendar(options: {
    existingCalendarId: string | null;
    summary: string;
  }): Promise<string> {
    if (options.existingCalendarId) {
      return options.existingCalendarId;
    }
    const response = await this.authorizedRequest("POST", `${CALENDAR_API_BASE}/calendars`, {
      body: { summary: options.summary },
    });
    assertHttpSuccess(response, "calendar_sync_ensure_calendar");
    const payload = parseJsonBody<{ id: string }>(response);
    return payload.id;
  }

  /**
   * Lookup for adopt-or-insert. Must exhaust pagination before deciding anything: an empty
   * page may still carry a `nextPageToken`. Follows it up to `CALENDAR_SYNC_LOOKUP_MAX_PAGES`
   * pages; a request failure or hitting the page cap is reported distinctly so the caller
   * never falls through to an insert on an incomplete scan. An authentication failure (the
   * access-token getter throwing `reconnect_required`, or the refresh endpoint returning
   * `invalid_grant`) is reported as its own `reconnect_required` reason, never flattened
   * into `request_failed`: Phase 2's reconciler needs to tell "retry later" apart from "the
   * grant is dead, stop and ask the user to reconnect". A 404/410 (the calendar itself no
   * longer exists; this endpoint has no event id to be 404 about) is reported as its own
   * `calendar_not_found` reason, never flattened into `request_failed`, so the reconciler
   * can trigger calendar recreation instead of a retryable backoff.
   */
  async lookupEventsByOccurrence(
    calendarId: string,
    taskId: string,
    occurrenceKey: string,
  ): Promise<CalendarEventLookupResult> {
    const hits: CalendarEventLookupHit[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < CALENDAR_SYNC_LOOKUP_MAX_PAGES; page += 1) {
      const searchParams = new URLSearchParams();
      searchParams.append("privateExtendedProperty", `trackdidiaTaskId=${taskId}`);
      searchParams.append("privateExtendedProperty", `trackdidiaOccurrence=${occurrenceKey}`);
      searchParams.append("showDeleted", "false");
      searchParams.append("maxResults", "250");
      if (pageToken) {
        searchParams.append("pageToken", pageToken);
      }
      let response: Awaited<ReturnType<GmailHttpClient["request"]>>;
      try {
        response = await this.authorizedRequest(
          "GET",
          `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
          { searchParams },
        );
      } catch (error) {
        if (isReconnectRequiredError(error)) {
          return { ok: false, reason: "reconnect_required" };
        }
        if (isCalendarSyncNotFoundError(error)) {
          return { ok: false, reason: "calendar_not_found" };
        }
        if (isCalendarSyncRateLimitError(error)) {
          return { ok: false, reason: "rate_limited" };
        }
        return { ok: false, reason: "request_failed" };
      }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 404 || response.status === 410) {
          return { ok: false, reason: "calendar_not_found" };
        }
        if (
          isCalendarSyncRateLimitError(
            new ProviderHttpError("calendar_sync_lookup_failed", response.status, response.body),
          )
        ) {
          return { ok: false, reason: "rate_limited" };
        }
        return { ok: false, reason: "request_failed" };
      }
      const payload = parseJsonBody<{ items?: Array<{ id: string }>; nextPageToken?: string }>(
        response,
      );
      for (const item of payload.items ?? []) {
        hits.push({ id: item.id });
      }
      if (!payload.nextPageToken) {
        return { ok: true, hits };
      }
      pageToken = payload.nextPageToken;
    }
    return { ok: false, reason: "page_cap_reached" };
  }

  /** Compensates only for a calendar created by an unsuccessful connection attempt. */
  async deleteCalendar(calendarId: string): Promise<void> {
    const response = await this.authorizedRequest(
      "DELETE",
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}`,
    );
    if (response.status === 404 || response.status === 410) return;
    assertHttpSuccess(response, "calendar_sync_delete_calendar");
  }

  async insertEvent(calendarId: string, payload: CalendarSyncEventPayload): Promise<string> {
    const response = await this.authorizedRequest(
      "POST",
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      { body: payload },
    );
    assertHttpSuccess(response, "calendar_sync_insert_event");
    return parseJsonBody<{ id: string }>(response).id;
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    payload: CalendarSyncEventPayload,
  ): Promise<void> {
    const response = await this.authorizedRequest(
      "PATCH",
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { body: payload },
    );
    assertHttpSuccess(response, "calendar_sync_patch_event");
  }

  /** A 404/410 on delete is treated as success: the event is already gone. */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const response = await this.authorizedRequest(
      "DELETE",
      `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    if (response.status === 404 || response.status === 410) {
      return;
    }
    assertHttpSuccess(response, "calendar_sync_delete_event");
  }

  /**
   * Adopt-or-insert: looks up existing events for `(taskId, occurrenceKey)`, adopting the
   * deterministic lowest id when any are found (deleting every other hit as a duplicate),
   * and inserting only when the lookup exhaustively finds zero hits. Never inserts after a
   * failed, capped or auth-dead (`reconnect_required`) lookup; the latter is reported as a
   * distinct `status` so Phase 2's reconciler can stop and surface `reconnect_required`
   * instead of retrying with backoff.
   */
  async createOrAdoptEvent(options: {
    calendarId: string;
    taskId: string;
    occurrenceKey: string;
    payload: CalendarSyncEventPayload;
  }): Promise<CreateOrAdoptEventResult> {
    const lookup = await this.lookupEventsByOccurrence(
      options.calendarId,
      options.taskId,
      options.occurrenceKey,
    );
    if (!lookup.ok) {
      if (
        lookup.reason === "reconnect_required" ||
        lookup.reason === "calendar_not_found" ||
        lookup.reason === "rate_limited"
      ) {
        return { status: lookup.reason };
      }
      return { status: "lookup_failed" };
    }
    if (lookup.hits.length === 0) {
      const eventId = await this.insertEvent(options.calendarId, options.payload);
      return { status: "inserted", eventId };
    }
    const sorted = [...lookup.hits].sort((a, b) => a.id.localeCompare(b.id));
    const [adopted, ...duplicates] = sorted;
    for (const duplicate of duplicates) {
      await this.deleteEvent(options.calendarId, duplicate.id);
    }
    return {
      status: "adopted",
      eventId: adopted.id,
      duplicateEventIdsDeleted: duplicates.map((duplicate) => duplicate.id),
    };
  }
}

export const isCalendarSyncNotFoundError = (error: unknown): boolean =>
  error instanceof ProviderHttpError && (error.status === 404 || error.status === 410);

export const isCalendarSyncRateLimitError = (error: unknown): boolean => {
  if (!(error instanceof ProviderHttpError)) {
    return false;
  }
  if (error.status === 429) {
    return true;
  }
  return error.status === 403 && error.body.includes("rateLimitExceeded");
};

export const isCalendarSyncInvalidGrantError = (error: unknown): boolean =>
  error instanceof ProviderHttpError && error.body.includes("invalid_grant");
