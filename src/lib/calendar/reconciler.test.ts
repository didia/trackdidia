import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "../email-triage/provider-http";
import { MemoryRepository } from "../storage/memory-repository";
import { baseLink, baseTask } from "./calendar-sync-test-helpers";
import { disconnectCalendarSyncAccount } from "./connect";
import { saveCalendarSyncPreferences } from "./mutations";
import type { CreateOrAdoptEventResult } from "./google-calendar-api";
import type { CalendarSyncApiClient, CalendarSyncReconcileDeps } from "./reconciler";
import {
  calendarSyncBackoffDelayMs,
  CALENDAR_SYNC_RATE_LIMIT_COOLDOWN_MS,
  confirmMassDelete,
  parseCalendarSyncMassDeleteCount,
  reconcile,
  resetCalendarSyncRateLimitCooldownForTests,
  syncNow,
} from "./reconciler";

vi.mock("./vault", async () => ({
  ...(await vi.importActual<typeof import("./vault")>("./vault")),
  deleteCalendarVaultSecret: vi.fn(async () => undefined),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const connectedSettings = async (
  repository: MemoryRepository,
  overrides: Record<string, unknown> = {},
) => {
  const current = await repository.getCalendarSyncSettings();
  return repository.saveCalendarSyncSettings({
    ...current,
    enabled: true,
    oauthClientId: "client-id",
    connectedAccountId: "person@example.com",
    calendarId: "calendar-1",
    state: "active",
    ...overrides,
  });
};

const makeFakeApi = (overrides: Partial<CalendarSyncApiClient> = {}): CalendarSyncApiClient => ({
  ensureCalendar: vi.fn(async () => "calendar-recreated"),
  createOrAdoptEvent: vi.fn(async () => ({ status: "inserted" as const, eventId: "event-new" })),
  patchEvent: vi.fn(async () => undefined),
  deleteEvent: vi.fn(async () => undefined),
  ...overrides,
});

const depsFor = (api: CalendarSyncApiClient): CalendarSyncReconcileDeps => ({
  createApiClient: () => api,
});

const futureTask = (repository: MemoryRepository, overrides: Record<string, unknown> = {}) =>
  repository.createTask({
    title: "Task",
    bucket: "scheduled",
    scheduledFor: "2099-01-05T09:00:00",
    ...overrides,
  });

beforeEach(() => {
  vi.useRealTimers();
  resetCalendarSyncRateLimitCooldownForTests();
});

describe("reconcile — gate table", () => {
  it("automatic is a no-op while needs_confirmation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, {
      state: "needs_confirmation",
      lastError: "calendar_sync_mass_delete:5",
    });
    const api = makeFakeApi();
    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "gated" });
    expect(api.createOrAdoptEvent).not.toHaveBeenCalled();
  });

  it("automatic is a no-op while reconnect_required", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { state: "reconnect_required" });
    const api = makeFakeApi();
    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "gated" });
    expect(api.createOrAdoptEvent).not.toHaveBeenCalled();
  });

  it("syncNow fails fast to the reconnect prompt without calling the API", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { state: "reconnect_required" });
    const api = makeFakeApi();
    const result = await syncNow(repository, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(api.createOrAdoptEvent).not.toHaveBeenCalled();
  });

  it("confirmMassDelete is a no-op outside needs_confirmation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { state: "active" });
    const api = makeFakeApi();
    const result = await confirmMassDelete(repository, 5, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "gated" });
    expect(api.deleteEvent).not.toHaveBeenCalled();
  });

  it("syncNow re-plans while needs_confirmation and resumes active once the valve no longer trips", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, {
      state: "needs_confirmation",
      lastError: "calendar_sync_mass_delete:20",
    });
    const api = makeFakeApi();
    const result = await syncNow(repository, depsFor(api));
    expect(result.ok).toBe(true);
    const settings = await repository.getCalendarSyncSettings();
    expect(settings.state).toBe("active");
  });

  it("confirmMassDelete executes only when the recomputed count is <= n, and re-trips otherwise", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);

    // 11 synced links whose tasks are all cancelled: 11 deletes, exceeding max(10, 0) = 10.
    const tasks = [];
    for (let i = 0; i < 11; i += 1) {
      const scheduledFor = `2099-02-${String((i % 27) + 1).padStart(2, "0")}T09:00:00`;
      const task = await futureTask(repository, { id: `t${i}`, scheduledFor });
      tasks.push(task);
      await repository.saveCalendarSyncLink({
        taskId: task.id,
        occurrenceKey: scheduledFor.slice(0, 10),
        calendarId: "calendar-1",
        eventId: `event-${i}`,
        generation: 1,
        state: "synced",
        payloadSignature: "sig",
        eventStartAt: scheduledFor,
        detachReason: null,
        failureCount: 0,
        lastError: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await repository.cancelTask(task.id);
    }

    const api = makeFakeApi();
    const first = await syncNow(repository, depsFor(api));
    expect(first).toEqual({ ok: false, reason: "needs_confirmation" });
    const settingsAfterTrip = await repository.getCalendarSyncSettings();
    expect(settingsAfterTrip.state).toBe("needs_confirmation");
    const count = parseCalendarSyncMassDeleteCount(settingsAfterTrip.lastError);
    expect(count).toBe(11);
    expect(api.deleteEvent).not.toHaveBeenCalled();

    // Growing the delete set re-trips even with an override sized for the old count.
    const extra = await futureTask(repository, {
      id: "extra",
      scheduledFor: "2099-02-20T09:00:00",
    });
    await repository.saveCalendarSyncLink({
      taskId: extra.id,
      occurrenceKey: "2099-02-20",
      calendarId: "calendar-1",
      eventId: "event-extra",
      generation: 1,
      state: "synced",
      payloadSignature: "sig",
      eventStartAt: "2099-02-20T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.cancelTask(extra.id);
    const retrip = await confirmMassDelete(repository, 11, depsFor(api));
    expect(retrip).toEqual({ ok: false, reason: "needs_confirmation" });
    expect(api.deleteEvent).not.toHaveBeenCalled();
    const settingsAfterRetrip = await repository.getCalendarSyncSettings();
    expect(parseCalendarSyncMassDeleteCount(settingsAfterRetrip.lastError)).toBe(12);

    // Confirming with the recomputed count executes and returns to active.
    const confirmed = await confirmMassDelete(repository, 12, depsFor(api));
    expect(confirmed.ok).toBe(true);
    expect(api.deleteEvent).toHaveBeenCalledTimes(12);
    const settingsAfterConfirm = await repository.getCalendarSyncSettings();
    expect(settingsAfterConfirm.state).toBe("active");
  });
});

describe("reconcile — create, update, delete", () => {
  it("creates, then updates on a signature change, then deletes on removal, across separate runs", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    const task = await futureTask(repository, { title: "Original" });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "inserted" as const, eventId: "event-1" })),
    });
    const created = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(created.ok).toBe(true);
    expect(api.createOrAdoptEvent).toHaveBeenCalledTimes(1);

    let links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ state: "synced", eventId: "event-1" });

    await repository.saveTask({ ...task, title: "Edited" });
    const updated = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(updated.ok).toBe(true);
    expect(api.patchEvent).toHaveBeenCalledTimes(1);
    links = await repository.listCalendarSyncLinks();
    expect(links[0].state).toBe("synced");

    await repository.cancelTask(task.id);
    const deleted = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(deleted.ok).toBe(true);
    expect(api.deleteEvent).toHaveBeenCalledTimes(1);
    links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(0);
  });

  it("a crash between insert and the link write does not duplicate the event on retry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);

    // Simulate the process dying after the remote insert but before any link write lands:
    // every `saveCalendarSyncLink` call fails for the whole first run (including the
    // reconciler's own failure-record write), then recovers for the retry.
    let crashed = true;
    const originalSaveLink = repository.saveCalendarSyncLink.bind(repository);
    vi.spyOn(repository, "saveCalendarSyncLink").mockImplementation(async (link) => {
      if (crashed) {
        throw new Error("simulated crash before any link write");
      }
      return originalSaveLink(link);
    });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "inserted" as const, eventId: "event-1" })),
    });
    const first = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(first.ok).toBe(false);
    expect(await repository.listCalendarSyncLinks()).toHaveLength(0);

    // "Restart": link writes succeed again.
    crashed = false;

    // Retry: the real API adopts the already-created event instead of inserting a second one.
    const adoptingApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({
        status: "adopted" as const,
        eventId: "event-1",
        duplicateEventIdsDeleted: [],
      })),
    });
    const second = await reconcile(repository, "automatic", {}, depsFor(adoptingApi));
    expect(second.ok).toBe(true);
    const links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(1);
    expect(links[0].eventId).toBe("event-1");
  });

  it("createOrAdoptEvent returning status reconnect_required stops the run and sets reconnect_required", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository, { id: "a", scheduledFor: "2099-01-01T09:00:00" });
    await futureTask(repository, { id: "b", scheduledFor: "2099-01-02T09:00:00" });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "reconnect_required" as const })),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(api.createOrAdoptEvent).toHaveBeenCalledTimes(1);
    const settings = await repository.getCalendarSyncSettings();
    expect(settings.state).toBe("reconnect_required");
  });

  it("createOrAdoptEvent returning status lookup_failed records a failed link and never inserts", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    const task = await futureTask(repository);

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "lookup_failed" as const })),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(false);
    const link = await repository.getCalendarSyncLink(task.id, "2099-01-05");
    expect(link).toMatchObject({
      state: "failed",
      eventId: null,
      failureCount: 1,
      lastError: "calendar_sync_lookup_failed",
    });
  });

  it("a 404 from patchEvent detaches the link as missing_remote without recreating it", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    const task = await futureTask(repository, { title: "Original" });
    await repository.saveCalendarSyncLink({
      taskId: task.id,
      occurrenceKey: "2099-01-05",
      calendarId: "calendar-1",
      eventId: "event-1",
      generation: 1,
      state: "synced",
      payloadSignature: "stale-signature",
      eventStartAt: "2099-01-05T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.saveTask({ ...task, title: "Edited" });

    const api = makeFakeApi({
      patchEvent: vi.fn(async () => {
        throw new ProviderHttpError("calendar_sync_patch_event", 404, "");
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(true);
    const link = await repository.getCalendarSyncLink(task.id, "2099-01-05");
    expect(link).toMatchObject({ state: "detached", detachReason: "missing_remote" });
  });
});

describe("reconcile — concurrent connection changes", () => {
  it.each([
    "inserted",
    "reconnect_required",
    "calendar_not_found",
    "invalid_grant",
  ] as const)("preserves a disconnect while create completes with %s", async (status) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const original = await connectedSettings(repository);
    await futureTask(repository, { id: "first" });
    await futureTask(repository, { id: "second" });
    const started = deferred<void>();
    const response = deferred<CreateOrAdoptEventResult>();
    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(() => {
        started.resolve();
        return response.promise;
      }),
    });
    const running = syncNow(repository, depsFor(api));
    await started.promise;
    await disconnectCalendarSyncAccount(repository);
    const disconnected = await repository.getCalendarSyncSettings();
    if (status === "invalid_grant") {
      response.reject(new ProviderHttpError("invalid_grant", 400, '{"error":"invalid_grant"}'));
    } else {
      response.resolve(status === "inserted" ? { status, eventId: "event" } : { status });
    }
    expect(await running).toEqual({ ok: false, reason: "disabled" });
    expect(await repository.getCalendarSyncSettings()).toEqual(disconnected);
    expect(disconnected).toMatchObject({
      enabled: false,
      state: "disconnected",
      generation: original.generation,
    });
    expect(await repository.listCalendarSyncLinks()).toEqual([]);
    expect(api.ensureCalendar).not.toHaveBeenCalled();
    expect(api.createOrAdoptEvent).toHaveBeenCalledOnce();
  });

  it("preserves identity and links when disconnected during calendar recovery", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await connectedSettings(repository);
    const originalLink = baseLink(baseTask(), settings);
    await repository.saveCalendarSyncLink(originalLink);
    await futureTask(repository);
    const started = deferred<void>();
    const response = deferred<string>();
    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "calendar_not_found" as const })),
      ensureCalendar: vi.fn(() => {
        started.resolve();
        return response.promise;
      }),
    });
    const running = syncNow(repository, depsFor(api));
    await started.promise;
    await disconnectCalendarSyncAccount(repository);
    const disconnected = await repository.getCalendarSyncSettings();
    response.resolve("calendar-fresh");
    expect(await running).toEqual({ ok: false, reason: "disabled" });
    expect(await repository.getCalendarSyncSettings()).toEqual(disconnected);
    expect(disconnected).toMatchObject({ calendarId: "calendar-1", generation: 1 });
    expect(await repository.listCalendarSyncLinks()).toEqual([originalLink]);
    expect(api.createOrAdoptEvent).toHaveBeenCalledOnce();
  });

  it("preserves disabling preferences during a remote call", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);
    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => {
        await saveCalendarSyncPreferences(repository, {
          enabled: false,
          oauthClientId: "new-client",
        });
        return { status: "inserted" as const, eventId: "event" };
      }),
    });
    expect(await syncNow(repository, depsFor(api))).toEqual({ ok: false, reason: "disabled" });
    expect(await repository.getCalendarSyncSettings()).toMatchObject({
      enabled: false,
      oauthClientId: "new-client",
      lastSyncAt: null,
    });
    expect(await repository.listCalendarSyncLinks()).toEqual([]);
  });

  it("does not persist an old link or status over a replacement connection", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);
    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => {
        await connectedSettings(repository, {
          calendarId: "replacement",
          connectedAccountId: "other@example.com",
        });
        return { status: "inserted" as const, eventId: "event" };
      }),
    });
    expect(await syncNow(repository, depsFor(api))).toEqual({ ok: false, reason: "gated" });
    expect(await repository.getCalendarSyncSettings()).toMatchObject({
      calendarId: "replacement",
      connectedAccountId: "other@example.com",
      generation: 2,
      lastSyncAt: null,
    });
    expect(await repository.listCalendarSyncLinks()).toEqual([]);
  });

  it("does not overwrite a disconnect when the empty-task safety valve trips", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await connectedSettings(repository);
    const originalLink = baseLink(baseTask(), settings);
    await repository.saveCalendarSyncLink(originalLink);
    const originalList = repository.listTasks.bind(repository);
    vi.spyOn(repository, "listTasks").mockImplementation(async (options) => {
      await disconnectCalendarSyncAccount(repository);
      return originalList(options);
    });
    expect(await syncNow(repository, depsFor(makeFakeApi()))).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(await repository.listCalendarSyncLinks()).toEqual([originalLink]);
    expect(await repository.getCalendarSyncSettings()).toMatchObject({
      enabled: false,
      state: "disconnected",
      lastSyncAt: null,
      lastError: null,
    });
  });
});

describe("reconcile — rate-limit cooldown", () => {
  it("a returned lookup rate limit stops the pass and starts cooldown without link failures", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository, { id: "first" });
    await futureTask(repository, { id: "second" });
    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "rate_limited" as const })),
    });
    expect(await reconcile(repository, "automatic", {}, depsFor(api))).toEqual({
      ok: false,
      reason: "calendar_sync_rate_limited",
    });
    expect(api.createOrAdoptEvent).toHaveBeenCalledOnce();
    expect(await repository.listCalendarSyncLinks()).toEqual([]);
    expect(await repository.getCalendarSyncSettings()).toMatchObject({
      lastError: "calendar_sync_rate_limited",
    });
    expect(await reconcile(repository, "automatic", {}, depsFor(api))).toEqual({
      ok: false,
      reason: "rate_limited_cooldown",
    });
    expect(api.createOrAdoptEvent).toHaveBeenCalledOnce();
    const manualApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async ({ taskId }) => ({
        status: "inserted" as const,
        eventId: `event-${taskId}`,
      })),
    });
    expect((await syncNow(repository, depsFor(manualApi))).ok).toBe(true);
    expect(manualApi.createOrAdoptEvent).toHaveBeenCalledTimes(2);
  });

  it("global cooldown: an automatic trigger makes zero API calls until it elapses", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);

    const rateLimitedApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => {
        throw new ProviderHttpError("calendar_sync_insert_event", 429, "");
      }),
    });
    const first = await reconcile(repository, "automatic", {}, depsFor(rateLimitedApi));
    expect(first.ok).toBe(false);

    const duringCooldownApi = makeFakeApi();
    const second = await reconcile(repository, "automatic", {}, depsFor(duringCooldownApi));
    expect(second).toEqual({ ok: false, reason: "rate_limited_cooldown" });
    expect(duringCooldownApi.createOrAdoptEvent).not.toHaveBeenCalled();

    // syncNow bypasses the cooldown: it is an explicit user action.
    const manualApi = makeFakeApi();
    const manual = await syncNow(repository, depsFor(manualApi));
    expect(manual.ok).toBe(true);
    expect(manualApi.createOrAdoptEvent).toHaveBeenCalledTimes(1);

    // Fresh work for the automatic trigger to pick up once the cooldown elapses (the first
    // task is already synced from the manual sync above).
    await futureTask(repository, { id: "second", scheduledFor: "2099-02-02T09:00:00" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + CALENDAR_SYNC_RATE_LIMIT_COOLDOWN_MS + 1000));
    const afterCooldownApi = makeFakeApi();
    const third = await reconcile(repository, "automatic", {}, depsFor(afterCooldownApi));
    vi.useRealTimers();
    expect(third.ok).toBe(true);
    expect(afterCooldownApi.createOrAdoptEvent).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile — adopted event already linked elsewhere", () => {
  it("records a failed link with event_id null, continues the run, and later retries adopt once free", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository, { id: "owner", scheduledFor: "2099-03-01T09:00:00" });
    await repository.saveCalendarSyncLink({
      taskId: "owner",
      occurrenceKey: "2099-03-01",
      calendarId: "calendar-1",
      eventId: "shared-event",
      generation: 1,
      state: "synced",
      payloadSignature: "owner-signature",
      eventStartAt: "2099-03-01T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await futureTask(repository, { id: "claimant", scheduledFor: "2099-03-02T09:00:00" });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async ({ taskId }) => {
        if (taskId === "claimant") {
          return {
            status: "adopted" as const,
            eventId: "shared-event",
            duplicateEventIdsDeleted: [],
          };
        }
        return { status: "inserted" as const, eventId: `event-${taskId}` };
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(false);
    const links = await repository.listCalendarSyncLinks();
    const claimantLink = links.find((link) => link.taskId === "claimant");
    expect(claimantLink).toMatchObject({
      eventId: null,
      state: "failed",
      lastError: "calendar_sync_event_already_linked:shared-event",
    });

    // Free the event (the owner's task is cancelled, which deletes its link via the exit
    // rule) and retry after the backoff window.
    await repository.cancelTask("owner");
    await reconcile(repository, "automatic", {}, depsFor(makeFakeApi()));
    expect(await repository.getCalendarSyncLink("owner", "2099-03-01")).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + calendarSyncBackoffDelayMs(1) + 1000));
    const retryApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async ({ taskId }) => {
        if (taskId === "claimant") {
          return {
            status: "adopted" as const,
            eventId: "shared-event",
            duplicateEventIdsDeleted: [],
          };
        }
        return { status: "inserted" as const, eventId: `event-${taskId}` };
      }),
    });
    const retried = await reconcile(repository, "automatic", {}, depsFor(retryApi));
    vi.useRealTimers();
    expect(retried.ok).toBe(true);
    const retriedLinks = await repository.listCalendarSyncLinks();
    const claimantAfterRetry = retriedLinks.find((link) => link.taskId === "claimant");
    expect(claimantAfterRetry).toMatchObject({ state: "synced", eventId: "shared-event" });
  });
});

describe("reconcile — calendar recovery", () => {
  it("recreates the calendar, bumps generation, clears links and resyncs after a 404", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { calendarId: "calendar-gone" });
    await futureTask(repository);
    await repository.saveCalendarSyncLink({
      taskId: "stale",
      occurrenceKey: "2099-01-01",
      calendarId: "calendar-gone",
      eventId: "stale-event",
      generation: 1,
      state: "synced",
      payloadSignature: "stale-signature",
      eventStartAt: "2099-01-01T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    let calls = 0;
    const api = makeFakeApi({
      ensureCalendar: vi.fn(async () => "calendar-fresh"),
      createOrAdoptEvent: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderHttpError("calendar_sync_insert_event", 404, "");
        }
        return { status: "inserted" as const, eventId: "event-fresh" };
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(true);
    expect(api.ensureCalendar).toHaveBeenCalledTimes(1);

    const settings = await repository.getCalendarSyncSettings();
    expect(settings.calendarId).toBe("calendar-fresh");
    expect(settings.generation).toBe(2);

    const links = await repository.listCalendarSyncLinks();
    expect(links.find((link) => link.taskId === "stale")).toBeUndefined();
    expect(links.find((link) => link.calendarId === "calendar-fresh")).toBeDefined();
  });

  it("recovers from createOrAdoptEvent's returned calendar_not_found status (not a thrown error)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { calendarId: "calendar-gone" });
    await futureTask(repository);
    await repository.saveCalendarSyncLink({
      taskId: "stale",
      occurrenceKey: "2099-01-01",
      calendarId: "calendar-gone",
      eventId: "stale-event",
      generation: 1,
      state: "synced",
      payloadSignature: "stale-signature",
      eventStartAt: "2099-01-01T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    let calls = 0;
    const api = makeFakeApi({
      ensureCalendar: vi.fn(async () => "calendar-fresh"),
      createOrAdoptEvent: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return { status: "calendar_not_found" as const };
        }
        return { status: "inserted" as const, eventId: "event-fresh" };
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(true);
    expect(api.ensureCalendar).toHaveBeenCalledTimes(1);

    const settings = await repository.getCalendarSyncSettings();
    expect(settings.calendarId).toBe("calendar-fresh");
    expect(settings.generation).toBe(2);

    const links = await repository.listCalendarSyncLinks();
    expect(links.find((link) => link.taskId === "stale")).toBeUndefined();
    expect(links.find((link) => link.calendarId === "calendar-fresh")).toBeDefined();
  });

  it("never loops recovery: a persistent calendar_not_found after one recreation is recorded as a failure", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository, { calendarId: "calendar-gone" });
    const task = await futureTask(repository);

    const api = makeFakeApi({
      ensureCalendar: vi.fn(async () => "calendar-still-gone"),
      createOrAdoptEvent: vi.fn(async () => ({ status: "calendar_not_found" as const })),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(false);
    // Recreated exactly once, never again within the same run.
    expect(api.ensureCalendar).toHaveBeenCalledTimes(1);

    const link = await repository.getCalendarSyncLink(task.id, "2099-01-05");
    expect(link).toMatchObject({
      state: "failed",
      eventId: null,
      failureCount: 1,
      lastError: "calendar_sync_calendar_not_found",
    });
  });
});

describe("reconcile — invalid_grant", () => {
  it("transitions to reconnect_required and stops making further calls", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository, { id: "a", scheduledFor: "2099-01-01T09:00:00" });
    await futureTask(repository, { id: "b", scheduledFor: "2099-01-02T09:00:00" });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => {
        throw new ProviderHttpError(
          "invalid_grant",
          400,
          JSON.stringify({ error: "invalid_grant" }),
        );
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result).toEqual({ ok: false, reason: "reconnect_required" });
    expect(api.createOrAdoptEvent).toHaveBeenCalledTimes(1);
    const settings = await repository.getCalendarSyncSettings();
    expect(settings.state).toBe("reconnect_required");
  });
});

describe("reconcile — mid-run failure", () => {
  it("keeps earlier successfully-persisted links when a later action fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository, { id: "good", scheduledFor: "2099-01-01T09:00:00" });
    await futureTask(repository, { id: "bad", scheduledFor: "2099-01-02T09:00:00" });

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async ({ taskId }) => {
        if (taskId === "bad") {
          throw new Error("boom");
        }
        return { status: "inserted" as const, eventId: `event-${taskId}` };
      }),
    });

    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(false);
    const links = await repository.listCalendarSyncLinks();
    const good = links.find((link) => link.taskId === "good");
    const bad = links.find((link) => link.taskId === "bad");
    expect(good).toMatchObject({ state: "synced", eventId: "event-good" });
    expect(bad).toMatchObject({ state: "failed", eventId: null, failureCount: 1 });
  });
});

describe("reconcile — single-flight", () => {
  it("joins a concurrent call instead of running a second pass", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);

    let resolveCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const createOrAdoptEvent = vi.fn(async () => {
      await createGate;
      return { status: "inserted" as const, eventId: "event-1" };
    });
    const api = makeFakeApi({ createOrAdoptEvent });

    const firstCall = reconcile(repository, "automatic", {}, depsFor(api));
    const secondCall = reconcile(repository, "automatic", {}, depsFor(api));
    resolveCreate?.();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(first).toEqual(second);
    expect(createOrAdoptEvent).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile — batch cap", () => {
  it("processes at most 50 actions per run", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    for (let i = 0; i < 60; i += 1) {
      const day = String((i % 27) + 1).padStart(2, "0");
      await futureTask(repository, { id: `task-${i}`, scheduledFor: `2099-05-${day}T09:00:00` });
    }

    const api = makeFakeApi({
      createOrAdoptEvent: vi.fn(async ({ taskId }) => ({
        status: "inserted" as const,
        eventId: `event-${taskId}`,
      })),
    });

    await reconcile(repository, "automatic", {}, depsFor(api));
    expect(api.createOrAdoptEvent).toHaveBeenCalledTimes(50);
    const links = await repository.listCalendarSyncLinks();
    expect(links).toHaveLength(50);
  });
});

describe("reconcile — backoff", () => {
  it("does not immediately retry a link that just failed", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await connectedSettings(repository);
    await futureTask(repository);

    const failingApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => {
        throw new Error("transient");
      }),
    });
    await reconcile(repository, "automatic", {}, depsFor(failingApi));
    expect(failingApi.createOrAdoptEvent).toHaveBeenCalledTimes(1);

    const retryApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "inserted" as const, eventId: "event-1" })),
    });
    await reconcile(repository, "automatic", {}, depsFor(retryApi));
    expect(retryApi.createOrAdoptEvent).not.toHaveBeenCalled();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + calendarSyncBackoffDelayMs(1) + 1000));
    const afterBackoffApi = makeFakeApi({
      createOrAdoptEvent: vi.fn(async () => ({ status: "inserted" as const, eventId: "event-1" })),
    });
    await reconcile(repository, "automatic", {}, depsFor(afterBackoffApi));
    vi.useRealTimers();
    expect(afterBackoffApi.createOrAdoptEvent).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile — foreign-generation purge", () => {
  it("drops links from a foreign generation without any remote call", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = await connectedSettings(repository, { generation: 3 });
    // A benign eligible task keeps the plan from tripping the empty-task-set valve.
    await futureTask(repository);
    await repository.saveCalendarSyncLink({
      taskId: "old",
      occurrenceKey: "2099-01-01",
      calendarId: "calendar-old",
      eventId: "old-event",
      generation: 1,
      state: "synced",
      payloadSignature: "old-signature",
      eventStartAt: "2099-01-01T09:00:00",
      detachReason: null,
      failureCount: 0,
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(settings.generation).toBe(3);

    const api = makeFakeApi();
    const result = await reconcile(repository, "automatic", {}, depsFor(api));
    expect(result.ok).toBe(true);
    expect(api.deleteEvent).not.toHaveBeenCalled();
    const links = await repository.listCalendarSyncLinks();
    expect(links.find((link) => link.taskId === "old")).toBeUndefined();
  });
});
