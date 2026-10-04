import { defaultAppSettings } from "../domain/settings";
import { buildContextId } from "../lib/gtd/shared";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { bootstrapApplication, runOnceWithSettingsMarker } from "./bootstrap";

const createRepository = async (
  patch: Partial<ReturnType<typeof defaultAppSettings>> = {},
): Promise<MemoryRepository> => {
  const repository = new MemoryRepository();
  await repository.initialize();
  await repository.saveSettings({ ...defaultAppSettings(), ...patch });
  return repository;
};

describe("runOnceWithSettingsMarker", () => {
  it("runs the work then stamps the marker", async () => {
    const repository = await createRepository();
    const work = vi.fn(async () => 7);

    const outcome = await runOnceWithSettingsMarker(
      repository,
      await repository.getSettings(),
      "gtdReferencesMigrationDoneAt",
      work,
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(outcome.ran).toBe(true);
    expect(outcome.result).toBe(7);
    expect(outcome.settings.gtdReferencesMigrationDoneAt).not.toBe("");
    expect((await repository.getSettings()).gtdReferencesMigrationDoneAt).toBe(
      outcome.settings.gtdReferencesMigrationDoneAt,
    );
  });

  it("skips the work and leaves settings untouched when the marker is set", async () => {
    const repository = await createRepository({
      gtdReferencesMigrationDoneAt: "2026-01-01T00:00:00.000Z",
    });
    const settings = await repository.getSettings();
    const update = vi.spyOn(repository, "updateSettings");
    const work = vi.fn(async () => 1);

    const outcome = await runOnceWithSettingsMarker(
      repository,
      settings,
      "gtdReferencesMigrationDoneAt",
      work,
    );

    expect(work).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ settings, ran: false, result: undefined });
  });

  it("does not stamp the marker when the work throws, so the step retries next boot", async () => {
    const repository = await createRepository();

    await expect(
      runOnceWithSettingsMarker(
        repository,
        await repository.getSettings(),
        "gtdScheduledNormalizationDoneAt",
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect((await repository.getSettings()).gtdScheduledNormalizationDoneAt).toBe("");
  });

  it("never overwrites a marker the work already stamped", async () => {
    const repository = await createRepository();

    const outcome = await runOnceWithSettingsMarker(
      repository,
      await repository.getSettings(),
      "aiMaxTokensUpgradeDoneAt",
      async () => {
        await repository.updateSettings((current) => ({
          ...current,
          aiMaxTokensUpgradeDoneAt: "2026-02-02T00:00:00.000Z",
        }));
      },
    );

    expect(outcome.settings.aiMaxTokensUpgradeDoneAt).toBe("2026-02-02T00:00:00.000Z");
  });
});

describe("bootstrapApplication", () => {
  it("runs steps in the contract order: settings, normalizations, recurrences, promotion, relationship", async () => {
    const repository = await createRepository();
    const calls: string[] = [];
    const track = <K extends keyof MemoryRepository>(name: K) => {
      const original = (repository[name] as (...args: unknown[]) => unknown).bind(repository);
      vi.spyOn(repository, name as never).mockImplementation(((...args: unknown[]) => {
        calls.push(String(name));
        return original(...args);
      }) as never);
    };
    track("getSettings");
    track("getGtdOverview");
    track("moveTasksWithContextToBucket");
    track("moveTasksWithScheduledDatesToBucket");
    track("generateDueRecurringTasks");
    track("promoteDueScheduledTasks");
    track("generateDailyRelationshipTasks");
    const stages: string[] = [];

    await bootstrapApplication(repository, { onStage: (stage) => stages.push(stage) });

    const firstIndex = (name: string) => calls.indexOf(name);
    expect(calls[0]).toBe("getSettings");
    expect(firstIndex("getSettings")).toBeLessThan(firstIndex("getGtdOverview"));
    expect(firstIndex("getGtdOverview")).toBeLessThan(firstIndex("moveTasksWithContextToBucket"));
    expect(firstIndex("moveTasksWithContextToBucket")).toBeLessThan(
      firstIndex("moveTasksWithScheduledDatesToBucket"),
    );
    expect(firstIndex("moveTasksWithScheduledDatesToBucket")).toBeLessThan(
      firstIndex("generateDueRecurringTasks"),
    );
    expect(firstIndex("generateDueRecurringTasks")).toBeLessThan(
      firstIndex("promoteDueScheduledTasks"),
    );
    expect(firstIndex("promoteDueScheduledTasks")).toBeLessThan(
      firstIndex("generateDailyRelationshipTasks"),
    );
    expect(stages).toHaveLength(6);
    expect(stages[0]).toBe("Chargement des paramètres");
    expect(stages.at(-1)).toBe("Finalisation du bootstrap");
  });

  it("applies the one-time normalizations and stamps their markers", async () => {
    const repository = await createRepository({ aiMaxTokens: 700 });
    const reading = buildContextId("Reading");
    const readingTask = await repository.createTask({
      title: "Livre",
      bucket: "next_action",
      contextIds: [reading],
    });
    const datedTask = await repository.createTask({
      title: "Plus tard",
      bucket: "next_action",
      scheduledFor: "2099-01-01",
    });

    const settings = await bootstrapApplication(repository);

    const tasks = await repository.listTasks();
    expect(tasks.find((task) => task.id === readingTask.id)?.bucket).toBe("reference");
    expect(tasks.find((task) => task.id === datedTask.id)?.bucket).toBe("scheduled");
    expect(settings.gtdReferencesMigrationDoneAt).not.toBe("");
    expect(settings.gtdScheduledNormalizationDoneAt).not.toBe("");
    expect(settings.aiMaxTokensUpgradeDoneAt).not.toBe("");
    expect(settings.aiMaxTokens).toBe(4_096);
  });

  it("is idempotent: a second boot skips every one-time step and keeps markers", async () => {
    const repository = await createRepository();
    const first = await bootstrapApplication(repository);

    const moveContext = vi.spyOn(repository, "moveTasksWithContextToBucket");
    const moveScheduled = vi.spyOn(repository, "moveTasksWithScheduledDatesToBucket");
    const stages: string[] = [];
    const second = await bootstrapApplication(repository, {
      onStage: (stage) => stages.push(stage),
    });

    expect(moveContext).not.toHaveBeenCalled();
    expect(moveScheduled).not.toHaveBeenCalled();
    expect(stages).not.toContain("Migration des références");
    expect(stages).not.toContain("Normalisation des tâches planifiées");
    expect(second.gtdReferencesMigrationDoneAt).toBe(first.gtdReferencesMigrationDoneAt);
    expect(second.gtdScheduledNormalizationDoneAt).toBe(first.gtdScheduledNormalizationDoneAt);
    expect(second.aiMaxTokensUpgradeDoneAt).toBe(first.aiMaxTokensUpgradeDoneAt);
  });

  it("still runs recurrence generation and promotion when markers are already set", async () => {
    const repository = await createRepository({
      aiMaxTokensUpgradeDoneAt: "2026-01-01T00:00:00.000Z",
      gtdReferencesMigrationDoneAt: "2026-01-01T00:00:00.000Z",
      gtdScheduledNormalizationDoneAt: "2026-01-01T00:00:00.000Z",
    });
    const recurrences = vi.spyOn(repository, "generateDueRecurringTasks");
    const promotion = vi.spyOn(repository, "promoteDueScheduledTasks");
    const relationship = vi.spyOn(repository, "generateDailyRelationshipTasks");

    await bootstrapApplication(repository);

    expect(recurrences).toHaveBeenCalledTimes(1);
    expect(promotion).toHaveBeenCalledTimes(1);
    expect(relationship).toHaveBeenCalledTimes(1);
  });

  it("seeds finance categories once when the flag is on", async () => {
    const repository = await createRepository({ financeEnabled: true });
    const seed = vi.spyOn(repository, "seedFinanceDefaultCategories");

    const first = await bootstrapApplication(repository);
    await bootstrapApplication(repository);

    expect(seed).toHaveBeenCalledTimes(1);
    expect(first.financeCategoriesSeededAt).not.toBe("");
  });

  it("does not seed finance categories while the flag is off", async () => {
    const repository = await createRepository({ financeEnabled: false });
    const seed = vi.spyOn(repository, "seedFinanceDefaultCategories");

    await bootstrapApplication(repository);

    expect(seed).not.toHaveBeenCalled();
  });

  it("swallows a finance seed failure and leaves the marker empty", async () => {
    const repository = await createRepository({ financeEnabled: true });
    vi.spyOn(repository, "seedFinanceDefaultCategories").mockRejectedValue(new Error("seed"));

    const settings = await bootstrapApplication(repository);

    expect(settings.financeCategoriesSeededAt).toBe("");
  });

  it("propagates a failing step so the caller can activate the fallback", async () => {
    const repository = await createRepository();
    vi.spyOn(repository, "generateDueRecurringTasks").mockRejectedValue(new Error("recurrences"));
    const promotion = vi.spyOn(repository, "promoteDueScheduledTasks");

    await expect(bootstrapApplication(repository)).rejects.toThrow("recurrences");
    expect(promotion).not.toHaveBeenCalled();
  });

  it("leaves the failed one-time step's marker empty so it retries on the next boot", async () => {
    const repository = await createRepository();
    vi.spyOn(repository, "moveTasksWithContextToBucket").mockRejectedValueOnce(new Error("move"));

    await expect(bootstrapApplication(repository)).rejects.toThrow("move");
    expect((await repository.getSettings()).gtdReferencesMigrationDoneAt).toBe("");

    const settings = await bootstrapApplication(repository);
    expect(settings.gtdReferencesMigrationDoneAt).not.toBe("");
  });
});
