import { createEmptyDailyEntry, updateNote } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { previewPayload, resolveProductivityPulse } from "./preview";
import type { DailySnapshot } from "./daily-snapshot";

describe("previewPayload", () => {
  it("renders the exact snapshot that would be sent for a given scope, from real repository data", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const date = "2026-02-01";
    let entry = createEmptyDailyEntry(date);
    entry = updateNote(entry, "morningIntention", "Texte libre du jour.");
    await repository.saveDailyEntry(entry);
    await repository.saveProject({
      id: "project:demo",
      title: "Projet demo",
      status: "active",
      statusChangedAt: new Date().toISOString(),
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const metricsSnapshot = await previewPayload(repository, "metrics", { date }) as DailySnapshot;
    const fullSnapshot = await previewPayload(repository, "full", { date }) as DailySnapshot;

    expect(metricsSnapshot.notes).toBeUndefined();
    expect(fullSnapshot.notes?.morningIntention).toBe("Texte libre du jour.");
    expect(metricsSnapshot.gtd.projectsWithoutNextAction).toBe(1);
    expect(metricsSnapshot.rescueTime.configured).toBe(false);
  });

  it("renders weekly preview snapshots", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekStart = "2026-08-02";
    await repository.saveDailyEntry(createEmptyDailyEntry(weekStart));

    const metricsSnapshot = await previewPayload(repository, "metrics", {
      surface: "weekly",
      date: weekStart
    });
    const fullSnapshot = await previewPayload(repository, "full", {
      surface: "weekly",
      date: weekStart
    });

    expect(metricsSnapshot.surface).toBe("weekly");
    expect(fullSnapshot.surface).toBe("weekly");
    expect(fullSnapshot.notes).toBeUndefined();
  });
});

describe("resolveProductivityPulse", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports unconfigured with no error when RescueTime has no API key", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const result = await resolveProductivityPulse(repository, "2026-02-01");

    expect(result.configured).toBe(false);
    expect(result.pulseWeekToDate).toBeNull();
    expect(result.fetchError).toBeUndefined();
  });

  it("surfaces fetchError (rather than pretending 'no data this week') when RescueTime is configured but the request fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({ ...(await repository.getSettings()), rescuetimeApiKey: "rt-test-key" });
    globalThis.fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;

    const result = await resolveProductivityPulse(repository, "2026-02-01");

    expect(result.configured).toBe(true);
    expect(result.pulseWeekToDate).toBeNull();
    expect(result.fetchError).toBeDefined();
    expect(result.fetchError).toContain("401");
  });
});
