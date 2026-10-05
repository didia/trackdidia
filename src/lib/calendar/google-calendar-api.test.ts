import { describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "../email-triage/provider-http";
import type { CalendarSyncEventPayload } from "../../domain/calendar-sync";
import {
  CALENDAR_SYNC_LOOKUP_MAX_PAGES,
  GoogleCalendarApiClient,
  isCalendarSyncInvalidGrantError,
  isCalendarSyncNotFoundError,
  isCalendarSyncRateLimitError,
} from "./google-calendar-api";

const samplePayload: CalendarSyncEventPayload = {
  summary: "Task",
  description: "",
  start: { dateTime: "2024-01-05T09:00:00-05:00" },
  end: { dateTime: "2024-01-05T09:30:00-05:00" },
  transparency: "transparent",
  reminders: { useDefault: false, overrides: [] },
  extendedProperties: {
    private: { trackdidiaTaskId: "task-1", trackdidiaOccurrence: "2024-01-05" },
  },
};

const makeClient = (
  request: (input: { method: string; url: string }) => Promise<{
    status: number;
    body: string;
  }>,
) => new GoogleCalendarApiClient({ request }, async () => "access-token");

describe("GoogleCalendarApiClient.ensureCalendar", () => {
  it("creates only when absent", async () => {
    const request = vi.fn(async (_input: { method: string; url: string }) => ({
      status: 200,
      body: JSON.stringify({ id: "cal-new" }),
    }));
    const client = makeClient(request);

    const kept = await client.ensureCalendar({
      existingCalendarId: "cal-existing",
      summary: "TrackDidia",
    });
    expect(kept).toBe("cal-existing");
    expect(request).not.toHaveBeenCalled();

    const created = await client.ensureCalendar({
      existingCalendarId: null,
      summary: "TrackDidia",
    });
    expect(created).toBe("cal-new");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].method).toBe("POST");
    expect(request.mock.calls[0][0].url).toContain("/calendars");
  });
});

describe("GoogleCalendarApiClient.lookupEventsByOccurrence", () => {
  it("sends both privateExtendedProperty params and showDeleted=false", async () => {
    const request = vi.fn(async (_input: { url: string }) => ({
      status: 200,
      body: JSON.stringify({ items: [] }),
    }));
    const client = makeClient(request);
    await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");

    const calledUrl = new URL(request.mock.calls[0][0].url);
    expect(calledUrl.searchParams.getAll("privateExtendedProperty")).toEqual([
      "trackdidiaTaskId=task-1",
      "trackdidiaOccurrence=2024-01-05",
    ]);
    expect(calledUrl.searchParams.get("showDeleted")).toBe("false");
  });

  it("returns zero hits when the first page is empty with no nextPageToken", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ items: [] }) }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: true, hits: [] });
  });

  it("follows an empty first page that still carries a nextPageToken", async () => {
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { status: 200, body: JSON.stringify({ items: [], nextPageToken: "page-2" }) };
      }
      return { status: 200, body: JSON.stringify({ items: [{ id: "event-1" }] }) };
    });
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: true, hits: [{ id: "event-1" }] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("collects hits split across pages", async () => {
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          body: JSON.stringify({ items: [{ id: "event-2" }], nextPageToken: "p2" }),
        };
      }
      return { status: 200, body: JSON.stringify({ items: [{ id: "event-1" }] }) };
    });
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result.ok).toBe(true);
    expect(result.ok && result.hits.map((hit) => hit.id).sort()).toEqual(["event-1", "event-2"]);
  });

  it("reports a request failure distinctly, never falling through to zero hits", async () => {
    const request = vi.fn(async () => ({ status: 500, body: "boom" }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "request_failed" });
  });

  it("classifies a 404 on the lookup itself as calendar_not_found, never request_failed", async () => {
    const request = vi.fn(async () => ({ status: 404, body: "" }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "calendar_not_found" });
  });

  it("classifies a 410 on the lookup itself as calendar_not_found, never request_failed", async () => {
    const request = vi.fn(async () => ({ status: 410, body: "" }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "calendar_not_found" });
  });

  it("does not flatten a reconnect_required token-getter rejection into request_failed", async () => {
    const request = vi.fn(async () => ({ status: 200, body: JSON.stringify({ items: [] }) }));
    const client = new GoogleCalendarApiClient({ request }, async () => {
      throw new Error("reconnect_required");
    });
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(request).not.toHaveBeenCalled();
  });

  it("retries a rejected access token once without declaring the refresh grant dead", async () => {
    const request = vi.fn(async () => ({
      status: 401,
      body: JSON.stringify({ error: "invalid_grant" }),
    }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "request_failed" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports a thrown network error distinctly", async () => {
    const request = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "request_failed" });
  });

  it("reports the page cap when nextPageToken never stops", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ items: [], nextPageToken: "keep-going" }),
    }));
    const client = makeClient(request);
    const result = await client.lookupEventsByOccurrence("cal-1", "task-1", "2024-01-05");
    expect(result).toEqual({ ok: false, reason: "page_cap_reached" });
    expect(request).toHaveBeenCalledTimes(CALENDAR_SYNC_LOOKUP_MAX_PAGES);
  });
});

describe("GoogleCalendarApiClient.createOrAdoptEvent", () => {
  it("propagates reconnect_required distinctly from the lookup and never inserts", async () => {
    const request = vi.fn(async () => {
      throw new Error("must not call http when the token getter needs reconnect");
    });
    const client = new GoogleCalendarApiClient({ request }, async () => {
      throw new Error("reconnect_required");
    });
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "reconnect_required" });
    expect(request).not.toHaveBeenCalled();
  });

  it("inserts nothing and adopts the deterministic lowest id, deleting the rest", async () => {
    const deleted: string[] = [];
    const request = vi.fn(async ({ method, url }: { method: string; url: string }) => {
      if (method === "GET") {
        return { status: 200, body: JSON.stringify({ items: [{ id: "b" }, { id: "a" }] }) };
      }
      if (method === "DELETE") {
        deleted.push(url);
        return { status: 204, body: "" };
      }
      throw new Error(`unexpected POST on ${url}`);
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "adopted", eventId: "a", duplicateEventIdsDeleted: ["b"] });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("/events/b");
  });

  it.each([
    429, 403,
  ])("preserves a %s rate limit and never inserts after an incomplete scan", async (status) => {
    const request = vi.fn(async (_input: { method: string }) => ({
      status,
      body: JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
    }));
    const client = makeClient(request);
    expect(await client.lookupEventsByOccurrence("cal", "task", "date")).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(
      await client.createOrAdoptEvent({
        calendarId: "cal",
        taskId: "task",
        occurrenceKey: "date",
        payload: samplePayload,
      }),
    ).toEqual({ status: "rate_limited" });
    expect(request.mock.calls.every(([input]) => input.method === "GET")).toBe(true);
  });
  it("inserts nothing when the lookup fails", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "GET") {
        return { status: 500, body: "boom" };
      }
      throw new Error("must not insert after a failed lookup");
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("reports calendar_not_found distinctly and never inserts when the lookup 404s", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "GET") {
        return { status: 404, body: "" };
      }
      throw new Error("must not insert when the calendar itself is gone");
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "calendar_not_found" });
  });

  it("inserts when the lookup exhaustively finds zero hits", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "GET") {
        return { status: 200, body: JSON.stringify({ items: [] }) };
      }
      return { status: 200, body: JSON.stringify({ id: "new-event" }) };
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "inserted", eventId: "new-event" });
  });

  it("an empty first page with a nextPageToken followed by a page with a hit adopts and inserts nothing", async () => {
    let call = 0;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method !== "GET") {
        throw new Error("must not insert when a page returned a live event");
      }
      call += 1;
      if (call === 1) {
        return { status: 200, body: JSON.stringify({ items: [], nextPageToken: "p2" }) };
      }
      return { status: 200, body: JSON.stringify({ items: [{ id: "only-hit" }] }) };
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({
      status: "adopted",
      eventId: "only-hit",
      duplicateEventIdsDeleted: [],
    });
  });

  it("hits split across pages: one adopted, the rest deleted", async () => {
    let call = 0;
    const deleted: string[] = [];
    const request = vi.fn(async ({ method, url }: { method: string; url: string }) => {
      if (method === "GET") {
        call += 1;
        if (call === 1) {
          return {
            status: 200,
            body: JSON.stringify({ items: [{ id: "c" }], nextPageToken: "p2" }),
          };
        }
        return { status: 200, body: JSON.stringify({ items: [{ id: "a" }, { id: "b" }] }) };
      }
      if (method === "DELETE") {
        deleted.push(url);
        return { status: 204, body: "" };
      }
      throw new Error("must not insert when hits exist");
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result.status).toBe("adopted");
    expect(result.eventId).toBe("a");
    expect(deleted).toHaveLength(2);
  });

  it("does not insert when the page cap is reached", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "GET") {
        return { status: 200, body: JSON.stringify({ items: [], nextPageToken: "keep-going" }) };
      }
      throw new Error("must not insert after hitting the page cap");
    });
    const client = makeClient(request);
    const result = await client.createOrAdoptEvent({
      calendarId: "cal-1",
      taskId: "task-1",
      occurrenceKey: "2024-01-05",
      payload: samplePayload,
    });
    expect(result).toEqual({ status: "lookup_failed" });
    expect(request).toHaveBeenCalledTimes(CALENDAR_SYNC_LOOKUP_MAX_PAGES);
  });
});

describe("GoogleCalendarApiClient.deleteEvent", () => {
  it("treats 404/410 as success", async () => {
    const request = vi.fn(async () => ({ status: 404, body: "" }));
    const client = makeClient(request);
    await expect(client.deleteEvent("cal-1", "missing")).resolves.toBeUndefined();

    const request410 = vi.fn(async () => ({ status: 410, body: "" }));
    const client410 = makeClient(request410);
    await expect(client410.deleteEvent("cal-1", "gone")).resolves.toBeUndefined();
  });
});

describe("calendar sync error classification", () => {
  it("classifies 404/410 as not found", () => {
    expect(isCalendarSyncNotFoundError(new ProviderHttpError("x", 404, ""))).toBe(true);
    expect(isCalendarSyncNotFoundError(new ProviderHttpError("x", 410, ""))).toBe(true);
    expect(isCalendarSyncNotFoundError(new ProviderHttpError("x", 500, ""))).toBe(false);
  });

  it("classifies 429 and 403 rateLimitExceeded as rate-limited", () => {
    expect(isCalendarSyncRateLimitError(new ProviderHttpError("x", 429, ""))).toBe(true);
    expect(
      isCalendarSyncRateLimitError(
        new ProviderHttpError(
          "x",
          403,
          JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
        ),
      ),
    ).toBe(true);
    expect(isCalendarSyncRateLimitError(new ProviderHttpError("x", 403, "{}"))).toBe(false);
  });

  it("recognizes an invalid refresh grant without treating any 401 as revocation", () => {
    expect(
      isCalendarSyncInvalidGrantError(new ProviderHttpError("x", 401, "Invalid Credentials")),
    ).toBe(false);
    expect(
      isCalendarSyncInvalidGrantError(
        new ProviderHttpError("invalid_grant", 400, JSON.stringify({ error: "invalid_grant" })),
      ),
    ).toBe(true);
  });
});
