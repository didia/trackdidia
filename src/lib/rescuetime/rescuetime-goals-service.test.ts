import { rescueTimeCredentialFingerprint } from "./credential-fingerprint";
import { MemoryRepository } from "../storage/memory-repository";
import type { RescueTimeGoalsClient } from "./goals-client";
import { RescueTimeGoalsService } from "./rescuetime-goals-service";

describe("RescueTimeGoalsService", () => {
  it("scores enabled RescueTime goals for a week", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => [
        {
          id: 1,
          display_name: "more than 2h on Personal (24x7)",
          amount_seconds: 7200,
          is_more: true,
          enabled: true,
          taxon_id: 15,
          taxonomy_name: "overview",
          schedule_name: "24x7",
          overview: { name: "Personal" },
        },
      ]),
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 12600, "Personal"]],
      })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeGoalsSnapshot("2026-08-02");

    expect(mockClient.listGoals).toHaveBeenCalledWith("rt-test-key");
    expect(snapshot.fetchError).toBeUndefined();
    expect(snapshot.score).toBe(0.25);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      title: "more than 2h on Personal (24x7)",
      achievement: 0.25,
    });
    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "overview",
        begin: "2026-08-02",
        end: "2026-08-08",
      }),
    );
  });

  it("scores overview goals even when RescueTime search_name is category", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => [
        {
          id: 1757767,
          display_name: "more than 50m on Personal (24x7)",
          amount_seconds: 3000,
          is_more: true,
          enabled: true,
          taxon_id: 15,
          taxon_display_name: "Personal",
          taxonomy_name: "overview",
          taxonomy: { search_name: "category" },
          schedule_name: "24x7",
          overview: { name: "Personal" },
        },
      ]),
      fetchAnalyticData: vi.fn(async (_apiKey, query) => {
        if (query.kind === "overview") {
          return {
            row_headers: ["Rank", "Time Spent (seconds)", "Category"],
            rows: [[1, 2466, "Personal"]],
          };
        }
        return {
          row_headers: ["Rank", "Time Spent (seconds)", "Category"],
          rows: [[1, 2124, "Planning"]],
        };
      }),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeGoalsSnapshot("2026-09-06");

    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({ kind: "overview" }),
    );
    expect(snapshot.items[0]?.actualHours).toBeCloseTo(2466 / 3600);
    expect(snapshot.items[0]?.actualHours).not.toBe(0);
  });

  it("computes productivity pulse for a week without schedule filter", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => []),
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Productivity"],
        rows: [
          [1, 3600, 2],
          [2, 3600, 0],
        ],
      })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeProductivityPulse("2026-08-02");

    expect(mockClient.fetchAnalyticData).toHaveBeenCalledWith(
      "rt-test-key",
      expect.objectContaining({
        kind: "productivity",
        begin: "2026-08-02",
        end: "2026-08-08",
        sourceType: "computers",
      }),
    );
    expect(snapshot.weekStartDate).toBe("2026-08-02");
    expect(snapshot.pulse).toBe(75);
    expect(snapshot.fetchError).toBeUndefined();
  });

  it("returns null pulse when RescueTime is not configured", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const service = new RescueTimeGoalsService(repository);
    const snapshot = await service.computeProductivityPulse("2026-08-02");

    expect(snapshot.rescuetimeConfigured).toBe(false);
    expect(snapshot.pulse).toBeNull();
  });

  it("scores project goals from reviewed timesheet time only", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const mockClient: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => [
        {
          id: 1961159,
          display_name: "more than 25m on Développement Plateforme Pigeons (Weekdays)",
          taxon_display_name: "Développement Plateforme Pigeons",
          amount_seconds: 1500,
          is_more: true,
          enabled: true,
          taxon_id: 27632,
          taxonomy_name: "projects",
          schedule_name: "Weekdays",
          v2project: { name: "Développement Plateforme Pigeons" },
        },
      ]),
      fetchAnalyticData: vi.fn(async () => ({ row_headers: [], rows: [] })),
      fetchProjectTimes: vi.fn(async () => ({
        project_times: [
          {
            duration: 45 * 60,
            extra: { draft: true },
            project: { name: "Développement Plateforme Pigeons" },
          },
          {
            duration: 65 * 60,
            extra: { comment: "" },
            project: { name: "Développement Plateforme Pigeons" },
          },
        ],
      })),
    };

    const service = new RescueTimeGoalsService(repository, mockClient);
    const snapshot = await service.computeGoalsSnapshot("2026-09-06");

    expect(snapshot.items[0]?.actualHours).toBeCloseTo(65 / 60);
    expect(snapshot.items[0]?.weeklyTargetHours).toBeCloseTo(2.08);
  });
});

describe("RescueTimeGoalsService snapshot cache", () => {
  const goal = {
    id: 1,
    display_name: "more than 2h on Personal (24x7)",
    amount_seconds: 7200,
    is_more: true,
    enabled: true,
    taxon_id: 15,
    taxonomy_name: "overview",
    schedule_name: "24x7",
    overview: { name: "Personal" },
  };

  const setup = async (overrides: Partial<RescueTimeGoalsClient> = {}, apiKey = "rt-key-a") => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: apiKey,
    });
    const client: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => [goal]),
      fetchAnalyticData: vi.fn(async () => ({
        row_headers: ["Rank", "Time Spent (seconds)", "Category"],
        rows: [[1, 12600, "Personal"]],
      })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
      ...overrides,
    };
    return { repository, client, service: new RescueTimeGoalsService(repository, client) };
  };
  const setKey = async (repository: MemoryRepository, key: string) =>
    repository.saveSettings({ ...(await repository.getSettings()), rescuetimeApiKey: key });

  it("writes the goals cache on success, including for an empty list", async () => {
    const { repository, service, client } = await setup();
    await service.computeGoalsSnapshot("2026-08-02");
    const fp = await rescueTimeCredentialFingerprint("rt-key-a");
    const entry = await repository.getRescueTimeSnapshotCache("2026-08-02", "goals", fp);
    expect(entry).not.toBeNull();
    expect(JSON.parse(entry!.payloadJson).items[0]).not.toHaveProperty("achievement");

    vi.mocked(client.listGoals).mockResolvedValue([]);
    await service.computeGoalsSnapshot("2026-08-02");
    const emptied = await repository.getRescueTimeSnapshotCache("2026-08-02", "goals", fp);
    expect(JSON.parse(emptied!.payloadJson).items).toEqual([]);
  });

  it("serves the cache with cachedAt and no fetchError when the pull fails", async () => {
    const { service, client } = await setup();
    await service.computeGoalsSnapshot("2026-08-02");
    vi.mocked(client.listGoals).mockRejectedValue(new Error("offline"));

    const snapshot = await service.computeGoalsSnapshot("2026-08-02");

    expect(snapshot.fetchError).toBeUndefined();
    expect(snapshot.cachedAt).toEqual(expect.any(String));
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].achievement).toBe(0.25);
    expect(snapshot.score).toBe(0.25);
  });

  it("keeps the fetchError behavior when there is no cache", async () => {
    const { service } = await setup({
      listGoals: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const snapshot = await service.computeGoalsSnapshot("2026-08-02");
    expect(snapshot.fetchError).toBe("offline");
    expect(snapshot.items).toEqual([]);
    expect(snapshot.cachedAt).toBeUndefined();
  });

  it("never reads the cache for an unconfigured key", async () => {
    const { repository, service } = await setup();
    await service.computeGoalsSnapshot("2026-08-02");
    await setKey(repository, "  ");
    const spy = vi.spyOn(repository, "getRescueTimeSnapshotCache");

    const snapshot = await service.computeGoalsSnapshot("2026-08-02", { maxAgeMs: 60_000 });

    expect(snapshot.rescuetimeConfigured).toBe(false);
    expect(snapshot.items).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never returns another key's entries after a key switch", async () => {
    const { repository, service, client } = await setup();
    await service.computeGoalsSnapshot("2026-08-02");
    await setKey(repository, "rt-key-b");
    vi.mocked(client.listGoals).mockRejectedValue(new Error("offline"));

    const snapshot = await service.computeGoalsSnapshot("2026-08-02");

    expect(snapshot.items).toEqual([]);
    expect(snapshot.fetchError).toBe("offline");
  });

  it("writes a late pull for key A under A's fingerprint, invisible to key B", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { repository, service, client } = await setup();
    vi.mocked(client.listGoals).mockImplementation(async () => {
      await gate;
      return [goal];
    });

    const pending = service.computeGoalsSnapshot("2026-08-02");
    await vi.waitFor(() => expect(client.listGoals).toHaveBeenCalled());
    await setKey(repository, "rt-key-b");
    release();
    await pending;

    const fpA = await rescueTimeCredentialFingerprint("rt-key-a");
    const fpB = await rescueTimeCredentialFingerprint("rt-key-b");
    expect(await repository.getRescueTimeSnapshotCache("2026-08-02", "goals", fpA)).not.toBeNull();
    expect(await repository.getRescueTimeSnapshotCache("2026-08-02", "goals", fpB)).toBeNull();
  });

  it("round-trips a null and a 0 pulse", async () => {
    const { service, client } = await setup();
    for (const pulse of [null, 0]) {
      vi.mocked(client.fetchAnalyticData).mockResolvedValueOnce({
        row_headers: [],
        rows: [],
      });
      const live = await service.computeProductivityPulse("2026-08-02");
      expect(live.fetchError).toBeUndefined();
      // Overwrite the cached value with the case under test, then fail the next pull.
      const repo = (service as unknown as { repository: MemoryRepository }).repository;
      const fp = await rescueTimeCredentialFingerprint("rt-key-a");
      await repo.saveRescueTimeSnapshotCache({
        weekStartDate: "2026-08-02",
        kind: "pulse",
        credentialFingerprint: fp,
        payloadJson: JSON.stringify({ pulse }),
        fetchedAt: "2026-08-05T10:00:00.000Z",
      });
      vi.mocked(client.fetchAnalyticData).mockRejectedValueOnce(new Error("offline"));

      const cached = await service.computeProductivityPulse("2026-08-02");

      expect(cached.pulse).toBe(pulse);
      expect(cached.cachedAt).toBe("2026-08-05T10:00:00.000Z");
      expect(cached.fetchError).toBeUndefined();
    }
  });

  describe("freshness window", () => {
    it("makes no client call for a fresh entry", async () => {
      const { service, client } = await setup();
      await service.computeGoalsSnapshot("2026-08-02");
      vi.mocked(client.listGoals).mockClear();

      const snapshot = await service.computeGoalsSnapshot("2026-08-02", { maxAgeMs: 60_000 });

      expect(client.listGoals).not.toHaveBeenCalled();
      expect(snapshot.cachedAt).toEqual(expect.any(String));
      expect(snapshot.items).toHaveLength(1);
    });

    it("pulls when the entry is stale", async () => {
      const { repository, service, client } = await setup();
      const fp = await rescueTimeCredentialFingerprint("rt-key-a");
      await repository.saveRescueTimeSnapshotCache({
        weekStartDate: "2026-08-02",
        kind: "goals",
        credentialFingerprint: fp,
        payloadJson: JSON.stringify({ items: [] }),
        fetchedAt: "2020-01-01T00:00:00.000Z",
      });

      const snapshot = await service.computeGoalsSnapshot("2026-08-02", { maxAgeMs: 60_000 });

      expect(client.listGoals).toHaveBeenCalled();
      expect(snapshot.cachedAt).toBeUndefined();
      expect(snapshot.items).toHaveLength(1);
    });

    it("pulls without the option even when the entry is fresh", async () => {
      const { service, client } = await setup();
      await service.computeGoalsSnapshot("2026-08-02");
      await service.computeGoalsSnapshot("2026-08-02");
      expect(client.listGoals).toHaveBeenCalledTimes(2);
    });

    it("never serves another fingerprint's entry", async () => {
      const { repository, service, client } = await setup();
      await service.computeGoalsSnapshot("2026-08-02");
      await setKey(repository, "rt-key-b");
      vi.mocked(client.listGoals).mockClear();

      await service.computeGoalsSnapshot("2026-08-02", { maxAgeMs: 60_000 });

      expect(client.listGoals).toHaveBeenCalled();
    });

    it("serves a fresh pulse without a client call", async () => {
      const { service, client } = await setup();
      await service.computeProductivityPulse("2026-08-02");
      vi.mocked(client.fetchAnalyticData).mockClear();

      const pulse = await service.computeProductivityPulse("2026-08-02", { maxAgeMs: 60_000 });

      expect(client.fetchAnalyticData).not.toHaveBeenCalled();
      expect(pulse.cachedAt).toEqual(expect.any(String));
    });
  });
});

describe("RescueTimeGoalsService key change during a pull", () => {
  const goal = {
    id: 1,
    display_name: "Goal A",
    amount_seconds: 7200,
    is_more: true,
    enabled: true,
    taxon_id: 15,
    taxonomy_name: "overview",
    schedule_name: "24x7",
    overview: { name: "Personal" },
  };

  const gated = async (nextKey: string) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "key-a",
    });
    let fail: (error: Error) => void = () => undefined;
    let gate: Promise<never> | null = null;
    const client: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => {
        if (gate) await gate;
        return [goal];
      }),
      fetchAnalyticData: vi.fn(async () => {
        if (gate) await gate;
        return {
          row_headers: ["Rank", "Time Spent (seconds)", "Category"],
          rows: [[1, 60, "Personal"]],
        };
      }),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };
    const service = new RescueTimeGoalsService(repository, client);
    await service.computeGoalsSnapshot("2026-08-02");
    await service.computeProductivityPulse("2026-08-02");
    gate = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    gate.catch(() => undefined);
    const switchAndFail = async () => {
      await repository.saveSettings({
        ...(await repository.getSettings()),
        rescuetimeApiKey: nextKey,
      });
      fail(new Error("offline"));
    };
    return { service, switchAndFail, client };
  };

  it.each([
    ["switched", "key-b"],
    ["cleared", ""],
  ])("does not serve key A's goals when the key is %s mid-pull", async (_label, nextKey) => {
    const { service, switchAndFail, client } = await gated(nextKey);
    const pending = service.computeGoalsSnapshot("2026-08-02");
    await vi.waitFor(() => expect(client.listGoals).toHaveBeenCalledTimes(2));
    await switchAndFail();

    const snapshot = await pending;

    expect(snapshot.items).toEqual([]);
    expect(snapshot.cachedAt).toBeUndefined();
    expect(snapshot.fetchError).toBe("offline");
  });

  it.each([
    ["switched", "key-b"],
    ["cleared", ""],
  ])("does not serve key A's pulse when the key is %s mid-pull", async (_label, nextKey) => {
    const { service, switchAndFail, client } = await gated(nextKey);
    const pending = service.computeProductivityPulse("2026-08-02");
    await vi.waitFor(() => expect(client.fetchAnalyticData).toHaveBeenCalledTimes(2));
    await switchAndFail();

    const pulse = await pending;

    expect(pulse.cachedAt).toBeUndefined();
    expect(pulse.fetchError).toBe("offline");
  });

  it("treats a future fetchedAt as stale and covers pulse freshness edge cases", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "key-a",
    });
    const client: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => []),
      fetchAnalyticData: vi.fn(async () => ({ row_headers: [], rows: [] })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };
    const service = new RescueTimeGoalsService(repository, client);
    const fpA = await rescueTimeCredentialFingerprint("key-a");
    const put = (fp: string, fetchedAt: string) =>
      repository.saveRescueTimeSnapshotCache({
        weekStartDate: "2026-08-02",
        kind: "pulse",
        credentialFingerprint: fp,
        payloadJson: JSON.stringify({ pulse: 0.5 }),
        fetchedAt,
      });

    await put(fpA, "2020-01-01T00:00:00.000Z");
    expect(
      (await service.computeProductivityPulse("2026-08-02", { maxAgeMs: 60_000 })).cachedAt,
    ).toBeUndefined();
    expect(client.fetchAnalyticData).toHaveBeenCalledTimes(1);

    await put(fpA, "2999-01-01T00:00:00.000Z");
    expect(
      (await service.computeProductivityPulse("2026-08-02", { maxAgeMs: 60_000 })).cachedAt,
    ).toBeUndefined();
    expect(client.fetchAnalyticData).toHaveBeenCalledTimes(2);

    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "key-b",
    });
    await put(fpA, new Date().toISOString());
    expect(
      (await service.computeProductivityPulse("2026-08-02", { maxAgeMs: 60_000 })).cachedAt,
    ).toBeUndefined();
    expect(client.fetchAnalyticData).toHaveBeenCalledTimes(3);
  });
});

describe("RescueTimeGoalsService key change during a cache read", () => {
  it.each([
    ["switched", "key-b"],
    ["cleared", ""],
  ])("drops the entry when the key is %s while the read is pending", async (_label, nextKey) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "key-a",
    });
    const client: RescueTimeGoalsClient = {
      listGoals: vi.fn(async () => []),
      fetchAnalyticData: vi.fn(async () => ({ row_headers: [], rows: [] })),
      fetchProjectTimes: vi.fn(async () => ({ project_times: [] })),
    };
    const service = new RescueTimeGoalsService(repository, client);
    await service.computeGoalsSnapshot("2026-08-02");

    const realRead = repository.getRescueTimeSnapshotCache.bind(repository);
    vi.spyOn(repository, "getRescueTimeSnapshotCache").mockImplementation(async (...args) => {
      const entry = await realRead(...args);
      await repository.saveSettings({
        ...(await repository.getSettings()),
        rescuetimeApiKey: nextKey,
      });
      return entry;
    });

    const fresh = await service.computeGoalsSnapshot("2026-08-02", { maxAgeMs: 3_600_000 });
    expect(fresh.cachedAt).toBeUndefined();
    expect(client.listGoals).toHaveBeenCalledTimes(2);
  });
});
