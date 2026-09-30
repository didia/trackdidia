import { rescueTimeCredentialFingerprint } from "./credential-fingerprint";
import { createEmptyWeeklyObjective } from "../../domain/weekly-objectives";
import { MemoryRepository } from "../storage/memory-repository";
import type { RescueTimeClient } from "./client";
import { WeeklyObjectivesService } from "./weekly-objectives-service";

describe("WeeklyObjectivesService", () => {
  it("computes a snapshot from repository data and a mocked RescueTime client", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const objective = await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Software Development",
        kind: "time",
        targetHours: 2,
        rescuetimeKind: "category",
        rescuetimeThing: "Software Development",
      }),
    );

    await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Budget review",
        kind: "manual",
      }),
    );

    const manual = (await repository.listWeeklyObjectives()).find((item) => item.kind === "manual");
    expect(manual).toBeDefined();
    await repository.saveWeeklyObjectiveResult({
      weekStartDate: "2026-08-02",
      objectiveId: manual!.id,
      achieved: false,
      updatedAt: "2026-08-09T12:00:00.000Z",
    });

    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeClient = {
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 3600, "Software Development"]],
      })),
    };

    const service = new WeeklyObjectivesService(repository, mockClient);
    const snapshot = await service.computeWeeklyObjectivesSnapshot("2026-08-02");

    expect(snapshot.score).toBe(0.25);
    expect(snapshot.items.find((item) => item.objective.id === objective.id)).toMatchObject({
      actualHours: 1,
      achievement: 0.5,
      source: "rescuetime",
    });

    await repository.saveWeeklyObjectiveResult({
      weekStartDate: "2026-08-02",
      objectiveId: manual!.id,
      achieved: true,
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    const afterDone = await service.computeWeeklyObjectivesSnapshot("2026-08-02");
    expect(afterDone.items.map((item) => item.objective.kind)).toEqual(["time"]);
    expect(afterDone.score).toBe(0.5);
    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "category",
        begin: "2026-08-02",
        end: "2026-08-08",
      }),
    );
  });

  it("does not call RescueTime for a time objective that has not started yet", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Future coding",
        kind: "time",
        targetHours: 2,
        rescuetimeKind: "category",
        rescuetimeThing: "Software Development",
        startsOnWeekStartDate: "2026-08-16",
      }),
    );
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeClient = {
      fetchAnalyticData: vi.fn(async () => {
        throw new Error("RescueTime should not be called");
      }),
    };

    const snapshot = await new WeeklyObjectivesService(
      repository,
      mockClient,
    ).computeWeeklyObjectivesSnapshot("2026-08-02");

    expect(mockClient.fetchAnalyticData).not.toHaveBeenCalled();
    expect(snapshot.fetchError).toBeUndefined();
    expect(snapshot.items).toEqual([]);
  });
});

describe("WeeklyObjectivesService snapshot cache", () => {
  const WEEK = "2026-08-02";

  const setup = async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const category = await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Dev",
        kind: "time",
        targetHours: 2,
        rescuetimeKind: "category",
        rescuetimeThing: "Software Development",
      }),
    );
    const activity = await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: "Mail",
        kind: "time",
        targetHours: 2,
        rescuetimeKind: "activity",
        rescuetimeThing: "Gmail",
      }),
    );
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-key-a",
    });
    let failActivity = false;
    let failCategory = false;
    const client: RescueTimeClient = {
      fetchAnalyticData: vi.fn(async (_key, query) => {
        if (query.kind === "activity") {
          if (failActivity) throw new Error("activity down");
          return {
            row_headers: ["Rank", "Time Spent (seconds)", "Activity"],
            rows: [[1, 1800, "Gmail"]],
          };
        }
        if (failCategory) throw new Error("category down");
        return {
          row_headers: ["Rank", "Time Spent (seconds)", "Category"],
          rows: [[1, 3600, "Software Development"]],
        };
      }),
    };
    return {
      repository,
      client,
      category,
      activity,
      service: new WeeklyObjectivesService(repository, client),
      setFailures: (next: { activity?: boolean; category?: boolean }) => {
        failActivity = next.activity ?? failActivity;
        failCategory = next.category ?? failCategory;
      },
    };
  };

  const readCache = async (repository: MemoryRepository) => {
    const fp = await rescueTimeCredentialFingerprint("rt-key-a");
    const entry = await repository.getRescueTimeSnapshotCache(WEEK, "objective_seconds", fp);
    return entry ? JSON.parse(entry.payloadJson) : null;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a failed kind group from the cache, leaves others untouched and never erases entries", async () => {
    const { service, setFailures, repository, category, activity } = await setup();
    await service.computeWeeklyObjectivesSnapshot(WEEK);
    setFailures({ activity: true });

    const snapshot = await service.computeWeeklyObjectivesSnapshot(WEEK);

    expect(snapshot.fetchError).toBeUndefined();
    expect(snapshot.cachedAt).toEqual(expect.any(String));
    expect(snapshot.items.find((item) => item.objective.id === category.id)).toMatchObject({
      actualHours: 1,
      source: "rescuetime",
    });
    expect(snapshot.items.find((item) => item.objective.id === activity.id)).toMatchObject({
      actualHours: 0.5,
      source: "rescuetime",
    });
    const cache = await readCache(repository);
    expect(Object.keys(cache).sort()).toEqual([activity.id, category.id].sort());
  });

  it("keeps per-value fetchedAt and dates cachedAt with the oldest reused value", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, setFailures, repository, category, activity } = await setup();

    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));
    await service.computeWeeklyObjectivesSnapshot(WEEK);

    setFailures({ activity: true });
    vi.setSystemTime(new Date("2026-08-05T10:00:00.000Z"));
    const midweek = await service.computeWeeklyObjectivesSnapshot(WEEK);
    expect(midweek.cachedAt).toBe("2026-08-03T10:00:00.000Z");

    vi.setSystemTime(new Date("2026-08-06T10:00:00.000Z"));
    const later = await service.computeWeeklyObjectivesSnapshot(WEEK);
    expect(later.cachedAt).toBe("2026-08-03T10:00:00.000Z");

    const cache = await readCache(repository);
    expect(cache[activity.id].fetchedAt).toBe("2026-08-03T10:00:00.000Z");
    expect(cache[category.id].fetchedAt).toBe("2026-08-06T10:00:00.000Z");
  });

  it("keeps fetchError when an objective has no cached value", async () => {
    const { service, setFailures } = await setup();
    setFailures({ activity: true });

    const snapshot = await service.computeWeeklyObjectivesSnapshot(WEEK);

    expect(snapshot.fetchError).toBe("activity down");
    expect(snapshot.cachedAt).toBeUndefined();
    expect(snapshot.items.find((item) => item.objective.title === "Mail")).toMatchObject({
      source: "missing",
      error: "activity down",
    });
  });

  describe("freshness window", () => {
    it("makes no client call when every active time objective has a fresh entry", async () => {
      const { service, client } = await setup();
      await service.computeWeeklyObjectivesSnapshot(WEEK);
      vi.mocked(client.fetchAnalyticData).mockClear();

      const snapshot = await service.computeWeeklyObjectivesSnapshot(WEEK, { maxAgeMs: 60_000 });

      expect(client.fetchAnalyticData).not.toHaveBeenCalled();
      expect(snapshot.cachedAt).toEqual(expect.any(String));
      expect(snapshot.items.map((item) => item.source)).toEqual(["rescuetime", "rescuetime"]);
    });

    it("still runs the live pull when only some objectives have a fresh entry", async () => {
      const { service, client, repository, category } = await setup();
      const fp = await rescueTimeCredentialFingerprint("rt-key-a");
      await repository.mergeRescueTimeObjectiveSecondsCache({
        weekStartDate: WEEK,
        credentialFingerprint: fp,
        values: { [category.id]: { seconds: 60, fetchedAt: new Date().toISOString() } },
        fetchedAt: new Date().toISOString(),
      });

      const snapshot = await service.computeWeeklyObjectivesSnapshot(WEEK, { maxAgeMs: 60_000 });

      expect(client.fetchAnalyticData).toHaveBeenCalled();
      expect(snapshot.cachedAt).toBeUndefined();
    });

    it("never reads the cache for an unconfigured key", async () => {
      const { service, client, repository } = await setup();
      await service.computeWeeklyObjectivesSnapshot(WEEK);
      await repository.saveSettings({ ...(await repository.getSettings()), rescuetimeApiKey: "" });
      const spy = vi.spyOn(repository, "getRescueTimeSnapshotCache");
      vi.mocked(client.fetchAnalyticData).mockClear();

      await service.computeWeeklyObjectivesSnapshot(WEEK, { maxAgeMs: 60_000 });

      expect(spy).not.toHaveBeenCalled();
      expect(client.fetchAnalyticData).not.toHaveBeenCalled();
    });
  });
});
