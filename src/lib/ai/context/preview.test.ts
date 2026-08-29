import { createEmptyDailyEntry, updateNote } from "../../../domain/daily-entry";
import { MemoryRepository } from "../../storage/memory-repository";
import { previewPayload } from "./preview";

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

    const metricsSnapshot = await previewPayload(repository, "metrics", { date });
    const fullSnapshot = await previewPayload(repository, "full", { date });

    expect(metricsSnapshot.notes).toBeUndefined();
    expect(fullSnapshot.notes?.morningIntention).toBe("Texte libre du jour.");
    expect(metricsSnapshot.gtd.projectsWithoutNextAction).toBe(1);
    expect(metricsSnapshot.rescueTime.configured).toBe(false);
  });

  it("rejects an unsupported surface", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await expect(
      previewPayload(repository, "full", { surface: "weekly" as never })
    ).rejects.toThrow();
  });
});
