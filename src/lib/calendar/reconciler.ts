/**
 * Reconciler: the single entry point that plans (via `planCalendarSync`) and executes a
 * one-way TrackDidia -> Google Calendar sync run, persisting each link immediately after
 * its own call. See "Reconciler and triggers", "Safety valves" and "Event identity:
 * adopt-or-insert" in `specs/done/calendar-sync.md`.
 *
 * Logs (via callers) must carry counts, occurrence keys and event ids only, never titles
 * or tokens; this module never logs by itself.
 */
import type {
  CalendarSyncEventPayload,
  CalendarSyncLink,
  CalendarSyncSettings,
} from "../../domain/calendar-sync";
import { getTodayDate } from "../date";
import { nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import type { CreateOrAdoptEventResult } from "./google-calendar-api";
import {
  isCalendarSyncInvalidGrantError,
  isCalendarSyncNotFoundError,
  isCalendarSyncRateLimitError,
} from "./google-calendar-api";
import { runCalendarSyncMutation } from "./mutations";
import { planCalendarSync } from "./planner";
import { createCalendarSyncApiClient } from "./session";

export type CalendarSyncTrigger = "automatic" | "syncNow" | "confirmMassDelete";

/** Structural subset of `GoogleCalendarApiClient` the reconciler depends on; lets tests
 * inject a fake without stubbing the real HTTP-level client. */
export interface CalendarSyncApiClient {
  ensureCalendar(options: { existingCalendarId: string | null; summary: string }): Promise<string>;
  createOrAdoptEvent(options: {
    calendarId: string;
    taskId: string;
    occurrenceKey: string;
    payload: CalendarSyncEventPayload;
  }): Promise<CreateOrAdoptEventResult>;
  patchEvent(calendarId: string, eventId: string, payload: CalendarSyncEventPayload): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export interface CalendarSyncReconcileDeps {
  createApiClient?: (settings: CalendarSyncSettings) => CalendarSyncApiClient | null;
}

export interface CalendarSyncReconcileOutcome {
  ok: boolean;
  reason?: string;
}

export const CALENDAR_SYNC_MAX_ACTIONS_PER_RUN = 50;

/**
 * Global cooldown after a 403 `rateLimitExceeded`/429 response. Checked only for the
 * `automatic` trigger (timer/focus/nudges): a missed automatic run costs latency, never
 * correctness. `syncNow()`/`confirmMassDelete()` are explicit user actions and bypass the
 * cooldown so a manual retry is never silently swallowed.
 */
export const CALENDAR_SYNC_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;

/** Exponential backoff capped at 30 minutes; a link with no failures never backs off. */
export const calendarSyncBackoffDelayMs = (failureCount: number): number =>
  failureCount <= 0 ? 0 : Math.min(2 ** failureCount * 60_000, 30 * 60_000);

/** Extracts the delete count from `calendar_sync_mass_delete:<n>`, or `null` otherwise. */
export const parseCalendarSyncMassDeleteCount = (lastError: string | null): number | null => {
  if (!lastError) {
    return null;
  }
  const match = /^calendar_sync_mass_delete:(\d+)$/.exec(lastError);
  return match ? Number(match[1]) : null;
};

const isReconnectRequiredError = (error: unknown): boolean =>
  isCalendarSyncInvalidGrantError(error) ||
  (error instanceof Error && error.message === "reconnect_required");

const linkKey = (taskId: string, occurrenceKey: string): string =>
  `${taskId}\u0000${occurrenceKey}`;

const eventKey = (calendarId: string, eventId: string): string => `${calendarId}\u0000${eventId}`;

const shouldSkipForBackoff = (link: CalendarSyncLink | null, now: string): boolean => {
  if (!link || link.failureCount <= 0) {
    return false;
  }
  const delay = calendarSyncBackoffDelayMs(link.failureCount);
  const elapsed = new Date(now).getTime() - new Date(link.updatedAt).getTime();
  return elapsed < delay;
};

const resolveApiClient = (
  settings: CalendarSyncSettings,
  deps: CalendarSyncReconcileDeps,
): CalendarSyncApiClient | null => (deps.createApiClient ?? createCalendarSyncApiClient)(settings);

class CalendarSyncRunStopped extends Error {
  constructor(readonly reason: "disabled" | "gated") {
    super(reason);
  }
}

let inFlight: Promise<CalendarSyncReconcileOutcome> | null = null;
let rateLimitCooldownUntil = 0;

/** Test-only escape hatch: production code never needs to reset the module-level cooldown. */
export const resetCalendarSyncRateLimitCooldownForTests = (): void => {
  rateLimitCooldownUntil = 0;
};

/**
 * Single-flight: a reconcile call made while one is already running joins the running
 * promise instead of starting a second pass.
 */
export const reconcile = (
  repository: AppRepository,
  trigger: CalendarSyncTrigger,
  options: { confirmedMassDelete?: number } = {},
  deps: CalendarSyncReconcileDeps = {},
): Promise<CalendarSyncReconcileOutcome> => {
  if (inFlight) {
    return inFlight;
  }
  const run = runReconcile(repository, trigger, options, deps)
    .catch((error: unknown) => {
      if (error instanceof CalendarSyncRunStopped) {
        return { ok: false, reason: error.reason };
      }
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = run;
  return run;
};

export const syncNow = (
  repository: AppRepository,
  deps: CalendarSyncReconcileDeps = {},
): Promise<CalendarSyncReconcileOutcome> => reconcile(repository, "syncNow", {}, deps);

export const confirmMassDelete = (
  repository: AppRepository,
  confirmedMassDelete: number,
  deps: CalendarSyncReconcileDeps = {},
): Promise<CalendarSyncReconcileOutcome> =>
  reconcile(repository, "confirmMassDelete", { confirmedMassDelete }, deps);

async function runReconcile(
  repository: AppRepository,
  trigger: CalendarSyncTrigger,
  options: { confirmedMassDelete?: number },
  deps: CalendarSyncReconcileDeps,
  recoveryAttempted = false,
): Promise<CalendarSyncReconcileOutcome> {
  // Global rate-limit cooldown: automatic triggers only (see
  // `CALENDAR_SYNC_RATE_LIMIT_COOLDOWN_MS`); a manual syncNow/confirmMassDelete bypasses it.
  if (trigger === "automatic" && Date.now() < rateLimitCooldownUntil) {
    return { ok: false, reason: "rate_limited_cooldown" };
  }

  const settings = await repository.getCalendarSyncSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "disabled" };
  }

  // Gate table: see "Gate and resumption" in specs/done/calendar-sync.md.
  if (trigger === "automatic" && settings.state !== "active") {
    return { ok: false, reason: "gated" };
  }
  if (
    trigger === "syncNow" &&
    (settings.state === "reconnect_required" || settings.state === "disconnected")
  ) {
    return { ok: false, reason: "reconnect_required" };
  }
  if (trigger === "confirmMassDelete" && settings.state !== "needs_confirmation") {
    return { ok: false, reason: "gated" };
  }

  const api = resolveApiClient(settings, deps);
  if (!api) {
    return { ok: false, reason: "missing_client_id" };
  }

  // Never commit a run-start snapshot over a disconnect, preference save, or new
  // connection. Keep network waits outside this queue so disconnect can finish promptly.
  const withCurrentConnection = <T>(work: (current: CalendarSyncSettings) => Promise<T>) =>
    runCalendarSyncMutation(async () => {
      const current = await repository.getCalendarSyncSettings();
      if (!current.enabled || current.state === "disconnected") {
        throw new CalendarSyncRunStopped("disabled");
      }
      if (
        current.generation !== settings.generation ||
        current.connectedAccountId !== settings.connectedAccountId ||
        current.calendarId !== settings.calendarId ||
        current.oauthClientId !== settings.oauthClientId ||
        current.state !== settings.state
      ) {
        throw new CalendarSyncRunStopped("gated");
      }
      return work(current);
    });
  const checkConnection = () => withCurrentConnection(async () => undefined);

  const links = await repository.listCalendarSyncLinks();
  const tasks = await repository.listTasks({ includeCompleted: true });
  const today = getTodayDate();
  const now = nowIso();

  const plan = planCalendarSync({
    tasks,
    links,
    today,
    now,
    settings,
    confirmedMassDelete: trigger === "confirmMassDelete" ? options.confirmedMassDelete : undefined,
  });

  if (plan.abort) {
    const abort = plan.abort;
    await withCurrentConnection((current) =>
      repository.saveCalendarSyncSettings({
        ...current,
        state: abort.reason === "needs_confirmation" ? "needs_confirmation" : current.state,
        lastError: abort.lastError,
        lastSyncAt: now,
        updatedAt: now,
      }),
    );
    return { ok: false, reason: plan.abort.reason };
  }

  const linksByKey = new Map<string, CalendarSyncLink>(
    links.map((link) => [linkKey(link.taskId, link.occurrenceKey), link]),
  );
  const linksByEvent = new Map<string, CalendarSyncLink>(
    links
      .filter((link) => link.eventId !== null)
      .map((link) => [eventKey(link.calendarId, link.eventId as string), link] as const),
  );

  let actionsUsed = 0;
  let reconnectRequired = false;
  let rateLimited = false;
  let calendarRecovered: CalendarSyncReconcileOutcome | null = null;
  let lastError: string | null = null;

  const budgetExhausted = () => actionsUsed >= CALENDAR_SYNC_MAX_ACTIONS_PER_RUN;

  const recoverCalendar = async (): Promise<void> => {
    await checkConnection();
    const newCalendarId = await api.ensureCalendar({
      existingCalendarId: null,
      summary: settings.calendarSummary || "TrackDidia",
    });
    // The settings store clears old links atomically with the identity change. Do
    // not clear them before the remote call or commit its result after a disconnect.
    await withCurrentConnection((current) =>
      repository.saveCalendarSyncSettings({
        ...current,
        calendarId: newCalendarId,
        lastError: "calendar_sync_calendar_recreated",
        updatedAt: nowIso(),
      }),
    );
  };

  const recordFailure = async (input: {
    taskId: string;
    occurrenceKey: string;
    calendarId: string;
    eventId: string | null;
    payloadSignature: string;
    eventStartAt: string;
    message: string;
  }): Promise<void> => {
    const existing = linksByKey.get(linkKey(input.taskId, input.occurrenceKey)) ?? null;
    const failed: CalendarSyncLink = {
      taskId: input.taskId,
      occurrenceKey: input.occurrenceKey,
      calendarId: input.calendarId,
      eventId: existing?.eventId ?? input.eventId,
      generation: settings.generation,
      state: "failed",
      payloadSignature: input.payloadSignature,
      eventStartAt: input.eventStartAt,
      detachReason: null,
      failureCount: (existing?.failureCount ?? 0) + 1,
      lastError: input.message,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await withCurrentConnection(() => repository.saveCalendarSyncLink(failed));
      linksByKey.set(linkKey(input.taskId, input.occurrenceKey), failed);
    } catch (error) {
      if (error instanceof CalendarSyncRunStopped) throw error;
      // Persisting the failure record itself failed (e.g. a process crash between the
      // remote call and the link write). The next run's planner sees no link for this key
      // and simply retries from scratch; no duplicate event is created because the real
      // API client always adopts-or-inserts.
    }
    lastError = input.message;
  };

  for (const create of plan.creates) {
    await checkConnection();
    if (budgetExhausted()) {
      break;
    }
    const existing = linksByKey.get(linkKey(create.taskId, create.occurrenceKey)) ?? null;
    if (shouldSkipForBackoff(existing, now)) {
      continue;
    }
    actionsUsed += 1;
    try {
      const result = await api.createOrAdoptEvent({
        calendarId: create.calendarId,
        taskId: create.taskId,
        occurrenceKey: create.occurrenceKey,
        payload: create.payload,
      });
      if (result.status === "reconnect_required") {
        reconnectRequired = true;
        break;
      }
      if (result.status === "calendar_not_found") {
        if (recoveryAttempted) {
          // Already recreated the calendar once this run; a second 404 is a persistent
          // failure, not a one-off. Never loop: record it and keep going with the rest of
          // the plan under backoff.
          await recordFailure({
            taskId: create.taskId,
            occurrenceKey: create.occurrenceKey,
            calendarId: create.calendarId,
            eventId: null,
            payloadSignature: create.payloadSignature,
            eventStartAt: create.payload.start.dateTime,
            message: "calendar_sync_calendar_not_found",
          });
          continue;
        }
        await recoverCalendar();
        calendarRecovered = await runReconcile(repository, trigger, options, deps, true);
        break;
      }
      if (result.status === "rate_limited") {
        rateLimited = true;
        lastError = "calendar_sync_rate_limited";
        break;
      }
      if (result.status === "lookup_failed" || !result.eventId) {
        await recordFailure({
          taskId: create.taskId,
          occurrenceKey: create.occurrenceKey,
          calendarId: create.calendarId,
          eventId: null,
          payloadSignature: create.payloadSignature,
          eventStartAt: create.payload.start.dateTime,
          message: "calendar_sync_lookup_failed",
        });
        continue;
      }
      actionsUsed += result.duplicateEventIdsDeleted?.length ?? 0;
      const eventId = result.eventId;
      if (result.status === "adopted") {
        const owner = linksByEvent.get(eventKey(create.calendarId, eventId));
        if (
          owner &&
          (owner.taskId !== create.taskId || owner.occurrenceKey !== create.occurrenceKey)
        ) {
          await recordFailure({
            taskId: create.taskId,
            occurrenceKey: create.occurrenceKey,
            calendarId: create.calendarId,
            eventId: null,
            payloadSignature: create.payloadSignature,
            eventStartAt: create.payload.start.dateTime,
            message: `calendar_sync_event_already_linked:${eventId}`,
          });
          continue;
        }
      }
      const saved: CalendarSyncLink = {
        taskId: create.taskId,
        occurrenceKey: create.occurrenceKey,
        calendarId: create.calendarId,
        eventId,
        generation: settings.generation,
        state: create.fromPendingSnapshot ? "detached" : "synced",
        payloadSignature: create.payloadSignature,
        eventStartAt: create.payload.start.dateTime,
        detachReason: create.fromPendingSnapshot ? "promoted" : null,
        failureCount: 0,
        lastError: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await withCurrentConnection(() => repository.saveCalendarSyncLink(saved));
      linksByKey.set(linkKey(create.taskId, create.occurrenceKey), saved);
      linksByEvent.set(eventKey(create.calendarId, eventId), saved);
    } catch (error) {
      if (error instanceof CalendarSyncRunStopped) throw error;
      if (isReconnectRequiredError(error)) {
        reconnectRequired = true;
        break;
      }
      if (isCalendarSyncRateLimitError(error)) {
        rateLimited = true;
        lastError = "calendar_sync_rate_limited";
        break;
      }
      if (isCalendarSyncNotFoundError(error)) {
        if (recoveryAttempted) {
          await recordFailure({
            taskId: create.taskId,
            occurrenceKey: create.occurrenceKey,
            calendarId: create.calendarId,
            eventId: null,
            payloadSignature: create.payloadSignature,
            eventStartAt: create.payload.start.dateTime,
            message: "calendar_sync_calendar_not_found",
          });
          continue;
        }
        await recoverCalendar();
        calendarRecovered = await runReconcile(repository, trigger, options, deps, true);
        break;
      }
      await recordFailure({
        taskId: create.taskId,
        occurrenceKey: create.occurrenceKey,
        calendarId: create.calendarId,
        eventId: null,
        payloadSignature: create.payloadSignature,
        eventStartAt: create.payload.start.dateTime,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (calendarRecovered) {
    return calendarRecovered;
  }

  if (!reconnectRequired && !rateLimited) {
    for (const update of plan.updates) {
      await checkConnection();
      if (budgetExhausted()) {
        break;
      }
      const existing = linksByKey.get(linkKey(update.taskId, update.occurrenceKey)) ?? null;
      if (shouldSkipForBackoff(existing, now)) {
        continue;
      }
      actionsUsed += 1;
      try {
        await api.patchEvent(update.calendarId, update.eventId, update.payload);
        const saved: CalendarSyncLink = {
          taskId: update.taskId,
          occurrenceKey: update.occurrenceKey,
          calendarId: update.calendarId,
          eventId: update.eventId,
          generation: settings.generation,
          state: "synced",
          payloadSignature: update.payloadSignature,
          eventStartAt: update.payload.start.dateTime,
          detachReason: null,
          failureCount: 0,
          lastError: null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await withCurrentConnection(() => repository.saveCalendarSyncLink(saved));
        linksByKey.set(linkKey(update.taskId, update.occurrenceKey), saved);
      } catch (error) {
        if (error instanceof CalendarSyncRunStopped) throw error;
        if (isReconnectRequiredError(error)) {
          reconnectRequired = true;
          break;
        }
        if (isCalendarSyncRateLimitError(error)) {
          rateLimited = true;
          lastError = "calendar_sync_rate_limited";
          break;
        }
        if (isCalendarSyncNotFoundError(error)) {
          // The event itself is gone; do not recreate it (it may have been intentionally
          // removed on the calendar side, even though this sync is one-way).
          await withCurrentConnection(() =>
            repository.detachCalendarSyncLink(
              update.taskId,
              update.occurrenceKey,
              "missing_remote",
            ),
          );
          continue;
        }
        await recordFailure({
          taskId: update.taskId,
          occurrenceKey: update.occurrenceKey,
          calendarId: update.calendarId,
          eventId: update.eventId,
          payloadSignature: update.payloadSignature,
          eventStartAt: update.payload.start.dateTime,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (!reconnectRequired && !rateLimited) {
    for (const del of plan.deletes) {
      await checkConnection();
      if (budgetExhausted()) {
        break;
      }
      const existing = linksByKey.get(linkKey(del.taskId, del.occurrenceKey)) ?? null;
      if (del.eventId === null) {
        // The link never had an event; drop it locally without any remote call.
        await withCurrentConnection(() =>
          repository.deleteCalendarSyncLink(del.taskId, del.occurrenceKey),
        );
        linksByKey.delete(linkKey(del.taskId, del.occurrenceKey));
        continue;
      }
      if (shouldSkipForBackoff(existing, now)) {
        continue;
      }
      actionsUsed += 1;
      try {
        // A 404/410 is treated as success inside `deleteEvent`.
        await api.deleteEvent(del.calendarId, del.eventId);
        await withCurrentConnection(() =>
          repository.deleteCalendarSyncLink(del.taskId, del.occurrenceKey),
        );
        linksByKey.delete(linkKey(del.taskId, del.occurrenceKey));
      } catch (error) {
        if (error instanceof CalendarSyncRunStopped) throw error;
        if (isReconnectRequiredError(error)) {
          reconnectRequired = true;
          break;
        }
        if (isCalendarSyncRateLimitError(error)) {
          rateLimited = true;
          lastError = "calendar_sync_rate_limited";
          break;
        }
        await recordFailure({
          taskId: del.taskId,
          occurrenceKey: del.occurrenceKey,
          calendarId: del.calendarId,
          eventId: del.eventId,
          payloadSignature: existing?.payloadSignature ?? "",
          eventStartAt: existing?.eventStartAt ?? now,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (!reconnectRequired && !rateLimited) {
    for (const detach of plan.detaches) {
      await withCurrentConnection(() =>
        repository.detachCalendarSyncLink(detach.taskId, detach.occurrenceKey, detach.reason),
      );
    }
    for (const purge of plan.purges) {
      await withCurrentConnection(() =>
        repository.deleteCalendarSyncLink(purge.taskId, purge.occurrenceKey),
      );
    }
  }

  if (reconnectRequired) {
    await withCurrentConnection((current) =>
      repository.saveCalendarSyncSettings({
        ...current,
        state: "reconnect_required",
        lastError: "reconnect_required",
        lastSyncAt: now,
        updatedAt: now,
      }),
    );
    return { ok: false, reason: "reconnect_required" };
  }

  if (rateLimited) {
    // Global cooldown: automatic triggers no-op until it elapses (see the gate check at the
    // top of this function); a manual syncNow/confirmMassDelete bypasses it.
    rateLimitCooldownUntil = Date.now() + CALENDAR_SYNC_RATE_LIMIT_COOLDOWN_MS;
  }

  await withCurrentConnection((current) =>
    repository.saveCalendarSyncSettings({
      ...current,
      state: "active",
      lastError,
      lastSyncAt: now,
      updatedAt: now,
    }),
  );

  return { ok: lastError === null, reason: lastError ?? undefined };
}
