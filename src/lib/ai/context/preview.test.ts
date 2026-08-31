import { createEmptyDailyEntry, updateNote } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { RescueTimeGoalsService } from "../../rescuetime/rescuetime-goals-service";
import { previewPayload, resolveProductivityPulse } from "./preview";
import type { DailySnapshot } from "./daily-snapshot";
import type { MonthlySnapshot } from "./monthly-snapshot";
import type { WeeklySnapshot } from "./weekly-snapshot";

describe("previewPayload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    const fullSnapshot = (await previewPayload(repository, "full", {
      surface: "weekly",
      date: weekStart
    })) as import("./weekly-snapshot").WeeklySnapshot;

    expect(metricsSnapshot.surface).toBe("weekly");
    expect(fullSnapshot.surface).toBe("weekly");
    expect(fullSnapshot.notes).toBeUndefined();
  });

  it("includes RescueTime Goals score in weekly preview when configured", async () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: 0.75,
      totalAchievement: 0.75,
      items: [],
      rescuetimeConfigured: true
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: 80,
      rescuetimeConfigured: true
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-02"));

    const snapshot = (await previewPayload(repository, "full", {
      surface: "weekly",
      date: "2026-08-02"
    })) as WeeklySnapshot;

    expect(snapshot.weeklyScore).toBeGreaterThan(0);
    expect(snapshot.axes.some((axis) => axis.key === "rescueTimeGoalsScore")).toBe(true);
  });

  it("includes Goals score when weekly rescue time is injected like Settings preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-08-02"));

    const snapshot = (await previewPayload(repository, "full", {
      surface: "weekly",
      date: "2026-08-02",
      weeklyRescueTime: {
        configured: true,
        productivityPulse: 80,
        rescueTimeGoalsScore: 0.75
      }
    })) as WeeklySnapshot;

    expect(snapshot.axes.some((axis) => axis.key === "rescueTimeGoalsScore")).toBe(true);
    expect(snapshot.axes.some((axis) => axis.key === "productivityPulse")).toBe(true);
    expect(snapshot.weeklyScore).toBeGreaterThan(0);
  });

  it("renders monthly preview snapshots", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"));

    const snapshot = (await previewPayload(repository, "metrics", {
      surface: "monthly",
      date: "2026-04-01"
    })) as MonthlySnapshot;

    expect(snapshot.surface).toBe("monthly");
    expect(snapshot.monthKey).toBe("2026-04");
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
